// ============================================================
// TOOLS / USER — Interatividade real (AskUserQuestion)
//
// A tool grava a pergunta numa ToolCall PENDING (canal de resposta
// no DB — sem migrations) e AGUARDA a resposta do usuário com
// polling cooperativo:
//   agente → tool → ToolCall(PENDING) → UI mostra modal →
//   POST /api/poskli/:id/answer → ToolCall(ANSWERED) →
//   polling da tool devolve a observação ao LLM.
//
// Timeout honesto: sem resposta em N segundos, o agente PROSSIGUE
// com a opção mais conservadora e documenta a suposição (nunca
// fica preso à espera — nunca loop infinito).
// Cancelamento do run interrompe a espera imediatamente.
// ============================================================

import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { emitEvent } from '../events/bus'
import {
  parseQuestionsInput, formatUserAnswers, nextQuestionPollAction,
  type AgentQuestion, type UserAnswer,
} from './question-format.ts'
import type { ToolDefinition, ToolResult } from './types'

const POLL_INTERVAL_MS = 2_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Janela de espera: sempre MENOR que o timeout da tool (margem p/ retorno). */
function waitWindowMs(): number {
  const t = STUDIO_CONFIG.agentic.userQuestionTimeoutMs
  return Math.max(10_000, t - 10_000)
}

export const askUserQuestionTool: ToolDefinition = {
  name: 'ask_user_question',
  description:
    'Pergunta ao USUÁRIO quando o pedido é ambíguo em algo CRÍTICO (estilo, plataforma, linguagem, escopo). ' +
    'Parâmetro `questions` = STRING JSON: [{"header":"Controles","question":"Teclado ou toque?",' +
    '"options":[{"label":"Toque","description":"mobile-first"},{"label":"Teclado"}]}] ' +
    '(máx 4 perguntas, 2-4 opções cada). A execução PAUSA até a resposta (ou timeout). ' +
    'NÃO pergunte o que você pode decidir com boas práticas; use UMA vez por ambiguidade.',
  category: 'user',
  permissions: ['user:ask'],
  params: [
    {
      name: 'questions',
      type: 'string',
      required: true,
      description: 'STRING JSON do array de perguntas (ver descrição)',
    },
  ],
  timeoutMs: STUDIO_CONFIG.agentic.userQuestionTimeoutMs + 30_000,
  async execute(args, ctx): Promise<ToolResult> {
    const parsed = parseQuestionsInput(String(args.questions ?? ''))
    if (!parsed.ok) {
      return { ok: false, output: `PERGUNTA_INVÁLIDA: ${parsed.error} — reformule e tente novamente.` }
    }
    const questions: AgentQuestion[] = parsed.questions

    // ---- pergunta registrada no canal de resposta (ToolCall PENDING) ----
    const call = await db.toolCall.create({
      data: {
        runId: ctx.runId,
        projectId: ctx.projectId,
        tool: 'ask_user_question',
        args: { questions, poskliRunId: ctx.poskliRunId ?? null } as object,
        status: 'PENDING',
        durationMs: 0,
      },
    })

    await emitEvent({
      type: 'poskli.question',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      tool: 'ask_user_question',
      status: 'PENDING',
      message: 'O agente precisa da sua resposta para continuar',
      data: { toolCallId: call.id, questions: questions.length },
    })

    const windowMs = waitWindowMs()
    const deadline = Date.now() + windowMs

    // ---- LOOP DE ESPERA: o agente BLOQUEIA aqui até a resposta
    // (decisão pura/testável em nextQuestionPollAction) ----
    while (true) {
      await sleep(POLL_INTERVAL_MS)

      const [runState, row] = await Promise.all([
        ctx.poskliRunId
          ? db.poskliRun.findUnique({ where: { id: ctx.poskliRunId }, select: { state: true } }).then((r) => r?.state ?? null).catch(() => null)
          : Promise.resolve(null),
        db.toolCall.findUnique({ where: { id: call.id }, select: { status: true, output: true } }).catch(() => null),
      ])

      const action = nextQuestionPollAction({
        toolCallStatus: row?.status ?? 'PENDING',
        runState,
        now: Date.now(),
        deadline,
      })

      if (action === 'CANCELLED') {
        await db.toolCall.update({ where: { id: call.id }, data: { status: 'CANCELLED', error: 'run cancelado' } }).catch(() => {})
        return { ok: false, output: 'RUN_CANCELADO: o usuário cancelou a execução durante a pergunta. Finalize imediatamente.' }
      }

      if (action === 'ANSWER' && row) {
        await db.toolCall
          .update({ where: { id: call.id }, data: { durationMs: Date.now() - new Date(call.createdAt).getTime() } })
          .catch(() => {})
        try {
          const payload = JSON.parse(row.output ?? '') as { answers?: UserAnswer[] }
          const answers = Array.isArray(payload.answers) ? payload.answers : []
          return {
            ok: true,
            output: `[RESPOSTA DO USUÁRIO]\n${formatUserAnswers(answers) || '(resposta vazia)'}`,
            data: { answered: true, toolCallId: call.id },
          }
        } catch {
          return { ok: true, output: `[RESPOSTA DO USUÁRIO]\n${(row.output ?? '').slice(0, 1200)}`, data: { answered: true } }
        }
      }

      if (action === 'TIMEOUT') break
      // WAIT → continua aguardando
    }

    // ---- timeout honesto: prossegue com suposição documentada ----
    await db.toolCall
      .update({ where: { id: call.id }, data: { status: 'TIMEOUT', error: 'sem resposta do usuário' } })
      .catch(() => {})
    await emitEvent({
      type: 'poskli.question.timeout',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      status: 'TIMEOUT',
      message: 'Sem resposta do usuário — o agente prosseguirá com a opção mais conservadora',
      data: { toolCallId: call.id, waitedMs: windowMs },
    })
    return {
      ok: true,
      output:
        `SEM_RESPOSTA: o usuário não respondeu em ${Math.round(windowMs / 1000)}s. ` +
        'PROSSIGA com a opção mais conservadora/razoável, DOCUMENTE a suposição no resultado final e NÃO repita a pergunta.',
      data: { answered: false, toolCallId: call.id },
    }
  },
}
