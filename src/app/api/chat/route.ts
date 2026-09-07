import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { rateLimitAgentRun, rateLimitApi, clientIp } from '@/lib/studio/security/rate-limit'
import { startPoskli, runPoskli, recoverStaleRun } from '@/lib/studio/poskli/orchestrator'
import { POSKLI_VERSIONS, normalizeVersion } from '@/lib/studio/models/chain'
import { STUDIO_CONFIG } from '@/lib/studio/config'
import { createWorkspace, newProjectId } from '@/lib/studio/projects/workspace'
import { TEMPLATES } from '@/lib/studio/projects/templates'
import {
  classifyIntent, clarifyQuestion, resolveTypeFromAnswer, projectNameFromMessage,
} from '@/lib/studio/projects/intent-router'
import { emitEvent } from '@/lib/studio/events/bus'
import {
  friendlyRunState, isThinkingState, isChatTerminal, isQuotaErrorCode,
  safeRunResult, activityToChatEvent, encodeSseEvent, QUOTA_EXHAUSTED_MESSAGE,
  thinkingStallDecision, chatAgentLabel,
} from '@/lib/poskli-chat'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ACTIVE_STATES = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING']
const POLL_INTERVAL_MS = 1_500
const STREAM_TIMEOUT_MS = 240_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * POST /api/chat — MENSAGEM do chat conversacional.
 *
 * Corpo: { message, projectId?, poskliVersion?, resolvedType? }
 *
 * CRIAÇÃO AUTOMÁTICA (sem seletor de tipo na UI):
 *   - sem projectId → lê o contexto da mensagem e decide o template;
 *   - contexto ambíguo (ex.: "Cria uma app") → responde com uma
 *     PERGUNTA (AskUserQuestion) em vez de adivinhar; o cliente
 *     reenvia com resolvedType (resposta do usuário);
 *   - confiante → cria o projeto (nome derivado da mensagem) e
 *     inicia o run.
 * Com projectId → nova mensagem da mesma conversa (novo run).
 *
 * Respostas:
 *   202 { runId, projectId, autoType? }    — run iniciado
 *   200 { needsClarification, question }   — agente perguntou
 *   409 { error: POSKLI_JÁ_ATIVO, runId }  — run em curso
 */
export async function POST(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const rl = rateLimitAgentRun(clientIp(req), user.id)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'RATE_LIMIT_RUN (aguarde antes de nova mensagem)', quota: true },
      { status: 429 }
    )
  }
  const rlApi = rateLimitApi(clientIp(req) + ':chat')
  if (!rlApi.allowed) return NextResponse.json({ error: 'RATE_LIMITED', quota: true }, { status: 429 })

  const body = await req.json().catch(() => ({}))
  const message = String(body.message ?? body.request ?? '').trim()
  const projectId = String(body.projectId ?? body.project ?? '').trim() || null
  const rawVersion =
    body.poskliVersion !== undefined && body.poskliVersion !== null
      ? String(body.poskliVersion).trim()
      : (req.headers.get('x-poskli-version') ?? '').trim()
  if (rawVersion && !(POSKLI_VERSIONS as readonly string[]).includes(rawVersion)) {
    return NextResponse.json({ error: `VERSAO_POSKLI_INVALIDA: "${rawVersion.slice(0, 24)}"` }, { status: 400 })
  }
  const poskliVersion = rawVersion || undefined

  if (message.length < 5) {
    return NextResponse.json({ error: 'MENSAGEM_INVÁLIDA (descreva o que deseja, mín 5 caracteres)' }, { status: 400 })
  }

  // ---- 1. projeto destino: existente OU criado automaticamente ----
  let targetProjectId = projectId
  let autoType: string | undefined
  if (targetProjectId) {
    const project = await db.project.findFirst({ where: { id: targetProjectId, userId: user.id } })
    if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })
  } else {
    // SEM seletor de tipo: o AGENTE lê o contexto da mensagem
    const resolvedRaw = String(body.resolvedType ?? '').trim()
    const intent = resolvedRaw
      ? (TEMPLATES[resolvedRaw]
          ? { type: resolvedRaw, confident: true, matched: 'resposta do usuário' }
          : resolveTypeFromAnswer(resolvedRaw))
      : classifyIntent(message)

    if (!intent.confident) {
      // ambíguo → PERGUNTA no chat (nunca adivinha silenciosamente)
      return NextResponse.json({
        needsClarification: true,
        question: clarifyQuestion(),
        message: 'Preciso de um detalhe antes de começar.',
      })
    }
    autoType = TEMPLATES[intent.type] ? intent.type : 'WEB_APP'

    const name = projectNameFromMessage(message) || 'Nova conversa'
    const newId = newProjectId()
    try {
      const { rootPath, fileCount } = await createWorkspace(newId, name, autoType, message.slice(0, 300))
      await db.project.create({
        data: {
          id: newId,
          userId: user.id,
          name,
          description: message.slice(0, 300),
          type: autoType,
          rootPath,
          memory: {} as object,
          settings: { create: { approvalMode: 'ASSISTED' } },
        },
      })
      await emitEvent({
        type: 'project.created',
        projectId: newId,
        message: `Projeto criado automaticamente: ${name} (${TEMPLATES[autoType]?.label ?? autoType}) com ${fileCount} arquivos`,
        data: { type: autoType, fileCount, auto: true },
      })
      targetProjectId = newId
    } catch (e) {
      return NextResponse.json({ error: `FALHA_CRIAÇÃO: ${(e as Error).message}` }, { status: 500 })
    }
  }

  // ---- 2. um run ativo por projeto (recuperação de run travado) ----
  const active = await db.poskliRun.findFirst({
    where: { projectId: targetProjectId, state: { in: ACTIVE_STATES } },
    orderBy: { startedAt: 'desc' },
  })
  if (active) {
    const staleMs = 10 * 60 * 1000
    const lastActivity = Math.max(
      new Date(active.startedAt).getTime(),
      new Date(active.updatedAt).getTime()
    )
    if (Date.now() - lastActivity < staleMs) {
      return NextResponse.json({ error: 'POSKLI_JÁ_ATIVO neste projeto', runId: active.id }, { status: 409 })
    }
    await recoverStaleRun(active.id).catch(() => {})
  }

  // ---- 3. inicia o run (execução via after() — sobrevive ao stream) ----
  const { runId } = await startPoskli({
    projectId: targetProjectId,
    userId: user.id,
    request: message,
    poskliVersion,
  })

  after(async () => {
    await runPoskli(runId, poskliVersion)
  })

  return NextResponse.json(
    { ok: true, runId, projectId: targetProjectId, ...(autoType ? { autoType } : {}) },
    { status: 202 }
  )
}

// ---------- GET: histórico da conversa OU stream SSE ----------

/** Carrega o run (posse verificada). */
async function ownedRun(runId: string, userId: string) {
  const run = await db.poskliRun.findUnique({ where: { id: runId } })
  if (!run) return null
  const project = await db.project.findFirst({ where: { id: run.projectId, userId }, select: { id: true } })
  if (!project) return null
  return run
}

/** Extrai path/command/query dos args Json da ToolCall. */
function argsDetail(args: unknown): { path?: string; command?: string; query?: string } {
  if (!args || typeof args !== 'object') return {}
  const a = args as Record<string, unknown>
  return {
    path: typeof a.path === 'string' ? a.path : undefined,
    command: typeof a.command === 'string' ? a.command : undefined,
    query: typeof a.query === 'string' ? a.query : undefined,
  }
}

/**
 * GET /api/chat?project=:id — HISTÓRICO da conversa (runs em ordem
 * cronológica: pedido do usuário + resposta final do agente).
 */
async function conversationHistory(projectId: string, userId: string) {
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true, name: true, type: true, status: true },
  })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  const runs = await db.poskliRun.findMany({
    where: { projectId },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: {
      id: true, request: true, state: true, errorCode: true, outcomeReason: true,
      error: true, result: true, startedAt: true, finishedAt: true,
    },
  })
  const messages = runs.reverse().map((r) => ({
    id: r.id,
    request: r.request,
    state: r.state,
    label: friendlyRunState(r.state),
    errorCode: r.errorCode,
    quota: isQuotaErrorCode(r.errorCode),
    resultText: safeRunResult(r.result).slice(0, 4000) || null,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  }))
  return NextResponse.json({ project, messages, poskliVersionDefault: normalizeVersion(STUDIO_CONFIG.router.poskliVersion) })
}

/**
 * GET /api/chat?run=:id — STREAM SSE de progresso em tempo real.
 * Eventos: state | thinking | activity | question | quota | result | done.
 * Seguro para desconectar/reconectar a qualquer momento (o run
 * continua via after(); o stream é somente-leitura).
 */
async function streamRunEvents(req: Request, runId: string, userId: string) {
  const run = await ownedRun(runId, userId)
  if (!run) return NextResponse.json({ error: 'RUN_NÃO_ENCONTRADO' }, { status: 404 })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (payload: string) => {
        if (closed) return
        try { controller.enqueue(encoder.encode(payload)) } catch { closed = true }
      }

      let lastState = ''
      let questionSent = ''
      let planSent = false
      const sentTasks = new Map<string, string>()
      const sentActivity = new Map<string, string>()
      const deadline = Date.now() + STREAM_TIMEOUT_MS

      try {
        while (Date.now() < deadline && !closed) {
          if (req.signal.aborted) break
          const current = await ownedRun(runId, userId)
          if (!current) break

          // ---- estado (frase natural — sem rótulos de estágio) ----
          if (current.state !== lastState) {
            lastState = current.state
            send(encodeSseEvent({ type: 'state', state: current.state, label: friendlyRunState(current.state) }))
          }

          // ---- ações do agente (atividade ao vivo) ----
          // NOTA: ToolCall.runId é o run do AGENTE — o canal correto
          // para o run Poskli é (projectId, createdAt >= startedAt)
          // (mesma consulta do painel provado em produção)
          const rows = await db.toolCall.findMany({
            where: { projectId: current.projectId, createdAt: { gte: current.startedAt } },
            orderBy: { createdAt: 'asc' },
            take: 40,
            select: { id: true, tool: true, status: true, createdAt: true, durationMs: true, args: true },
          }).catch(() => [] as Array<{ id: string; tool: string; status: string; createdAt: Date; durationMs: number; args: unknown }>)

          // ---- FASE VISÍVEL: plano (passos) assim que persiste ----
          if (!planSent && !isThinkingState(current.state)) {
            const plan = current.plan as { tasks?: Array<{ title?: unknown; agentRole?: unknown }>; architecture?: unknown } | null
            const planTasks = Array.isArray(plan?.tasks) ? (plan?.tasks ?? []) : []
            if (planTasks.length > 0) {
              planSent = true
              send(encodeSseEvent({
                type: 'plan',
                steps: planTasks.slice(0, 8).map((t) => ({
                  title: typeof t?.title === 'string' ? t.title : String(t?.title ?? ''),
                  agent: chatAgentLabel(typeof t?.agentRole === 'string' ? t.agentRole : 'coding'),
                })),
                ...(typeof plan?.architecture === 'string' && plan.architecture
                  ? { architecture: plan.architecture }
                  : {}),
              }))
            }
          }

          // ---- FASE VISÍVEL: delegações (tarefas do grafo do run) ----
          // escopo: tarefas criadas DEPOIS do início deste run (runs
          // anteriores no mesmo projeto não reemitem delegações)
          const taskRows = await db.task.findMany({
            where: { projectId: current.projectId, status: { not: 'CANCELLED' }, createdAt: { gte: current.startedAt } },
            orderBy: { order: 'asc' },
            take: 12,
            select: { id: true, title: true, agentRole: true, status: true },
          }).catch(() => [] as Array<{ id: string; title: string; agentRole: string; status: string }>)
          for (const t of taskRows) {
            if (sentTasks.get(t.id) === t.status) continue
            sentTasks.set(t.id, t.status)
            send(encodeSseEvent({
              type: 'delegation',
              taskId: t.id,
              title: t.title,
              agent: chatAgentLabel(t.agentRole),
              status: t.status,
            }))
          }

          for (const row of rows) {
            if (sentActivity.get(row.id) === row.status) continue
            sentActivity.set(row.id, row.status)
            const detail = argsDetail(row.args)
            send(encodeSseEvent({
              type: 'activity',
              activity: activityToChatEvent({
                id: row.id,
                tool: row.tool,
                status: row.status,
                createdAt: row.createdAt.toISOString(),
                ...detail,
              }),
            }))
          }

          // ---- "A pensar durante Xs…" + guarda de travamento ----
          // FIX: >30s de análise SEM nenhuma ação → nota honesta
          // ("Aguardando o modelo responder…") em vez de um
          // "A pensar…" mudo e infinito
          if (isThinkingState(current.state)) {
            const seconds = Math.max(1, Math.round((Date.now() - new Date(current.startedAt).getTime()) / 1000))
            const lastToolAtMs = rows.length > 0
              ? new Date(rows[rows.length - 1].createdAt).getTime()
              : null
            const stall = thinkingStallDecision({
              state: current.state,
              startedAtMs: new Date(current.startedAt).getTime(),
              lastToolAtMs,
              nowMs: Date.now(),
            })
            send(encodeSseEvent({
              type: 'thinking',
              seconds,
              ...(stall.note ? { note: stall.note } : {}),
            }))
          }

          // ---- pergunta do agente (modal bloqueante) ----
          const pending = await db.toolCall.findFirst({
            where: { tool: 'ask_user_question', status: 'PENDING', projectId: current.projectId, createdAt: { gte: current.startedAt } },
            orderBy: { createdAt: 'desc' },
          }).catch(() => null)
          if (pending && pending.id !== questionSent) {
            questionSent = pending.id
            send(encodeSseEvent({
              type: 'question',
              question: {
                toolCallId: pending.id,
                questions: ((pending.args as { questions?: unknown[] })?.questions ?? []) as unknown[],
              },
            }))
          }

          // ---- terminal: quota honesta + resultado + fim ----
          if (isChatTerminal(current.state)) {
            if (isQuotaErrorCode(current.errorCode)) {
              send(encodeSseEvent({ type: 'quota', message: QUOTA_EXHAUSTED_MESSAGE }))
            }
            const message = safeRunResult(current.result)
            if (message) send(encodeSseEvent({ type: 'result', message: message.slice(0, 6000), state: current.state }))
            send(encodeSseEvent({ type: 'done', state: current.state, summary: current.outcomeReason ?? current.error ?? undefined }))
            break
          }

          await sleep(POLL_INTERVAL_MS)
        }
      } catch {
        // erro inesperado: fecha o stream honestamente (o run continua)
      }
      try { controller.close() } catch { /* já fechado */ }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

/** Roteamento do GET: ?run= → stream SSE · ?project= → histórico. */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const url = new URL(req.url)
  const runId = url.searchParams.get('run')
  const projectId = url.searchParams.get('project')

  if (runId) return streamRunEvents(req, runId, user.id)
  if (projectId) return conversationHistory(projectId, user.id)
  return NextResponse.json({ error: 'PARÂMETRO_INVÁLIDO (use ?run= ou ?project=)' }, { status: 400 })
}
