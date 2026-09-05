import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { rateLimitApi, clientIp } from '@/lib/studio/security/rate-limit'
import {
  gitStatus, gitInit, gitCommit, gitBranch, gitCheckout, gitDiff,
  githubConnect, githubPush, githubPull, githubClone, githubDisconnect,
} from '@/lib/studio/git/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Guarda: sessão + posse do projeto. */
async function owned(req: Request, projectId: string) {
  const user = await getSessionUser(req)
  if (!user) return { status: 401 as const }
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) return { status: 404 as const }
  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, name: true } })
  if (!project) return { status: 404 as const }
  return { user, projectId }
}

/**
 * GET /api/git?project=&diff=<path?> — status completo (branch, mudanças,
 * log, branches, repo conectado) + diff opcional.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const projectId = url.searchParams.get('project') ?? ''
  const g = await owned(req, projectId)
  if ('status' in g) return NextResponse.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })

  try {
    const status = await gitStatus(g.projectId)
    const diffPath = url.searchParams.get('diff')
    const diff = diffPath !== null ? await gitDiff(g.projectId, diffPath || undefined) : undefined
    return NextResponse.json({ status: { ...status }, ...(diff !== undefined ? { diff } : {}) })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

/**
 * POST /api/git { project, action, ... }
 * actions: init | commit | branch | checkout | connect | push | pull | clone | disconnect
 * Tokens GitHub existem SOMENTE no backend — nunca nesta resposta.
 */
export async function POST(req: Request) {
  const rl = rateLimitApi(clientIp(req) + ':git')
  if (!rl.allowed) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 })

  const body = await req.json().catch(() => ({}))
  const projectId = String(body.project ?? '')
  const action = String(body.action ?? '')
  const g = await owned(req, projectId)
  if ('status' in g) return NextResponse.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })

  try {
    switch (action) {
      case 'init':
        return NextResponse.json({ ok: true, ...(await gitInit(g.projectId)) })
      case 'commit': {
        const message = String(body.message ?? '')
        if (message.trim().length < 3) return NextResponse.json({ error: 'MENSAGEM_OBRIGATÓRIA (mín 3)' }, { status: 400 })
        const res = await gitCommit(g.projectId, message, { name: g.user.name, email: g.user.email })
        return NextResponse.json({ ok: true, ...res })
      }
      case 'branch': {
        const name = String(body.name ?? '')
        if (!name.trim()) return NextResponse.json({ error: 'NOME_OBRIGATÓRIO' }, { status: 400 })
        return NextResponse.json({ ok: true, ...(await gitBranch(g.projectId, name)) })
      }
      case 'checkout': {
        const name = String(body.name ?? '')
        if (!name.trim()) return NextResponse.json({ error: 'NOME_OBRIGATÓRIO' }, { status: 400 })
        return NextResponse.json({ ok: true, ...(await gitCheckout(g.projectId, name)) })
      }
      case 'connect': {
        const repo = String(body.repo ?? '')
        if (!repo.trim()) return NextResponse.json({ error: 'REPO_OBRIGATÓRIO (owner/name)' }, { status: 400 })
        return NextResponse.json({ ok: true, ...(await githubConnect(g.projectId, repo, g.user.id)) })
      }
      case 'push':
        return NextResponse.json({ ok: true, ...(await githubPush(g.projectId, body.branch ? String(body.branch) : undefined)) })
      case 'pull':
        return NextResponse.json({ ok: true, ...(await githubPull(g.projectId, body.branch ? String(body.branch) : undefined)) })
      case 'clone': {
        const repo = String(body.repo ?? '')
        if (!repo.trim()) return NextResponse.json({ error: 'REPO_OBRIGATÓRIO' }, { status: 400 })
        return NextResponse.json({ ok: true, ...(await githubClone(g.projectId, repo)) })
      }
      case 'disconnect':
        return NextResponse.json({ ...(await githubDisconnect(g.projectId)) })
      default:
        return NextResponse.json({ error: `AÇÃO_INVÁLIDA: ${action || '(vazia)'}` }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
