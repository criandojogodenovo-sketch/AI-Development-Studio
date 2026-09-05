// ============================================================
// TOOLS / GIT — Operações Git no workspace do projeto
// git_status, git_diff, git_log, git_create_branch,
// git_commit, git_push (com token somente em memória)
// Workflow: main → agent/task-branch → commit → testes →
// review → PR → merge (nunca push direto em main por padrão)
// ============================================================

import fs from 'fs/promises'
import path from 'path'
import { getExecutionProvider } from '../executor/provider'
import { emitEvent } from '../events/bus'
import { STUDIO_CONFIG } from '../config'
import type { ToolDefinition, ToolResult } from './types'

async function git(ctx: { workspaceRoot: string }, args: string): Promise<{ code: number; out: string; err: string }> {
  const provider = getExecutionProvider()
  const res = await provider.execute({
    command: `git ${args}`,
    cwd: ctx.workspaceRoot,
    label: 'git',
  })
  const clean = (s: string) => s.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[TOKEN_REDACTED]')
  return { code: res.exitCode, out: clean(res.stdout), err: clean(res.stderr) }
}

async function ensureRepo(workspaceRoot: string): Promise<void> {
  const gitDir = path.join(workspaceRoot, '.git')
  const exists = await fs.stat(gitDir).catch(() => null)
  if (!exists) {
    await git({ workspaceRoot }, 'init -b main')
    await git({ workspaceRoot }, 'config user.email agent@ai-dev-studio.local')
    await git({ workspaceRoot }, 'config user.name "AI Studio Agent"')
  }
}

export const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description: 'Estado do repositório Git: branch atual, arquivos modificados/novos, commits à frente.',
  category: 'git',
  permissions: ['git:read'],
  params: [],
  async execute(_args, ctx): Promise<ToolResult> {
    await ensureRepo(ctx.workspaceRoot)
    const br = await git(ctx, 'rev-parse --abbrev-ref HEAD')
    const st = await git(ctx, 'status --short')
    const lg = await git(ctx, 'log --oneline -5')
    return {
      ok: true,
      output: `BRANCH: ${br.out.trim() || 'main'}\n--- STATUS ---\n${st.out.trim() || 'limpo'}\n--- ÚLTIMOS COMMITS ---\n${lg.out.trim() || '(sem commits)'}`,
    }
  },
}

export const gitDiffTool: ToolDefinition = {
  name: 'git_diff',
  description: 'Diff de alterações não commitadas (útil para revisão do que o agente mudou).',
  category: 'git',
  permissions: ['git:read'],
  params: [{ name: 'staged', type: 'boolean', required: false, description: 'Se true, mostra diff staged' }],
  async execute(args, ctx): Promise<ToolResult> {
    await ensureRepo(ctx.workspaceRoot)
    const res = await git(ctx, args.staged ? 'diff --cached' : 'diff')
    const out = res.out.length > 8000 ? res.out.slice(0, 8000) + '\n...[diff truncado]' : res.out
    return { ok: true, output: out || '(nenhuma diferença)' }
  },
}

export const gitLogTool: ToolDefinition = {
  name: 'git_log',
  description: 'Histórico de commits do projeto.',
  category: 'git',
  permissions: ['git:read'],
  params: [{ name: 'limit', type: 'number', required: false, description: 'Máximo de commits (padrão 10)' }],
  async execute(args, ctx): Promise<ToolResult> {
    await ensureRepo(ctx.workspaceRoot)
    const limit = Math.min(Math.max(1, Number(args.limit) ?? 10), 30)
    const res = await git(ctx, `log --oneline -n ${limit}`)
    return { ok: true, output: res.out || '(sem commits)' }
  },
}

export const gitCreateBranchTool: ToolDefinition = {
  name: 'git_create_branch',
  description:
    'Cria e muda para branch de trabalho (padrão: agent/<nome>). Nunca comita direto em main sem revisão.',
  category: 'git',
  permissions: ['git:write'],
  params: [{ name: 'name', type: 'string', required: true, description: 'Nome da branch (ex: task-001, fix-auth)' }],
  async execute(args, ctx): Promise<ToolResult> {
    await ensureRepo(ctx.workspaceRoot)
    let name = String(args.name).trim().replace(/[^\w./-]/g, '-')
    if (!name.startsWith('agent/')) name = `agent/${name}`
    const res = await git(ctx, `checkout -b ${name}`)
    if (res.code !== 0) {
      const existing = await git(ctx, `checkout ${name}`)
      if (existing.code !== 0) return { ok: false, output: `FALHA_BRANCH: ${res.err}` }
    }
    await emitEvent({
      type: 'github.branch.created',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      message: `Branch criada/selecionada: ${name}`,
      data: { branch: name },
    })
    return { ok: true, output: `BRANCH_ATIVA: ${name}` }
  },
}

export const gitCommitTool: ToolDefinition = {
  name: 'git_commit',
  description: 'Adiciona alterações e cria commit com mensagem descritiva.',
  category: 'git',
  permissions: ['git:write'],
  params: [
    { name: 'message', type: 'string', required: true, description: 'Mensagem do commit' },
    { name: 'files', type: 'string', required: false, description: 'Paths específicos (separados por espaço); padrão: todos' },
  ],
  async execute(args, ctx): Promise<ToolResult> {
    await ensureRepo(ctx.workspaceRoot)
    const message = String(args.message).slice(0, 200)
    const addArgs = args.files ? String(args.files) : '-A'
    const add = await git(ctx, `add ${addArgs}`)
    if (add.code !== 0) return { ok: false, output: `GIT_ADD_FALHOU: ${add.err}` }
    // Verifica se há algo para commitar
    const st = await git(ctx, 'status --short')
    if (!st.out.trim()) return { ok: true, output: 'NADA_PARA_COMMITAR: working tree limpo' }
    const commit = await git(ctx, `commit -m "${message.replace(/"/g, "'")}"`)
    if (commit.code !== 0) return { ok: false, output: `GIT_COMMIT_FALHOU: ${commit.err}` }

    const log = await git(ctx, 'log --oneline -1')
    await emitEvent({
      type: 'github.commit.created',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      message: `Commit criado: ${log.out.trim()}`,
      data: { message, branch: 'current' },
    })
    return { ok: true, output: `COMMIT_CRIADO: ${log.out.trim()}` }
  },
}

export const gitPushTool: ToolDefinition = {
  name: 'git_push',
  description:
    'Push da branch atual para o remote. Requer remote configurado (via integração GitHub). NUNCA faz push em main diretamente.',
  category: 'git',
  permissions: ['git:write'],
  params: [
    { name: 'remote', type: 'string', required: false, description: 'Nome do remote (padrão origin)' },
  ],
  async execute(args, ctx): Promise<ToolResult> {
    await ensureRepo(ctx.workspaceRoot)
    const remoteName = String(args.remote ?? 'origin')

    const branch = await git(ctx, 'rev-parse --abbrev-ref HEAD')
    const branchName = branch.out.trim()
    if (branchName === 'main' || branchName === 'master') {
      return {
        ok: false,
        output: 'PUSH_MAIN_BLOQUEADO: push direto em main é proibido. Use git_create_branch primeiro.',
      }
    }

    const remotes = await git(ctx, 'remote -v')
    if (!remotes.out.includes(remoteName)) {
      return {
        ok: false,
        output: `REMOTE_AUSENTE: configure "${remoteName}" via integração GitHub antes do push.`,
      }
    }

    const push = await git(ctx, `push -u ${remoteName} ${branchName}`)
    if (push.code !== 0) {
      await emitEvent({
        type: 'github.push.failed',
        projectId: ctx.projectId,
        runId: ctx.runId,
        agent: ctx.agentId,
        message: `Push falhou para ${remoteName}/${branchName}`,
        data: { stderr: push.err.slice(0, 500) },
      })
      return { ok: false, output: `PUSH_FALHOU: ${push.err.slice(0, 800)}` }
    }

    await emitEvent({
      type: 'github.push.completed',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      message: `Push concluído: ${remoteName}/${branchName}`,
    })
    return { ok: true, output: `PUSH_CONCLUÍDO: ${remoteName}/${branchName}\n${push.out.slice(0, 400)}` }
  },
}

// Contagem de branches p/ UI
export async function getBranches(workspaceRoot: string): Promise<string[]> {
  await ensureRepo(workspaceRoot)
  const res = await git({ workspaceRoot }, 'branch --format=%(refname:short)')
  return res.out.split('\n').map((s) => s.trim()).filter(Boolean)
}

export const GIT_TOOLS = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCreateBranchTool,
  gitCommitTool,
  gitPushTool,
]

export { ensureRepo as gitEnsureRepo }
export const GIT_DEFAULT_BRANCH = STUDIO_CONFIG.github.defaultBranch
