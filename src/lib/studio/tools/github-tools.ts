// ============================================================
// TOOLS / GITHUB — Integração via REST API
// get_repository, get_file, create_branch, create_pull_request
// Token: SOMENTE via env GITHUB_TOKEN (server-side).
// NUNCA exposto ao frontend; NUNCA logado.
// ============================================================

import { STUDIO_CONFIG } from '../config'
import { emitEvent } from '../events/bus'
import type { ToolDefinition, ToolResult } from './types'

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'ai-development-studio',
    'x-github-api-version': '2022-11-28',
  }
  if (STUDIO_CONFIG.github.token) h.authorization = `Bearer ${STUDIO_CONFIG.github.token}`
  return h
}

function tokenConfigured(): boolean {
  return Boolean(STUDIO_CONFIG.github.token)
}

/** Parse "owner/repo" ou URL GitHub. */
export function parseRepoRef(ref: string): { owner: string; repo: string } {
  const cleaned = String(ref).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '')
  const parts = cleaned.split('/')
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`REPO_INVÁLIDO: "${ref}" — use "owner/repo" ou URL do GitHub`)
  }
  return { owner: parts[0], repo: parts[1] }
}

async function gh(pathSuffix: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${STUDIO_CONFIG.github.apiBase}${pathSuffix}`, {
    ...init,
    headers: { ...githubHeaders(), ...(init?.headers as Record<string, string>) },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text.slice(0, 2000) }
  }
  return { ok: res.ok, status: res.status, data }
}

export const getRepositoryTool: ToolDefinition = {
  name: 'get_repository',
  description: 'Obtém metadados de um repositório GitHub (branch default, tamanho, linguagem, permissões).',
  category: 'github',
  permissions: ['github:read'],
  params: [{ name: 'repo', type: 'string', required: true, description: 'owner/repo ou URL' }],
  async execute(args): Promise<ToolResult> {
    const { owner, repo } = parseRepoRef(String(args.repo))
    const res = await gh(`/repos/${owner}/${repo}`)
    if (!res.ok) {
      return { ok: false, output: `GITHUB_ERRO ${res.status}: verificar repo/acesso token` }
    }
    const d = res.data as Record<string, unknown>
    return {
      ok: true,
      output: `REPO: ${owner}/${repo}\nbranch_default: ${d.default_branch}\nlinguagem: ${d.language}\nprivado: ${d.private}\ntamanho: ${Number(d.size ?? 0) / 1024 | 0}MB\npermissões: ${JSON.stringify(d.permissions ?? {})}`,
    }
  },
}

export const getGithubFileTool: ToolDefinition = {
  name: 'get_file',
  description: 'Lê um arquivo de um repositório GitHub (via contents API).',
  category: 'github',
  permissions: ['github:read'],
  params: [
    { name: 'repo', type: 'string', required: true, description: 'owner/repo' },
    { name: 'path', type: 'string', required: true, description: 'Caminho do arquivo no repo' },
    { name: 'branch', type: 'string', required: false, description: 'Branch (padrão: default)' },
  ],
  async execute(args): Promise<ToolResult> {
    const { owner, repo } = parseRepoRef(String(args.repo))
    const filePath = String(args.path)
    const q = args.branch ? `?ref=${encodeURIComponent(String(args.branch))}` : ''
    const res = await gh(`/repos/${owner}/${repo}/contents/${filePath}${q}`)
    if (!res.ok) return { ok: false, output: `GITHUB_ERRO ${res.status} ao ler ${filePath}` }
    const d = res.data as { content?: string; encoding?: string; size?: number }
    if (d.encoding === 'base64' && d.content) {
      const decoded = Buffer.from(d.content, 'base64').toString('utf8')
      return {
        ok: true,
        output: decoded.length > 6000 ? decoded.slice(0, 6000) + '\n...[TRUNCADO]' : decoded,
      }
    }
    return { ok: false, output: `ARQUIVO_BINARIO ou vazio (${d.size}B)` }
  },
}

export const createGithubBranchTool: ToolDefinition = {
  name: 'github_create_branch',
  description: 'Cria branch remota no GitHub (via API, a partir do SHA da branch base).',
  category: 'github',
  permissions: ['github:write'],
  params: [
    { name: 'repo', type: 'string', required: true, description: 'owner/repo' },
    { name: 'branch', type: 'string', required: true, description: 'Nome da nova branch' },
    { name: 'from', type: 'string', required: false, description: 'Branch base (padrão: default)' },
  ],
  async execute(args, ctx): Promise<ToolResult> {
    if (!tokenConfigured()) return { ok: false, output: 'GITHUB_TOKEN_NAO_CONFIGURADO: defina GITHUB_TOKEN no .env (server-side)' }
    const { owner, repo } = parseRepoRef(String(args.repo))
    let branchName = String(args.branch).trim().replace(/[^\w./-]/g, '-')
    if (!branchName.startsWith('agent/')) branchName = `agent/${branchName}`

    const base = await gh(`/repos/${owner}/${repo}`)
    if (!base.ok) return { ok: false, output: `GITHUB_ERRO ${base.status} ao obter repo` }
    const defaultBranch = String(args.from ?? (base.data as Record<string, unknown>).default_branch)
    const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`)
    if (!ref.ok) return { ok: false, output: `GITHUB_ERRO ${ref.status} ao obter SHA de ${defaultBranch}` }
    const sha = (ref.data as { object?: { sha?: string } }).object?.sha
    if (!sha) return { ok: false, output: 'SHA_NAO_ENCONTRADO' }

    const create = await gh(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
    })
    if (!create.ok) {
      const msg = (create.data as Record<string, string>).message ?? ''
      if (msg.includes('Reference already exists')) return { ok: true, output: `BRANCH_JA_EXISTE: ${branchName}` }
      return { ok: false, output: `GITHUB_ERRO ${create.status}: ${msg}` }
    }
    await emitEvent({
      type: 'github.branch.created',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      message: `Branch remota criada: ${branchName}`,
      data: { branch: branchName, repo: `${owner}/${repo}` },
    })
    return { ok: true, output: `BRANCH_REMOTA_CRIADA: ${branchName} (de ${defaultBranch})` }
  },
}

export const createPullRequestTool: ToolDefinition = {
  name: 'create_pull_request',
  description: 'Cria Pull Request no GitHub da branch agent/* para a branch main.',
  category: 'github',
  permissions: ['github:write'],
  params: [
    { name: 'repo', type: 'string', required: true, description: 'owner/repo' },
    { name: 'title', type: 'string', required: true, description: 'Título do PR' },
    { name: 'body', type: 'string', required: false, description: 'Descrição do PR' },
    { name: 'head', type: 'string', required: false, description: 'Branch de origem (agent/*)' },
    { name: 'base', type: 'string', required: false, description: 'Branch destino (padrão main)' },
  ],
  async execute(args, ctx): Promise<ToolResult> {
    if (!tokenConfigured()) return { ok: false, output: 'GITHUB_TOKEN_NAO_CONFIGURADO: defina GITHUB_TOKEN no .env (server-side)' }
    const { owner, repo } = parseRepoRef(String(args.repo))
    const res = await gh(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: String(args.title).slice(0, 200),
        body: String(args.body ?? 'Criado pelo AI Development Studio'),
        head: String(args.head ?? 'agent/current'),
        base: String(args.base ?? 'main'),
      }),
    })
    if (!res.ok) {
      const msg = (res.data as Record<string, string>).message ?? ''
      return { ok: false, output: `PR_ERRO ${res.status}: ${msg}` }
    }
    const d = res.data as Record<string, unknown>
    const url = String(d.html_url ?? '')
    await emitEvent({
      type: 'github.pr.created',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      message: `Pull Request criado: ${url}`,
      data: { url, number: d.number },
    })
    return { ok: true, output: `PR_CRIADO: ${url}` }
  },
}

export const GITHUB_TOOLS: ToolDefinition[] = [
  getRepositoryTool,
  getGithubFileTool,
  createGithubBranchTool,
  createPullRequestTool,
]

/** Estado da integração para a UI (sem expor token). */
export function githubStatus() {
  return {
    tokenConfigured,
    apiBase: STUDIO_CONFIG.github.apiBase,
    tokenLast4: tokenConfigured() ? STUDIO_CONFIG.github.token.slice(-4) : null,
    defaultBranch: STUDIO_CONFIG.github.defaultBranch,
  }
}
