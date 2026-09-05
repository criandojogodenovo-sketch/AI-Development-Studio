import { NextResponse } from 'next/server'
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
 * O pipeline roda em background (não bloqueia a resposta);
 * o progresso chega via eventos (WebSocket + polling).
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

  // Evita dois pipelines simultâneos no mesmo projeto
  const active = await db.project.findFirst({ where: { id, status: { in: ['PLANNING', 'RUNNING'] } } })
  if (active) {
    return NextResponse.json({ error: 'PIPELINE_JÁ_ATIVO neste projeto' }, { status: 409 })
  }

  // Executa em background; a API responde imediatamente
  const startedAt = new Date().toISOString()
  const pipelinePromise = runPipeline({ projectId: id, userRequest, userId: user.id })
    .then(async (summary) => {
      await db.project.update({
        where: { id },
        data: { memory: { ...(project.memory as object), lastPipeline: { at: startedAt, request: userRequest, status: summary.status } } as object },
      }).catch(() => {})
      return summary
    })
    .catch(async (e) => {
      await emitEvent({
        type: 'pipeline.failed',
        projectId: id,
        message: `Pipeline falhou: ${(e as Error).message}`,
      })
      await db.project.update({ where: { id }, data: { status: 'FAILED' } }).catch(() => {})
      return null
    })

  // Não deixa promise órfã derrubar o processo
  pipelinePromise.catch(() => {})

  return NextResponse.json(
    { ok: true, startedAt, message: 'Pipeline iniciado — acompanhe em Tasks/Activity' },
    { status: 202 }
  )
}
