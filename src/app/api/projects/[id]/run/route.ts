import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { rateLimitAgentRun, clientIp } from '@/lib/studio/security/rate-limit'
import { runPipeline } from '@/lib/studio/orchestrator/pipeline'
import { emitEvent } from '@/lib/studio/events/bus'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/projects/:id/run — inicia o ENGINEERING PERFECTION LOOP.
 * Body: { request: "pedido do usuário em linguagem natural" }
 *
 * A resposta sai imediatamente (202); o pipeline roda via after() do
 * next/server — no serverless (Vercel) isso mantém a invocação viva
 * após a resposta, dentro do maxDuration da função.
 * O progresso chega via eventos (WebSocket + polling da UI).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })
  const { id } = await params

  const rl = rateLimitAgentRun(clientIp(req), user.id)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'RATE_LIMIT_RUN (aguarde antes de novo run)' }, { status: 429 })
  }

  const project = await db.project.findFirst({ where: { id, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const userRequest = String(body.request ?? '').trim()
  if (userRequest.length < 5) {
    return NextResponse.json({ error: 'PEDIDO_INVÁLIDO (descreva o que deseja, mín 5 caracteres)' }, { status: 400 })
  }

  // Evita dois pipelines simultâneos no mesmo projeto — com recuperação:
  // um run "vivo" que não atualiza nada há > 10 min é considerado travado
  // (ex.: invocação suspensa pelo serverless) e é encerrado automaticamente.
  const isActive = project.status === 'PLANNING' || project.status === 'RUNNING'
  if (isActive) {
    const latestTask = await db.task.findFirst({
      where: { projectId: id },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    })
    const lastActivity = Math.max(
      new Date(project.updatedAt).getTime(),
      latestTask ? new Date(latestTask.updatedAt).getTime() : 0
    )
    const staleMs = 10 * 60 * 1000
    const isStale = Date.now() - lastActivity > staleMs

    if (!isStale) {
      return NextResponse.json({ error: 'PIPELINE_JÁ_ATIVO neste projeto' }, { status: 409 })
    }

    // Reconciliação do run travado: tarefas RUNNING órfãs → FAILED
    const orphan = await db.task.updateMany({
      where: { projectId: id, status: 'RUNNING' },
      data: { status: 'FAILED', error: 'Execução interrompida (run anterior travou — recuperado automaticamente)' },
    }).catch(() => null)
    await emitEvent({
      type: 'pipeline.failed',
      projectId: id,
      message: 'Execução anterior foi interrompida por inatividade — iniciando nova execução' +
        (orphan?.count ? ` (${orphan.count} tarefa(s) penduradas encerradas)` : ''),
    })
  }

  // Executa após a resposta (sobrevive ao freeze serverless dentro do maxDuration)
  const startedAt = new Date().toISOString()
  after(async () => {
    try {
      const summary = await runPipeline({ projectId: id, userRequest, userId: user.id })
      await db.project.update({
        where: { id },
        data: { memory: { ...(project.memory as object), lastPipeline: { at: startedAt, request: userRequest, status: summary.status } } as object },
      }).catch(() => {})
    } catch (e) {
      await emitEvent({
        type: 'pipeline.failed',
        projectId: id,
        message: `Pipeline falhou: ${(e as Error).message}`,
      })
      await db.project.update({ where: { id }, data: { status: 'FAILED' } }).catch(() => {})
    }
  })

  return NextResponse.json(
    { ok: true, startedAt, message: 'Pipeline iniciado — acompanhe em Tarefas/Atividade' },
    { status: 202 }
  )
}
