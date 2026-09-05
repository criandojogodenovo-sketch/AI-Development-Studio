import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { rateLimitApi, clientIp } from '@/lib/studio/security/rate-limit'
import { runExecution } from '@/lib/studio/execution/engine'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/terminal — LEGADO (compatibilidade): executa comando
 * permitido e retorna resultado único. Agora roda pelo EXECUTION
 * ENGINE (registro persistido + sync do workspace).
 * Novo terminal em tempo real: POST /api/executions (streaming SSE).
 */
export async function POST(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const rl = rateLimitApi(clientIp(req) + ':terminal')
  if (!rl.allowed) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 })

  const body = await req.json().catch(() => ({}))
  const projectId = String(body.project ?? '')
  const command = String(body.command ?? '').trim()

  if (!command) return NextResponse.json({ error: 'COMANDO_VAZIO' }, { status: 400 })

  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  const res = await runExecution({
    projectId,
    command,
    userId: user.id,
    source: 'terminal',
    trigger: `user:${user.name}`,
  })

  return NextResponse.json({
    ok: res.status === 'SUCCESS',
    exitCode: res.exitCode,
    stdout: res.stdout.slice(0, 20_000),
    stderr: res.stderr.slice(0, 8_000),
    durationMs: res.durationMs,
    timedOut: res.timedOut,
    status: res.status,
    executionId: res.executionId,
    syncedFiles: res.syncedFiles,
  })
}
