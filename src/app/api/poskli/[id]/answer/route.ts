import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { emitEvent } from '@/lib/studio/events/bus'

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
 * POST /api/poskli/:id/answer — responde à pergunta pendente do
 * agente (tool ask_user_question). O polling da tool vê o status
 * ANSWERED e devolve a resposta ao LLM — o run retoma sozinho.
 *
 * Body: { toolCallId: string, answers: [{ header?: string, answer: string }] }
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const { id } = await params
  const run = await ownedRun(id, user.id)
  if (!run) return NextResponse.json({ error: 'RUN_NÃO_ENCONTRADO' }, { status: 404 })

  if (['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'PARTIAL'].includes(run.state)) {
    return NextResponse.json({ error: 'RUN_JÁ_FINALIZADO', state: run.state }, { status: 409 })
  }

  const body = await req.json().catch(() => ({}))
  const toolCallId = String(body.toolCallId ?? '')
  if (!toolCallId) return NextResponse.json({ error: 'TOOLCALL_ID_OBRIGATÓRIO' }, { status: 400 })

  const rawAnswers = Array.isArray(body.answers) ? body.answers : []
  const answers = rawAnswers
    .map((a: Record<string, unknown>) => ({
      header: typeof a?.header === 'string' ? a.header.slice(0, 80) : undefined,
      answer: String(a?.answer ?? '').trim().slice(0, 400),
    }))
    .filter((a: { answer: string }) => a.answer.length > 0)
    .slice(0, 4)
  if (answers.length === 0) {
    return NextResponse.json({ error: 'RESPOSTA_VAZIA (escolha uma opção ou escreva uma resposta)' }, { status: 400 })
  }

  // pergunta pertence a este projeto e está pendente?
  const call = await db.toolCall.findFirst({
    where: {
      id: toolCallId,
      projectId: run.projectId,
      tool: 'ask_user_question',
      status: 'PENDING',
    },
  })
  if (!call) {
    return NextResponse.json({ error: 'PERGUNTA_NÃO_ENCONTRADA (já respondida ou expirada)' }, { status: 404 })
  }

  await db.toolCall.update({
    where: { id: call.id },
    data: {
      status: 'ANSWERED',
      output: JSON.stringify({ answers, answeredAt: new Date().toISOString() }),
      error: null,
    },
  })

  await emitEvent({
    type: 'poskli.question.answered',
    projectId: run.projectId,
    runId: id,
    status: 'OK',
    message: 'Resposta enviada — o agente retomou a execução',
    data: { toolCallId: call.id, answers: answers.length },
  })

  return NextResponse.json({ ok: true, message: 'Resposta enviada — o agente prossegue agora' })
}
