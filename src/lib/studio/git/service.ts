// ============================================================
// GIT SERVICE — git REAL via isomorphic-git (pure JS, sem binário:
// funciona identico no sandbox e na Vercel serverless)
//
// - .git materializado junto ao workspace e PERSISTIDO no DB
//   (sync includeGit — objetos git reais em base64)
// - status/log/branch/checkout/commit/init locais
// - diff working vs HEAD (jsdiff)
// - push/pull/clone GitHub com token APENAS server-side (nunca na UI)
// ============================================================

import fs from 'fs'
import * as fsp from 'fs/promises'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { createTwoFilesPatch } from 'diff'
import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { ensureMaterialized, syncBackToDb } from '../workspace/sync'
import { emitEvent } from '../events/bus'

const GIT_AUTHOR_FALLBACK = { name: 'AI Development Studio', email: 'studio@local' }

/** Sanitiza erros — token NUNCA vaza em mensagens. */
function cleanError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e)
  return msg
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[TOKEN_REDACTED]')
    .replace(/x-oauth-basic:[^\s@]+/g, '[TOKEN_REDACTED]')
    .replace(/https:\/\/[^@]+@github\.com/g, 'https://github.com')
    .slice(0, 500)
}

/** Repo remoto do projeto (owner/name) → URL https. */
function repoUrl(gitRepo: string): string {
  return `https://github.com/${gitRepo}.git`
}

async function ensureRepo(projectId: string): Promise<string> {
  const root = await ensureMaterialized(projectId)
  const gitDir = `${root}/.git`
  const exists = await fsp.stat(gitDir).catch(() => null)
  if (!exists) {
    await git.init({ fs, dir: root, defaultBranch: 'main' })
    await syncBackToDb(projectId, { includeGit: true })
  }
  return root
}

export interface GitStatusInfo {
  initialized: boolean
  branch: string | null
  changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>
  commits: Array<{ oid: string; message: string; author: string; timestamp: number }>
  branches: string[]
  repo: { connected: boolean; fullName: string | null }
  ahead: number | null
}

/** STATUS completo: branch, mudanças vs HEAD, log, branches. */
export async function gitStatus(projectId: string): Promise<GitStatusInfo> {
  const project = await db.project.findUnique({ where: { id: projectId } })
  const root = await ensureMaterialized(projectId)
  const initialized = await fsp.stat(`${root}/.git`).then(() => true).catch(() => false)

  if (!initialized) {
    return {
      initialized: false,
      branch: null,
      changes: [],
      commits: [],
      branches: [],
      repo: { connected: Boolean(project?.gitRepo), fullName: project?.gitRepo ?? null },
      ahead: null,
    }
  }

  const branch = (await git.currentBranch({ fs, dir: root, fullname: false }).catch(() => null)) as string | null
  // statusMatrix: [path, HEAD, WORKDIR, STAGE] — 0=ausente, 1=presente(igual HEAD), 2=presente(diferente)
  // ATENÇÃO: arquivo NOVO (untracked) → [0, 2, 0] (não [0,1,0])
  const matrix = await git.statusMatrix({ fs, dir: root, ignored: false }).catch(() => [] as string[][])
  const changes: GitStatusInfo['changes'] = []
  for (const [filepath, head, workdir] of matrix as Array<[string, number, number, number]>) {
    if (filepath === '.git' || filepath.startsWith('.git/')) continue
    if (head === 0 && (workdir === 1 || workdir === 2)) changes.push({ path: filepath, status: 'added' })
    else if (head === 1 && workdir === 2) changes.push({ path: filepath, status: 'modified' })
    else if (head === 1 && workdir === 0) changes.push({ path: filepath, status: 'deleted' })
  }

  const commitsRaw = await git.log({ fs, dir: root, depth: 10 }).catch(() => [])
  const commits = commitsRaw.map((c) => ({
    oid: c.oid.slice(0, 8),
    message: (c.commit.message ?? '').split('\n')[0].slice(0, 120),
    author: `${c.commit.author?.name ?? '?'} <${c.commit.author?.email ?? ''}>`,
    timestamp: (c.commit.author?.timestamp ?? 0) * 1000,
  }))

  const branches = await git.listBranches({ fs, dir: root }).catch(() => [] as string[])

  return {
    initialized: true,
    branch,
    changes,
    commits,
    branches,
    repo: { connected: Boolean(project?.gitRepo), fullName: project?.gitRepo ?? null },
    ahead: null,
  }
}

/** INIT: cria repositório (se não existir). */
export async function gitInit(projectId: string): Promise<{ initialized: boolean }> {
  await ensureRepo(projectId)
  return { initialized: true }
}

/** COMMIT: adiciona tudo (exceto gerados) e cria commit. */
export async function gitCommit(projectId: string, message: string, author?: { name: string; email: string }): Promise<{ oid: string; committed: boolean }> {
  const root = await ensureRepo(projectId)
  const msg = message.trim().slice(0, 200) || 'atualização'
  const matrix = await git.statusMatrix({ fs, dir: root })
  let staged = 0
  for (const [filepath, headState, workdir, stage] of matrix as Array<[string, number, number, number]>) {
    const isGit = filepath === '.git' || filepath.startsWith('.git/')
    const generated = ['node_modules', 'dist', '.next', '.cache', 'coverage'].some((p) => filepath.startsWith(p + '/'))
    if (isGit || generated) continue
    const unchanged = headState === 1 && workdir === stage
    if (unchanged && workdir === 1) continue
    if (workdir === 0) {
      await git.remove({ fs, dir: root, filepath }).catch(() => {})
      staged++
    } else {
      await git.add({ fs, dir: root, filepath })
      staged++
    }
  }
  if (staged === 0) return { oid: '', committed: false }

  const oid = await git.commit({
    fs, dir: root, message: msg,
    author: { ...GIT_AUTHOR_FALLBACK, ...(author ?? {}) },
  })
  await syncBackToDb(projectId, { includeGit: true })
  await emitEvent({
    type: 'github.commit.created',
    projectId,
    message: `Commit criado: ${oid.slice(0, 8)} — ${msg}`,
    data: { oid: oid.slice(0, 8) },
  })
  return { oid, committed: true }
}

/** BRANCH: cria nova branch. */
export async function gitBranch(projectId: string, name: string): Promise<{ branch: string }> {
  const root = await ensureRepo(projectId)
  const clean = name.trim().replace(/[^\w./-]/g, '-').replace(/^\.+/g, '')
  if (!clean) throw new Error('NOME_INVÁLIDO')
  await git.branch({ fs, dir: root, ref: clean })
  await syncBackToDb(projectId, { includeGit: true })
  return { branch: clean }
}

/** CHECKOUT: troca de branch. */
export async function gitCheckout(projectId: string, name: string): Promise<{ branch: string; synced: boolean }> {
  const root = await ensureRepo(projectId)
  const clean = name.trim().replace(/[^\w./-]/g, '-').replace(/^\.+/g, '')
  if (!clean) throw new Error('NOME_INVÁLIDO')
  await git.checkout({ fs, dir: root, ref: clean })
  // working tree mudou → sync para o DB
  const sync = await syncBackToDb(projectId, { includeGit: true, deleteMissing: true })
  await db.project.update({ where: { id: projectId }, data: { gitBranch: clean } }).catch(() => {})
  await emitEvent({ type: 'github.branch.created', projectId, message: `Branch ativa: ${clean}` })
  return { branch: clean, synced: sync.synced > 0 }
}

/** DIFF: working tree vs HEAD (arquivo único ou geral). */
export async function gitDiff(projectId: string, path?: string): Promise<string> {
  const root = await ensureRepo(projectId)
  const initialized = await fsp.stat(`${root}/.git`).then(() => true).catch(() => false)
  if (!initialized) return '(repositório não inicializado)'

  const matrix = await git.statusMatrix({ fs, dir: root }).catch(() => [] as unknown[])
  const changed = (matrix as Array<[string, number, number]>)
    .filter(([p, head, workdir]) => p !== '.git' && !p.startsWith('.git/') && head !== workdir)
    .map(([p]) => p)
    .filter((p) => (path ? p === path : true))
  if (changed.length === 0) return '(nenhuma diferença)'

  const patches: string[] = []
  for (const file of changed.slice(0, 20)) {
    // conteúdo no HEAD (walk na árvore)
    const headContent = (await git
      .walk({
        fs, dir: root,
        trees: [git.TREE({ ref: 'HEAD' })],
        map: async (filepath, [head]) => {
          if (filepath !== file) return undefined
          if (!head) return '__ABSENT__'
          const blob = await head.content()
          return blob ? Buffer.from(blob as Uint8Array).toString('utf8') : '__ABSENT__'
        },
      })
      .catch(() => [])) as string[]
    const headText = headContent[0] === '__ABSENT__' || headContent[0] === undefined ? '' : headContent[0]
    // conteúdo atual (workdir)
    let workText = ''
    try {
      workText = await fsp.readFile(`${root}/${file}`, 'utf8')
    } catch {
      workText = '' // deletado
    }
    const patch = createTwoFilesPatch(`a/${file}`, `b/${file}`, headText, workText, undefined, undefined, { context: 3 })
    patches.push(patch)
  }
  const out = patches.join('\n')
  return out.length > 30_000 ? out.slice(0, 30_000) + '\n...[diff truncado]' : out
}

/** CONNECT: valida repo via API GitHub + salva no projeto + remote local. */
export async function githubConnect(projectId: string, repo: string, userId: string): Promise<{ fullName: string; login: string }> {
  const clean = repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw new Error('REPO_INVÁLIDO (use owner/name)')

  const token = STUDIO_CONFIG.github.token
  if (!token) throw new Error('GITHUB_TOKEN_NÃO_CONFIGURADO no servidor')

  // valida acesso ao repo (token NUNCA sai do server-side)
  const res = await fetch(`https://api.github.com/repos/${clean}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'ai-dev-studio' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    if (res.status === 404) throw new Error('REPO_NÃO_ENCONTRADO ou sem acesso')
    throw new Error(`GITHUB_API_${res.status}`)
  }
  const info = (await res.json()) as { full_name: string; permissions?: { push: boolean }; size: number }
  if (info.size > STUDIO_CONFIG.github.maxRepoMb * 1024) {
    throw new Error(`REPO_GRANDE_DEMAIS (${Math.round(info.size / 1024)}MB > ${STUDIO_CONFIG.github.maxRepoMb}MB)`)
  }

  const loginRes = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'ai-dev-studio' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  const login = loginRes?.ok ? ((await loginRes.json()) as { login: string }).login : 'conectado'

  await db.project.update({ where: { id: projectId }, data: { gitRepo: info.full_name } })
  // registra conexão do usuário (nunca o token — apenas last4 p/ identificação)
  await db.githubConnection.upsert({
    where: { id: 'default' },
    create: { id: 'default', userId, login, tokenLast4: token.slice(-4), scopes: ['repo'], active: true },
    update: { userId, login, tokenLast4: token.slice(-4), active: true },
  }).catch(() => { /* best-effort */ })

  // configura remote local
  const root = await ensureRepo(projectId)
  const existing = await git.listRemotes({ fs, dir: root }).catch(() => [])
  if (existing.some((r) => r.remote === 'origin')) {
    await git.deleteRemote({ fs, dir: root, remote: 'origin' }).catch(() => {})
  }
  await git.addRemote({ fs, dir: root, remote: 'origin', url: repoUrl(info.full_name) })
  await syncBackToDb(projectId, { includeGit: true })
  await emitEvent({ type: 'github.push.completed', projectId, message: `Repositório conectado: ${info.full_name}` })
  return { fullName: info.full_name, login }
}

/** PUSH: envia branch atual (ou informada) para origin. */
export async function githubPush(projectId: string, branch?: string): Promise<{ pushed: boolean; branch: string; detail: string }> {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project?.gitRepo) throw new Error('REPO_NÃO_CONECTADO — conecte um repositório primeiro')

  const token = STUDIO_CONFIG.github.token
  if (!token) throw new Error('GITHUB_TOKEN_NÃO_CONFIGURADO no servidor')

  const root = await ensureRepo(projectId)
  const ref = branch ?? (await git.currentBranch({ fs, dir: root, fullname: false }).catch(() => null)) ?? 'main'

  // garante remote correto
  const existing = await git.listRemotes({ fs, dir: root }).catch(() => [])
  if (!existing.some((r) => r.remote === 'origin')) {
    await git.addRemote({ fs, dir: root, remote: 'origin', url: repoUrl(project.gitRepo) })
  }

  const result = await git.push({
    fs, http, dir: root, remote: 'origin', ref, force: false,
    onAuth: () => ({ username: token, password: 'x-oauth-basic' }),
  }).catch((e: unknown) => { throw new Error(cleanError(e)) })

  await syncBackToDb(projectId, { includeGit: true })
  await emitEvent({
    type: 'github.push.completed',
    projectId,
    message: `Push concluído: ${project.gitRepo}#${ref}`,
  })
  return { pushed: true, branch: ref, detail: result ? 'refs atualizadas' : 'nada a enviar (up to date)' }
}

/** PULL: fetch + fast-forward merge da branch remota. */
export async function githubPull(projectId: string, branch?: string): Promise<{ pulled: boolean; branch: string; detail: string }> {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project?.gitRepo) throw new Error('REPO_NÃO_CONECTADO')
  const token = STUDIO_CONFIG.github.token
  if (!token) throw new Error('GITHUB_TOKEN_NÃO_CONFIGURADO no servidor')

  const root = await ensureRepo(projectId)
  const ref = branch ?? (await git.currentBranch({ fs, dir: root, fullname: false }).catch(() => null)) ?? 'main'

  await git.fetch({
    fs, http, dir: root, remote: 'origin', ref,
    onAuth: () => ({ username: token, password: 'x-oauth-basic' }),
  }).catch((e: unknown) => { throw new Error(cleanError(e)) })

  // fast-forward apenas — merge com conflito exige ação manual (honesto)
  await git.merge({
    fs, dir: root, ours: ref, theirs: `origin/${ref}`, fastForwardOnly: true,
    author: GIT_AUTHOR_FALLBACK,
  }).catch((e: unknown) => {
    throw new Error(`FAST_FORWARD_IMPOSSÍVEL: histórico divergente — resolva manualmente (${cleanError(e).slice(0, 120)})`)
  })

  await git.checkout({ fs, dir: root, ref })
  const sync = await syncBackToDb(projectId, { includeGit: true, deleteMissing: true })
  await emitEvent({ type: 'github.push.completed', projectId, message: `Pull concluído: ${project.gitRepo}#${ref}` })
  return { pulled: true, branch: ref, detail: sync.synced > 0 ? `${sync.synced} arquivo(s) atualizado(s)` : 'nada novo' }
}

/** CLONE: importa repo GitHub para DENTRO do projeto (workspace). */
export async function githubClone(projectId: string, repo: string): Promise<{ files: number }> {
  const clean = repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw new Error('REPO_INVÁLIDO')
  const token = STUDIO_CONFIG.github.token
  if (!token) throw new Error('GITHUB_TOKEN_NÃO_CONFIGURADO no servidor')

  const root = await ensureMaterialized(projectId)
  const tmp = `${root}/.clone-tmp`
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  await git.clone({
    fs, http, dir: tmp, url: repoUrl(clean), singleBranch: true, depth: 1, noCheckout: false,
    onAuth: () => ({ username: token, password: 'x-oauth-basic' }),
  }).catch((e: unknown) => {
    void fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw new Error(cleanError(e))
  })

  // move arquivos (exceto node_modules) para o workspace
  const entries = await fsp.readdir(tmp, { withFileTypes: true })
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.clone-tmp') continue
    await fsp.rename(`${tmp}/${e.name}`, `${root}/${e.name}`).catch(async () => {
      await fsp.cp(`${tmp}/${e.name}`, `${root}/${e.name}`, { recursive: true })
    })
  }
  // traz o .git do clone (histórico do repo original)
  await fsp.rename(`${tmp}/.git`, `${root}/.git`).catch(() => {})
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})

  await db.project.update({ where: { id: projectId }, data: { gitRepo: clean } })
  const sync = await syncBackToDb(projectId, { includeGit: true })
  return { files: sync.synced }
}

/** DISCONNECT: remove binding. */
export async function githubDisconnect(projectId: string): Promise<{ ok: boolean }> {
  await db.project.update({ where: { id: projectId }, data: { gitRepo: null } })
  return { ok: true }
}
