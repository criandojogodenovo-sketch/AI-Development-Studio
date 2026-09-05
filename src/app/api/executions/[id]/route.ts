import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { cancelExecution } from '@/lib/studio/execution/engine'

export const dynamic = 'force-dynamic'

/**
 * GET /api/executions/:id — detalhe persistido (stdout/stderr completos).
 * DELETE /api/executions/:id — CANCELA a execução (SIGKILL no processo).
 */
/** Verifica posse: execução → projeto → usuário. */
async function findOwnedExecution(id: string, userId: string) {
  const exec = await db.execution.findUnique({ where: { id } })
  if (!exec) return null
  const project = await db.project.findFirst({ where: { id: exec.projectId, userId }, select: { id: true } })
  if (!project) return null
  return exec
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })
  const { id } = await params

  const exec = await findOwnedExecution(id, user.id)
  if (!exec) return NextResponse.json({ error: 'EXECUÇÃO_NÃO_ENCONTRADA' }, { status: 404 })

  return NextResponse.json({ execution: exec })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })
  const { id } = await params

  const exec = await findOwnedExecution(id, user.id)
  if (!exec) return NextResponse.json({ error: 'EXECUÇÃO_NÃO_ENCONTRADA' }, { status: 404 })
  if (exec.status !== 'RUNNING' && exec.status !== 'QUEUED') {
    return NextResponse.json({ ok: false, message: 'Execução já finalizada', status: exec.status })
  }

  const killed = cancelExecution(id)
  if (!killed) {
    // processo não está nesta instância — marca intenção de cancelamento
    await db.execution.update({
      where: { id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    }).catch(() => {})
    return NextResponse.json({ ok: true, message: 'Cancelamento registrado (processo não estava nesta instância)' })
  }
  return NextResponse.json({ ok: true, message: 'Processo encerrado' })
}
