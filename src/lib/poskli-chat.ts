// ============================================================
// POSKLI CHAT (PURO, client-safe) — eventos do chat conversacional
// ============================================================
// Reconstrução conversacional (estilo Grok/ChatGPT): o painel
// principal NÃO mostra rótulos de estágios ("IMPLEMENTANDO",
// "REVISANDO", "CORRIGINDO", "VERIFICANDO") nem terminal/código.
// Em vez disso, o estado do run e as ações das ferramentas são
// traduzidos para uma conversa natural:
//   "A analisar o pedido…"  →  "A escrever código…"  →
//   "A criar arquivo src/index.html…"  →  "A executar testes…"
//
// Este módulo é a FONTE ÚNICA da tradução, usada por:
//   - GET /api/chat (SSE no servidor): emite os eventos
//   - fallback do cliente (polling /api/poskli/:id): deriva os
//     MESMOS eventos localmente — UX idêntica sem WebSocket.
// Puro (importa apenas poskli-activity, também puro) → testável.
// ============================================================

import { translateActivity, type ActivityEntry } from './poskli-activity.ts'

// ---------- rótulos naturais (sem nomes de estágios) ----------

const NATURAL_STATE_LABELS: Record<string, string> = {
  ANALYZING: 'A analisar o pedido…',
  PLANNING: 'A planear o trabalho…',
  IMPLEMENTING: 'A escrever código…',
  TESTING: 'A executar testes…',
  VERIFYING: 'A verificar o resultado…',
  // compat. de runs antigos — linguagem natural, nunca "Revisando/Corrigindo"
  REVIEWING: 'A melhorar o código…',
  CORRECTING: 'A melhorar o código…',
  PENDING: 'A preparar…',
  RUNNING: 'A trabalhar…',
  COMPLETED: 'Concluído',
  FAILED: 'Não consegui concluir',
  BLOCKED: 'Bloqueado',
  PARTIAL: 'Concluído parcialmente',
  CANCELLED: 'Cancelado',
  SUCCESS: 'Concluído',
}

/** Estado do run → frase natural do agente (nunca rótulo de estágio). */
export function friendlyRunState(state: string): string {
  return NATURAL_STATE_LABELS[state] ?? 'A trabalhar…'
}

/** Estados terminais do run (a conversa desta mensagem termina). */
export const CHAT_TERMINAL_STATES: readonly string[] = [
  'COMPLETED', 'FAILED', 'BLOCKED', 'PARTIAL', 'CANCELLED',
] as const

export function isChatTerminal(state: string): boolean {
  return (CHAT_TERMINAL_STATES as readonly string[]).includes(state)
}

/** Estados "de pensamento" — exibem "A pensar durante Xs…". */
export function isThinkingState(state: string): boolean {
  return state === 'ANALYZING' || state === 'PLANNING'
}

// ---------- guarda de travamento (FIX: "A pensar durante 45s…") ----------

/** Limite (ms) sem NENHUMA ação de ferramenta em estado de
 *  pensamento antes de avisar honestamente o utilizador. */
export const THINKING_STALL_WARN_MS = 30_000

/** Nota honesta exibida quando o agente está à espera do modelo
 *  (em vez de um "A pensar…" infinito sem explicação). */
export const THINKING_STALL_NOTE =
  'Aguardando o modelo responder… o agente continua a trabalhar (não travou)'

export interface ThinkingStallInput {
  state: string
  /** início do run (ms epoch). */
  startedAtMs: number
  /** última tool call (ms epoch) — null quando ainda não houve. */
  lastToolAtMs: number | null
  nowMs: number
  /** personalizado p/ testes (default THINKING_STALL_WARN_MS). */
  warnAfterMs?: number
}

export interface ThinkingStallDecision {
  stalled: boolean
  /** nota honesta quando stalled. */
  note?: string
}

/**
 * Guarda pura do estado de pensamento: estado de análise sem
 * QUALQUER ação de ferramenta por > warnAfterMs → aviso honesto
 * (o utilizador nunca fica a olhar para um "A pensar…" sem fim
 * sem saber o que acontece). Não altera o run — apenas UX.
 */
export function thinkingStallDecision(p: ThinkingStallInput): ThinkingStallDecision {
  if (!isThinkingState(p.state)) return { stalled: false }
  const since = p.lastToolAtMs !== null ? p.nowMs - p.lastToolAtMs : p.nowMs - p.startedAtMs
  const limit = p.warnAfterMs ?? THINKING_STALL_WARN_MS
  if (since > limit) return { stalled: true, note: THINKING_STALL_NOTE }
  return { stalled: false }
}

// ---------- acesso ao painel técnico (laboratório) ----------

/**
 * Visibilidade do acesso técnico ("Ver Detalhes Técnicos"):
 * OCULTO por defeito; visível SOMENTE durante um run ativo
 * (ou quando já está aberto, para o utilizador poder fechá-lo).
 * Fora da execução a interface fica 100% limpa — apenas chat.
 */
export function techAccessVisible(p: { runActive: boolean; techOpen: boolean }): boolean {
  return p.runActive || p.techOpen
}

// ---------- quota (429 honesto, sem loops) ----------

/** Mensagem exata do produto quando a cota acaba (STOP imediato). */
export const QUOTA_EXHAUSTED_MESSAGE = 'A cota do modelo acabou. A mudar para o modelo reserva…'

/** errorCode do run que significa "cota/limite do provedor". */
export function isQuotaErrorCode(code?: string | null): boolean {
  return code === 'QUOTA_EXHAUSTED' || code === 'PROVIDER_RATE_LIMIT'
}

// ---------- serialização defensiva do resultado ----------

/** Extrai STRING do resultado (coluna Json no DB: {output: "..."}). */
export function safeRunResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result === null || result === undefined) return ''
  if (typeof result === 'object') {
    const o = result as { output?: unknown; result?: unknown; message?: unknown }
    if (typeof o.output === 'string') return o.output
    if (typeof o.result === 'string') return o.result
    if (typeof o.message === 'string') return o.message
    try { return JSON.stringify(result) } catch { return '' }
  }
  return String(result)
}

// ---------- eventos do stream de chat ----------

export interface ChatActivityEvent {
  id: string
  tool: string
  label: string
  detail?: string
  status: string
  running: boolean
  failed: boolean
}

export interface ChatQuestionEvent {
  toolCallId: string
  questions: unknown[]
}

/** Passo do plano visível no chat (após a fase de análise). */
export interface ChatPlanStep {
  title: string
  /** label de produto do subagente ("agente de programação"). */
  agent: string
}

export type ChatStreamEvent =
  | { type: 'state'; state: string; label: string }
  | { type: 'thinking'; seconds: number; note?: string }
  | { type: 'plan'; steps: ChatPlanStep[]; architecture?: string }
  | { type: 'delegation'; taskId: string; title: string; agent: string; status: string }
  | { type: 'activity'; activity: ChatActivityEvent }
  | { type: 'question'; question: ChatQuestionEvent }
  | { type: 'quota'; message: string }
  | { type: 'result'; message: string; state: string }
  | { type: 'done'; state: string; summary?: string }

/** Snapshot mínimo consumido pela derivação (servidor OU cliente). */
export interface ChatRunSnapshot {
  run: {
    id: string
    state: string
    errorCode?: string | null
    error?: string | null
    result?: unknown
    outcomeReason?: string | null
    finishedAt?: string | Date | null
  }
  activity: Array<ActivityEntry & { id: string }>
  pendingQuestion: ChatQuestionEvent | null
  /** FASES VISÍVEIS: plano persistido do run (após PLANNING). */
  plan?: ChatPlanSnapshot | null
  /** FASES VISÍVEIS: tarefas delegadas (grafo do run). */
  tasks?: ChatTaskSnapshot[]
}

export interface ChatPlanSnapshot {
  architecture?: string
  tasks?: Array<{ title?: unknown; agentRole?: unknown }>
}

export interface ChatTaskSnapshot {
  id: string
  title: string
  agentRole: string
  status: string
}

/** Traduz uma linha de atividade (ToolCall) para evento de chat. */
export function activityToChatEvent(entry: ActivityEntry & { id: string }): ChatActivityEvent {
  const item = translateActivity(entry)
  return {
    id: entry.id,
    tool: entry.tool,
    label: item.label,
    detail: item.detail,
    status: entry.status,
    running: item.running,
    failed: item.failed,
  }
}

/** Label de produto do subagente por agentRole (sem nomes técnicos). */
const AGENT_LABELS: Record<string, string> = {
  coding: 'agente de programação',
  testing: 'agente de testes',
  review: 'agente de revisão',
  github: 'agente de publicação',
  master: 'orquestrador',
}

export function chatAgentLabel(role: string): string {
  return AGENT_LABELS[(role ?? '').toLowerCase()] ?? 'agente especializado'
}

/** Extrai o título em texto de uma task do plano (defensivo). */
function planTitleOf(t: { title?: unknown; agentRole?: unknown }): string {
  return typeof t.title === 'string' ? t.title : String(t.title ?? '')
}

/**
 * Deriva os eventos de chat de um snapshot do run — IDEMPOTENTE:
 * dado o mesmo snapshot, os mesmos eventos (o cliente/SSE pode
 * reprocessar sem duplicar: `activity.id` é a chave).
 * FASES VISÍVEIS (refactor da delegação):
 *   1. estado ("A analisar o pedido…")
 *   2. plano com passos numerados (assim que PLANNING persiste)
 *   3. delegações ("A delegar «X» ao agente de programação…")
 *   4. ações (tool calls) · 5. pergunta · 6. terminal
 */
export function deriveChatEvents(snapshot: ChatRunSnapshot): ChatStreamEvent[] {
  const events: ChatStreamEvent[] = []
  const { run } = snapshot

  // 1) estado atual (frase natural)
  events.push({ type: 'state', state: run.state, label: friendlyRunState(run.state) })

  // 2) FASE VISÍVEL: plano (passos numerados) — emitido quando o
  //    run já passou por PLANNING e persistiu o plano
  const planTasks = snapshot.plan?.tasks ?? []
  if (planTasks.length > 0 && !isThinkingState(run.state)) {
    events.push({
      type: 'plan',
      steps: planTasks.slice(0, 8).map((t) => ({
        title: planTitleOf(t),
        agent: chatAgentLabel(typeof t.agentRole === 'string' ? t.agentRole : 'coding'),
      })),
      ...(typeof snapshot.plan?.architecture === 'string' && snapshot.plan.architecture
        ? { architecture: snapshot.plan.architecture }
        : {}),
    })
  }

  // 3) FASE VISÍVEL: delegações por tarefa (idempotente por taskId)
  for (const t of snapshot.tasks ?? []) {
    events.push({
      type: 'delegation',
      taskId: t.id,
      title: t.title,
      agent: chatAgentLabel(t.agentRole),
      status: t.status,
    })
  }

  // 4) ações do agente (em ORDEM — conversa)
  for (const entry of snapshot.activity) {
    events.push({ type: 'activity', activity: activityToChatEvent(entry) })
  }

  // 5) pergunta pendente → modal
  if (snapshot.pendingQuestion) {
    events.push({ type: 'question', question: snapshot.pendingQuestion })
  }

  // 6) terminal → quota | resultado + fim
  if (isChatTerminal(run.state)) {
    if (isQuotaErrorCode(run.errorCode)) {
      events.push({ type: 'quota', message: QUOTA_EXHAUSTED_MESSAGE })
    }
    const message = safeRunResult(run.result)
    if (message) events.push({ type: 'result', message, state: run.state })
    events.push({ type: 'done', state: run.state, summary: run.outcomeReason ?? run.error ?? undefined })
  }

  return events
}

/** Serializa um evento no formato SSE (`event:` + `data:`). */
export function encodeSseEvent(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/** true se a label é amigável: sem modelos técnicos E sem rótulos de estágio. */
export function isFriendlyChatLabel(label: string): boolean {
  const technical = /(glm|qwen|hy3|nemotron|deepseek|gpt|luna|nvidia|b\.ai|provider)/i
  const stageLabels = /(IMPLEMENTANDO|REVISANDO|CORRIGINDO|VERIFICANDO|ANALISANDO|PLANEJANDO|TESTANDO)/i
  return label.length > 0 && !technical.test(label) && !stageLabels.test(label)
}
