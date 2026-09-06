import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'

export const dynamic = 'force-dynamic'

/** Posse: run → projeto → usuário. */
async function ownedRun(id: string, userId: string) {
  const run = await db.poskliRun.findUnique({ where: { id } })
  if (!run) return null
  const project = await db.project.findFirst({ where: { id: run.projectId, userId }, select: { id: true } })
  if (!project) return null
  return run
}

/**
 * GET /api/poskli/:id — detalhe completo: estágios, tarefas,
 * execuções do run (com saída real), resultado markdown.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })
  const { id } = await params

  const run = await ownedRun(id, user.id)
  if (!run) return NextResponse.json({ error: 'RUN_NÃO_ENCONTRADO' }, { status: 404 })

  const progress = await db.task.findMany({
    where: { projectId: run.projectId },
    orderBy: { order: 'asc' },
    select: { id: true, order: true, title: true, description: true, status: true, agentRole: true, priority: true, attempts: true, maxAttempts: true, error: true, result: true },
    take: 20,
  }).catch(() => [])

  const executions = await db.execution.findMany({
    where: { projectId: run.projectId, source: 'poskli' },
    orderBy: { startedAt: 'asc' },
    take: 20,
    select: {
      id: true, command: true, status: true, exitCode: true, durationMs: true,
      stdout: true, stderr: true, startedAt: true,
    },
  }).catch(() => [])

  return NextResponse.json({ run, tasks: progress, executions })
}

/** DELETE /api/poskli/:id — CANCELAMENTO cooperativo (entre estágios). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })
  const { id } = await params

  const run = await ownedRun(id, user.id)
  if (!run) return NextResponse.json({ error: 'RUN_NÃO_ENCONTRADO' }, { status: 404 })

  const finished = ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'PARTIAL']
  if (finished.includes(run.state)) {
    return NextResponse.json({ ok: false, message: 'Run já finalizado', state: run.state })
  }

  await db.poskliRun.update({
    where: { id },
    data: { state: 'CANCELLED', error: 'Cancelado pelo usuário', finishedAt: new Date() },
  })
  return NextResponse.json({ ok: true, message: 'Cancelamento solicitado — o orquestrador para no próximo estágio' })
}
