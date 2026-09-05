import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { rateLimitApi, clientIp } from '@/lib/studio/security/rate-limit'
import { executeAllowedCommand, checkCommand } from '@/lib/studio/security/commands'
import { emitEvent } from '@/lib/studio/events/bus'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/terminal — executa comando PERMITIDO no workspace,
 * para o DONO do projeto (mesma allowlist e limites dos agentes).
 * Painel TERMINAL do workspace.
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

  const check = checkCommand(command)
  if (!check.allowed) {
    return NextResponse.json(
      { ok: false, exitCode: 126, stdout: '', stderr: `COMANDO NEGADO: ${check.reason}`, durationMs: 0 },
      { status: 200 }
    )
  }

  const res = await executeAllowedCommand(command, project.rootPath)

  await emitEvent({
    type: 'tool.completed',
    projectId,
    tool: 'terminal',
    agent: 'user:' + user.name,
    action: command.slice(0, 120),
    status: res.exitCode === 0 ? 'OK' : 'ERROR',
    message: `Terminal: ${command} → exit ${res.exitCode}`,
    durationMs: res.durationMs,
  })

  return NextResponse.json({
    ok: res.exitCode === 0,
    exitCode: res.exitCode,
    stdout: res.stdout.slice(0, 20_000),
    stderr: res.stderr.slice(0, 8_000),
    durationMs: res.durationMs,
    timedOut: res.timedOut,
  })
}
