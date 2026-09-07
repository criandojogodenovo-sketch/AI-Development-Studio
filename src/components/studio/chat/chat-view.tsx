'use client'

// ============================================================
// CHAT VIEW — interface de CHAT CONVERSACIONAL do Poskli
// ============================================================
// Reconstrução estilo Grok/ChatGPT: o utilizador escreve
// mensagens; o agente trabalha "por trás das cortinas" e o
// progresso aparece como bolhas estilizadas (Activity Log) —
// sem editor, sem terminal, sem nomes de modelos, sem rótulos
// de estágios. Editor/Terminal/Preview ficam ocultos por defeito
// (Ver Detalhes Técnicos — ver workspace-view).
//
// Fluxo:
//   1. mensagem → POST /api/chat (cria projeto AUTOMATICAMENTE
//      se necessário; contexto ambíguo → pergunta inline);
//   2. progresso em tempo real → GET /api/chat?run= (SSE);
//      fallback: polling /api/poskli/:id (mesmos eventos);
//   3. pergunta do agente → MODAL bloqueante (ask_user_question);
//   4. fim → resposta final em markdown na conversa.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStudio } from '@/hooks/use-studio'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  POSKLI_VERSION_OPTIONS, poskliVersionOption, readStoredPoskliVersion, storePoskliVersion,
} from '@/lib/poskli-version'
import {
  friendlyRunState, isThinkingState, isChatTerminal, isQuotaErrorCode,
  safeRunResult, activityToChatEvent, thinkingStallDecision, chatAgentLabel,
  type ChatStreamEvent, type ChatActivityEvent, type ChatQuestionEvent, type ChatPlanStep,
} from '@/lib/poskli-chat'
import type { ClarifyQuestion } from '@/lib/studio/projects/intent-router'
import {
  UserBubble, AgentBubble, ThinkingBubble, StatusBubble, ActivityCard, QuotaBubble, TerminalBadge, ClarifyCard,
  PlanBubble, DelegationBubble,
} from './chat-bubbles'
import {
  Brain, Send, Loader2, Square, Cpu, MessageCircleQuestion, Sparkles, Gamepad2,
  Globe, Rocket, ListTodo,
} from 'lucide-react'
import { toast } from 'sonner'

// ---------- tipos locais ----------

interface HistoryTurn {
  id: string
  request: string
  state: string
  label: string
  errorCode?: string | null
  quota: boolean
  resultText: string | null
  startedAt: string
  finishedAt?: string | null
}

interface QuestionOptionUi { label?: string; description?: string }
interface QuestionUi { header?: string; question?: string; options?: QuestionOptionUi[] }

const ACTIVE_RUN_STATES = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING']
const SUGGESTIONS = [
  { icon: Globe, text: 'Faz um site sobre gatos' },
  { icon: Gamepad2, text: 'Cria um jogo de esquivar obstáculos' },
  { icon: Rocket, text: 'Cria uma landing page para a minha loja' },
  { icon: ListTodo, text: 'Cria uma API de tarefas' },
]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Frame SSE "event: X\ndata: {...}" → evento tipado. */
function parseFrame(frame: string): ChatStreamEvent | null {
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!data) return null
  try {
    return JSON.parse(data) as ChatStreamEvent
  } catch {
    return null
  }
}

// ============================================================

export function ChatView({ projectId, prefill, onProjectCreated, onPrefillConsumed }: {
  projectId: string | null
  prefill?: string | null
  onProjectCreated?: (id: string) => void
  onPrefillConsumed?: () => void
}): React.ReactElement {
  const { api, token, refreshProjects } = useStudio()

  // conversa
  const [messages, setMessages] = useState<HistoryTurn[]>([])
  const [projectName, setProjectName] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [version, setVersion] = useState('')

  // turno ao vivo (run em progresso)
  const [liveRunId, setLiveRunId] = useState<string | null>(null)
  const [liveUserMessage, setLiveUserMessage] = useState<string | null>(null)
  /** MODO CONVERSA — turnos conversacionais (resposta direta, sem run). */
  const [convTurns, setConvTurns] = useState<Array<{ id: number; text: string; reply: string }>>([])
  const [liveState, setLiveState] = useState<{ state: string; label: string } | null>(null)
  const [thinkingSecs, setThinkingSecs] = useState(0)
  const [thinkingNote, setThinkingNote] = useState<string | undefined>(undefined)
  const [livePlan, setLivePlan] = useState<{ steps: ChatPlanStep[]; architecture?: string } | null>(null)
  const [delegations, setDelegations] = useState<Array<{ taskId: string; title: string; agent: string; status: string }>>([])
  const [activity, setActivity] = useState<ChatActivityEvent[]>([])
  const [liveResult, setLiveResult] = useState<string | null>(null)
  const [liveQuota, setLiveQuota] = useState(false)
  const [postQuota, setPostQuota] = useState(false)

  // interatividade
  const [pendingQuestion, setPendingQuestion] = useState<ChatQuestionEvent | null>(null)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [sendingAnswer, setSendingAnswer] = useState(false)
  const [clarify, setClarify] = useState<{ question: ClarifyQuestion; draft: string } | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const historyDoneRef = useRef<string | null>(null)
  const prefillConsumedRef = useRef<string | null>(null)

  // refs espelho do turno ao vivo (leituras em callbacks assíncronos)
  const liveRunIdRef = useRef<string | null>(null)
  const liveUserMsgRef = useRef<string | null>(null)
  const liveResultRef = useRef<string | null>(null)
  const liveQuotaRef = useRef(false)
  const liveStartRef = useRef<number>(0)
  const streamAbortRef = useRef<AbortController | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRetriesRef = useRef(0)

  // ---- modo (Normal/Padrão/Avançado/Superagente) ----
  useEffect(() => {
    setVersion(readStoredPoskliVersion() ?? '0.2')
  }, [])
  const changeVersion = (v: string) => {
    setVersion(v)
    storePoskliVersion(v)
    toast.success(poskliVersionOption(v) ? `Modo do agente: ${poskliVersionOption(v)!.short}` : `Modo: ${v}`)
  }

  const activeRun = liveRunId !== null

  // ---------- ciclo de vida do turno ao vivo ----------

  const resetLive = useCallback(() => {
    setLiveRunId(null)
    setLiveUserMessage(null)
    setLiveState(null)
    setThinkingSecs(0)
    setThinkingNote(undefined)
    setLivePlan(null)
    setDelegations([])
    setActivity([])
    setLiveResult(null)
    setLiveQuota(false)
    setPendingQuestion(null)
    setAnswers({})
    liveRunIdRef.current = null
    liveUserMsgRef.current = null
    liveResultRef.current = null
    liveQuotaRef.current = false
    liveStartRef.current = 0
    streamRetriesRef.current = 0
  }, [])

  const abortLive = useCallback(() => {
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  /** Fim de turno — reconcilia com o SERVIDOR (fonte da verdade):
   *  refs locais podem ter sido limpos por remount/reconexão;
   *  o histórico do run tem sempre o turno completo (pedido +
   *  resultado). Nunca constrói um turno sintético vazio. */
  const finalizeTurn = useCallback((state: string) => {
    const runId = liveRunIdRef.current
    const request = liveUserMsgRef.current ?? ''
    const result = liveResultRef.current
    resetLive()
    refreshProjects().catch(() => {})
    if (projectId) {
      // recarrega do servidor — turno real com pedido+resultado
      loadHistoryRef.current?.()
      return
    }
    // sem projeto (caso-limite): turno otimista só se for REAL
    if (runId && (request || result)) {
      setMessages((prev) => [
        ...prev,
        {
          id: runId,
          request,
          state,
          label: friendlyRunState(state),
          errorCode: null,
          quota: liveQuotaRef.current,
          resultText: result,
          startedAt: new Date(liveStartRef.current || Date.now()).toISOString(),
          finishedAt: new Date().toISOString(),
        },
      ])
    }
  }, [resetLive, refreshProjects, projectId])

  // refs de ciclo (quebram o ciclo finalize→history→follow→stream)
  const finalizeTurnRef = useRef(finalizeTurn)
  finalizeTurnRef.current = finalizeTurn
  const loadHistoryRef = useRef<(() => void) | null>(null)

  // ---------- despacho central de eventos do stream ----------

  const handleEvent = useCallback((ev: ChatStreamEvent) => {
    switch (ev.type) {
      case 'state':
        setLiveState({ state: ev.state, label: ev.label })
        break
      case 'thinking':
        setThinkingSecs(ev.seconds)
        setThinkingNote(ev.note)
        break
      case 'plan':
        setLivePlan((prev) => prev ?? { steps: ev.steps, architecture: ev.architecture })
        break
      case 'delegation':
        setDelegations((prev) => {
          const map = new Map(prev.map((d) => [d.taskId, d]))
          map.set(ev.taskId, { taskId: ev.taskId, title: ev.title, agent: ev.agent, status: ev.status })
          return [...map.values()]
        })
        break
      case 'activity':
        setActivity((prev) => {
          const map = new Map(prev.map((a) => [a.id, a]))
          map.set(ev.activity.id, ev.activity)
          return [...map.values()]
        })
        break
      case 'question':
        setPendingQuestion(ev.question)
        break
      case 'quota':
        setLiveQuota(true)
        liveQuotaRef.current = true
        break
      case 'result':
        setLiveResult(ev.message)
        liveResultRef.current = ev.message
        break
      case 'done':
        finalizeTurnRef.current(ev.state)
        break
    }
  }, [])

  // ---------- stream SSE (com reconexão e fallback) ----------

  const startPolling = useCallback((runId: string) => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    pollTimerRef.current = setInterval(async () => {
      if (liveRunIdRef.current !== runId) return
      try {
        const d = await api<{
          run: {
            state: string; errorCode?: string | null; result?: unknown; startedAt: string
            plan?: { architecture?: unknown; tasks?: Array<{ title?: unknown; agentRole?: unknown }> } | null
          }
          activity: Array<{ id: string; tool: string; status: string; createdAt: string; args?: Record<string, unknown> | null }>
          tasks?: Array<{ id: string; title: string; agentRole: string; status: string; createdAt: string }>
          pendingQuestion?: { toolCallId: string; questions: unknown[] } | null
        }>(`/api/poskli/${runId}`)
        if (liveRunIdRef.current !== runId) return
        handleEvent({ type: 'state', state: d.run.state, label: friendlyRunState(d.run.state) })
        // FASES VISÍVEIS no fallback polling (mesmos eventos do SSE):
        // plano persistido + delegações das tarefas deste run
        if (!isThinkingState(d.run.state) && Array.isArray(d.run.plan?.tasks) && (d.run.plan?.tasks?.length ?? 0) > 0) {
          handleEvent({
            type: 'plan',
            steps: (d.run.plan?.tasks ?? []).slice(0, 8).map((t) => ({
              title: typeof t?.title === 'string' ? t.title : String(t?.title ?? ''),
              agent: chatAgentLabel(typeof t?.agentRole === 'string' ? t.agentRole : 'coding'),
            })),
            ...(typeof d.run.plan?.architecture === 'string' && d.run.plan.architecture
              ? { architecture: d.run.plan.architecture }
              : {}),
          })
        }
        for (const t of d.tasks ?? []) {
          if (t.status === 'CANCELLED') continue
          // escopo do run: tarefas criadas APÓS o início deste run
          if (new Date(t.createdAt).getTime() < new Date(d.run.startedAt).getTime() - 5_000) continue
          handleEvent({ type: 'delegation', taskId: t.id, title: t.title, agent: chatAgentLabel(t.agentRole), status: t.status })
        }
        if (isThinkingState(d.run.state)) {
          const seconds = Math.max(1, Math.round((Date.now() - new Date(d.run.startedAt).getTime()) / 1000))
          // guarda de travamento no fallback (mesma lógica do SSE)
          const lastRow = [...(d.activity ?? [])].pop()
          const stall = thinkingStallDecision({
            state: d.run.state,
            startedAtMs: new Date(d.run.startedAt).getTime(),
            lastToolAtMs: lastRow ? new Date(lastRow.createdAt).getTime() : null,
            nowMs: Date.now(),
          })
          handleEvent({ type: 'thinking', seconds, ...(stall.note ? { note: stall.note } : {}) })
        }
        const rows = [...(d.activity ?? [])].reverse()
        for (const row of rows) {
          handleEvent({
            type: 'activity',
            activity: activityToChatEvent({
              id: row.id,
              tool: row.tool,
              status: row.status,
              createdAt: row.createdAt,
              path: typeof row.args?.path === 'string' ? row.args.path : undefined,
              command: typeof row.args?.command === 'string' ? row.args.command : undefined,
              query: typeof row.args?.query === 'string' ? row.args.query : undefined,
            }),
          })
        }
        if (d.pendingQuestion) {
          handleEvent({ type: 'question', question: d.pendingQuestion })
        }
        if (isChatTerminal(d.run.state)) {
          if (isQuotaErrorCode(d.run.errorCode)) handleEvent({ type: 'quota', message: '' })
          const msg = safeRunResult(d.run.result)
          if (msg) handleEvent({ type: 'result', message: msg, state: d.run.state })
          handleEvent({ type: 'done', state: d.run.state })
          if (pollTimerRef.current) clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
      } catch {
        /* transient — o próximo tick tenta de novo */
      }
    }, 3_000)
  }, [api, handleEvent])

  const openStream = useCallback(async (runId: string) => {
    abortLive()
    const ac = new AbortController()
    streamAbortRef.current = ac
    try {
      const headers: Record<string, string> = { accept: 'text/event-stream' }
      if (token) headers.authorization = `Bearer ${token}`
      const res = await fetch(`/api/chat?run=${runId}`, { headers, signal: ac.signal })
      if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        throw new Error('stream indisponível')
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let sawDone = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const frames = buf.split('\n\n')
        buf = frames.pop() ?? ''
        for (const frame of frames) {
          const ev = parseFrame(frame)
          if (ev) {
            if (ev.type === 'done') sawDone = true
            handleEvent(ev)
          }
        }
      }
      if (!sawDone && !ac.signal.aborted && liveRunIdRef.current === runId) {
        // a rede caiu a meio — o run CONTINUA no servidor (after()):
        // reconecta o stream; retentativas esgotadas → POLLING
        // contínuo até o terminal (runs longos > 240s do stream)
        streamRetriesRef.current += 1
        if (streamRetriesRef.current <= 5) {
          await sleep(2_000)
          if (liveRunIdRef.current === runId && !ac.signal.aborted) {
            void openStream(runId)
          }
        } else {
          startPolling(runId)
        }
      }
    } catch {
      if (ac.signal.aborted) return
      // fallback honesto: mesmos eventos via polling do detalhe
      startPolling(runId)
    }
  }, [abortLive, handleEvent, startPolling, token])

  /** Segue um run ativo (ex.: recarregou a página a meio). */
  const followRun = useCallback((runId: string, request: string, startedAt?: string) => {
    setLiveRunId(runId)
    liveRunIdRef.current = runId
    setLiveUserMessage(request)
    liveUserMsgRef.current = request
    liveStartRef.current = startedAt ? new Date(startedAt).getTime() : Date.now()
    void openStream(runId)
  }, [openStream])

  // ---------- histórico da conversa ----------

  const loadHistory = useCallback(async () => {
    if (!projectId) {
      setMessages([])
      setProjectName(null)
      historyDoneRef.current = null
      return
    }
    try {
      const d = await api<{
        project: { id: string; name: string; type: string; status: string }
        messages: HistoryTurn[]
      }>(`/api/chat?project=${projectId}`)
      setProjectName(d.project.name)
      const msgs = d.messages ?? []
      // run ativo (recarregou a meio) → vira o turno ao vivo
      const last = msgs[msgs.length - 1]
      const active = last && ACTIVE_RUN_STATES.includes(last.state) ? last : null
      setMessages(active ? msgs.slice(0, -1) : msgs)
      historyDoneRef.current = projectId
      if (active && liveRunIdRef.current !== active.id) {
        resetLive()
        followRun(active.id, active.request, active.startedAt)
      } else if (!active && !liveRunIdRef.current) {
        resetLive()
      }
    } catch {
      /* silencioso */
    }
  }, [api, projectId, followRun, resetLive])
  // liga o ref usado por finalizeTurn (reconciliação pós-done)
  loadHistoryRef.current = () => { void loadHistory() }

  useEffect(() => {
    abortLive()
    resetLive()
    setConvTurns([])
    loadHistory()
    return () => {
      abortLive()
    }
  }, [projectId])

  // ---------- envio de mensagens ----------

  const postChat = useCallback(
    async (payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (token) headers.authorization = `Bearer ${token}`
      const res = await fetch('/api/chat', { method: 'POST', headers, body: JSON.stringify(payload) })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return { ok: res.ok, status: res.status, data }
    },
    [token]
  )

  /** Responde à pergunta de clarificação (tipo de projeto). */
  const answerClarify = useCallback(async (answer: string) => {
    if (!clarify) return
    const draft = clarify.draft
    setClarify(null)
    setInput('')
    setSending(true)
    try {
      const { ok, status, data } = await postChat({
        message: draft,
        resolvedType: answer,
        poskliVersion: version || undefined,
      })
      if (!ok && (status === 429 || data.quota)) {
        setPostQuota(true)
        return
      }
      if (!ok) {
        toast.error(String(data.error ?? 'FALHA ao criar o projeto'))
        return
      }
      resetLive()
      const runId = String(data.runId)
      setLiveRunId(runId)
      liveRunIdRef.current = runId
      setLiveUserMessage(draft)
      liveUserMsgRef.current = draft
      liveStartRef.current = Date.now()
      if (typeof data.projectId === 'string') onProjectCreated?.(data.projectId)
      void openStream(runId)
    } catch {
      toast.error('Rede indisponível — tente novamente')
    } finally {
      setSending(false)
    }
  }, [clarify, postChat, version, resetLive, openStream, onProjectCreated])

  const doSend = useCallback(async (textArg?: string) => {
    const text = (textArg ?? input).trim()
    if (text.length < 5) {
      if (text.length > 0) toast.error('Descreva um pouco mais o que deseja (mín 5 caracteres)')
      return
    }
    if (liveRunIdRef.current) return
    // resposta livre à pergunta de clarificação pendente
    if (clarify) {
      void answerClarify(text)
      return
    }
    setSending(true)
    setPostQuota(false)
    try {
      const { ok, status, data } = await postChat({
        message: text,
        projectId: projectId ?? undefined,
        poskliVersion: version || undefined,
      })
      if (data.needsClarification) {
        // contexto ambíguo → o agente PERGUNTA antes de criar
        setClarify({ question: data.question as ClarifyQuestion, draft: text })
        setInput('')
        return
      }
      // MODO CONVERSA — resposta direta do agente (sem run/projeto)
      if (data.conversation && typeof data.reply === 'string') {
        setInput('')
        setClarify(null)
        setConvTurns((prev) => [...prev, { id: Date.now(), text, reply: data.reply as string }])
        return
      }
      if (!ok) {
        if (status === 429 || data.quota) {
          setPostQuota(true)
          return
        }
        if (status === 409 && typeof data.runId === 'string') {
          toast.info('O agente ainda está a trabalhar nesta conversa — mostrando o progresso')
          setInput('')
          followRun(data.runId, text)
          return
        }
        toast.error(String(data.error ?? 'FALHA ao enviar a mensagem'))
        return
      }
      // 202 — run iniciado
      setInput('')
      setClarify(null)
      resetLive()
      const runId = String(data.runId)
      setLiveRunId(runId)
      liveRunIdRef.current = runId
      setLiveUserMessage(text)
      liveUserMsgRef.current = text
      liveStartRef.current = Date.now()
      if (!projectId && typeof data.projectId === 'string') {
        onProjectCreated?.(data.projectId)
      }
      void openStream(runId)
    } catch {
      toast.error('Rede indisponível — tente novamente')
    } finally {
      setSending(false)
    }
  }, [input, projectId, version, clarify, postChat, resetLive, followRun, openStream, onProjectCreated, answerClarify])

  // ---------- resposta à pergunta do agente (modal) ----------

  const submitAnswer = useCallback(async () => {
    if (!pendingQuestion || !liveRunId) return
    const filled = (pendingQuestion.questions as QuestionUi[])
      .map((q, i) => ({ header: q.header, answer: (answers[i] ?? '').trim() }))
      .filter((a) => a.answer.length > 0)
    if (filled.length === 0) {
      toast.error('Escolha uma opção ou escreva uma resposta')
      return
    }
    setSendingAnswer(true)
    try {
      await api(`/api/poskli/${liveRunId}/answer`, {
        method: 'POST',
        body: JSON.stringify({ toolCallId: pendingQuestion.toolCallId, answers: filled }),
      })
      toast.success('Resposta enviada — o agente retomou o trabalho')
      setPendingQuestion(null)
      setAnswers({})
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSendingAnswer(false)
    }
  }, [api, pendingQuestion, liveRunId, answers])

  const cancelRun = useCallback(async () => {
    if (!liveRunId) return
    try {
      await api(`/api/poskli/${liveRunId}`, { method: 'DELETE' })
      toast.success('Cancelamento solicitado — o agente para no próximo passo')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [api, liveRunId])

  // ---------- prefill (sugestões do painel inicial) ----------

  useEffect(() => {
    if (!prefill) return
    if (prefillConsumedRef.current === prefill) return
    if (liveRunIdRef.current) return
    prefillConsumedRef.current = prefill
    setInput(prefill)
    onPrefillConsumed?.()
    const t = setTimeout(() => { void doSend(prefill) }, 200)
    return () => clearTimeout(t)
  }, [prefill])

  // ---------- scroll automático ----------

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [activity.length, liveResult, liveState?.label, messages.length, thinkingSecs, thinkingNote, livePlan, delegations.length, clarify, convTurns.length])

  const emptyConversation = !projectId && messages.length === 0 && !liveRunId && !clarify && convTurns.length === 0

  const sendDisabled = sending || activeRun || input.trim().length === 0

  const statusHint = useMemo(() => {
    if (activeRun && liveState) return liveState.label
    if (sending) return 'A enviar…'
    return 'Enter envia · Shift+Enter nova linha'
  }, [activeRun, liveState, sending])

  // ============================================================

  return (
    <div className="flex flex-col h-full min-h-0 bg-zinc-950">
      {/* ---- mensagens (coluna central estilo chat) ---- */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl mx-auto w-full px-3 py-4 space-y-4">

          {/* estado vazio — saudação + sugestões */}
          {emptyConversation && (
            <div className="py-10 text-center space-y-5">
              <span className="inline-flex w-14 h-14 rounded-2xl bg-emerald-600/15 border border-emerald-800/60 items-center justify-center">
                <Sparkles className="w-7 h-7 text-emerald-400" />
              </span>
              <div className="space-y-1.5">
                <h2 className="text-xl font-bold text-zinc-100">Em que posso ajudar hoje?</h2>
                <p className="text-[13px] text-zinc-500 max-w-md mx-auto">
                  Descreva o que quer construir — eu crio o projeto automaticamente,
                  escrevo o código e testo tudo antes de entregar.
                </p>
              </div>
              <div className="grid sm:grid-cols-2 gap-2 max-w-lg mx-auto text-left">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.text}
                    onClick={() => { setInput(s.text); scrollRef.current?.focus?.() }}
                    className="flex items-center gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3.5 py-2.5 text-[12.5px] text-zinc-300 hover:border-emerald-700/50 hover:text-emerald-300 transition-colors"
                  >
                    <s.icon className="w-4 h-4 text-zinc-500 shrink-0" />
                    {s.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* contexto de projeto (conversa existente) */}
          {projectName && messages.length === 0 && !liveRunId && (
            <p className="text-center text-[12px] text-zinc-500 py-6">
              Conversa do projeto <span className="text-zinc-300 font-medium">{projectName}</span> — continue de onde parou ou peça algo novo.
            </p>
          )}

          {/* histórico (turnos concluídos) */}
          {messages.map((m) => (
            <div key={m.id} className="space-y-2">
              <UserBubble text={m.request} />
              {m.quota && <QuotaBubble />}
              {m.resultText && <AgentBubble markdown={m.resultText} />}
              <TerminalBadge
                state={m.state}
                label={m.label}
                durationMs={m.finishedAt && m.startedAt ? Date.parse(m.finishedAt) - Date.parse(m.startedAt) : undefined}
              />
            </div>
          ))}

          {/* MODO CONVERSA — turnos conversacionais (resposta direta) */}
          {!activeRun && convTurns.map((t) => (
            <div key={t.id} className="space-y-2">
              <UserBubble text={t.text} />
              <AgentBubble markdown={t.reply} />
            </div>
          ))}

          {/* turno ao vivo — FASES VISÍVEIS: análise → plano → delegação → ações */}
          {activeRun && (
            <div className="space-y-2">
              <UserBubble text={liveUserMessage ?? ''} />
              {liveState && isThinkingState(liveState.state) && (
                <ThinkingBubble seconds={thinkingSecs} note={thinkingNote} />
              )}
              {liveState && !isThinkingState(liveState.state) && !livePlan && delegations.length === 0 && activity.length === 0 && (
                <StatusBubble label={liveState.label} />
              )}
              {livePlan && <PlanBubble steps={livePlan.steps} architecture={livePlan.architecture} />}
              {delegations.map((d) => (
                <DelegationBubble key={d.taskId} title={d.title} agent={d.agent} status={d.status} />
              ))}
              {activity.length > 0 && <ActivityCard entries={activity} running />}
              {liveQuota && <QuotaBubble />}
              {liveResult && <AgentBubble markdown={liveResult} />}
            </div>
          )}

          {/* cota esgotada no envio (429 honesto) */}
          {postQuota && !activeRun && <QuotaBubble />}

          {/* pergunta de clarificação (tipo de projeto) */}
          {clarify && (
            <ClarifyCard
              question={clarify.question}
              onAnswer={(a) => { void answerClarify(a) }}
              onDismiss={() => setClarify(null)}
              busy={sending}
            />
          )}
        </div>
      </div>

      {/* ---- entrada de mensagem (topo/centro do fluxo) ---- */}
      <div className="border-t border-zinc-800/60 bg-zinc-950/95 shrink-0 p-3">
        <div className="max-w-3xl mx-auto w-full space-y-2">
          {/* modo do agente (nunca nomes de modelos) */}
          <div className="flex items-center gap-2">
            <Cpu className="w-3 h-3 text-zinc-500 shrink-0" aria-hidden />
            <Select value={version || '0.2'} onValueChange={changeVersion} disabled={activeRun || sending}>
              <SelectTrigger
                size="sm"
                aria-label="Modo do agente"
                title={poskliVersionOption(version)?.description ?? 'Modo do agente'}
                className="h-7 w-44 text-[11px] font-medium bg-zinc-900/70 border-zinc-800 text-zinc-300 hover:bg-zinc-900 focus-visible:ring-0 data-[size=sm]:h-7"
              >
                <SelectValue placeholder="modo do agente…" />
              </SelectTrigger>
              <SelectContent className="bg-zinc-900 border-zinc-800">
                {POSKLI_VERSION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-[11px] py-1.5 focus:bg-zinc-800">
                    <span className="flex items-center gap-2">
                      <span className={opt.highlight ? 'text-violet-300' : 'text-zinc-200'}>{opt.short}</span>
                      <span className="text-zinc-500">{opt.detail}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className={`ml-auto text-[10px] truncate ${activeRun ? 'text-emerald-400/90' : 'text-zinc-600'}`}>
              {activeRun ? <Loader2 className="w-3 h-3 animate-spin inline mr-1" /> : null}
              {statusHint}
            </span>
          </div>

          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !activeRun) {
                  e.preventDefault()
                  void doSend()
                }
              }}
              rows={2}
              disabled={activeRun}
              placeholder={
                activeRun
                  ? 'O agente está a trabalhar — aguarde ou pare a execução…'
                  : projectId
                    ? 'Peça o próximo passo — "corrige o bug de colisão", "adiciona um menu inicial"…'
                    : 'Peça qualquer coisa — "Cria uma landing page para a minha loja"…'
              }
              className="flex-1 bg-zinc-900/70 border border-zinc-800 rounded-xl px-3 py-2.5 text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-800 resize-none disabled:opacity-50"
            />
            {activeRun ? (
              <Button
                onClick={cancelRun}
                size="sm"
                variant="outline"
                title="parar o agente"
                className="h-10 shrink-0 border-red-900/60 text-red-400 hover:bg-red-950/40 hover:text-red-300"
              >
                <Square className="w-3.5 h-3.5" /> parar
              </Button>
            ) : (
              <Button
                onClick={() => { void doSend() }}
                disabled={sendDisabled}
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-500 h-10 shrink-0"
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ---- MODAL: pergunta do agente ao utilizador ---- */}
      {pendingQuestion && activeRun && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-amber-900/50 bg-zinc-950 shadow-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center gap-2.5 p-4 border-b border-zinc-800/60">
              <span className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-800/60 flex items-center justify-center shrink-0">
                <MessageCircleQuestion className="w-4 h-4 text-amber-400" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-zinc-100">O agente precisa de você</p>
                <p className="text-[10px] text-zinc-500">O trabalho pausou para ouvir a sua decisão</p>
              </div>
            </div>

            <div className="p-4 space-y-4">
              {(pendingQuestion.questions as QuestionUi[]).map((q, qi) => (
                <div key={qi} className="space-y-1.5">
                  {q.header && <p className="text-[10px] uppercase tracking-wider text-amber-500/80">{q.header}</p>}
                  <p className="text-[12.5px] text-zinc-200 font-medium break-words">{q.question}</p>
                  <div className="flex flex-col gap-1.5 pt-0.5">
                    {(q.options ?? []).map((opt, oi) => {
                      const selected = answers[qi] === opt.label
                      return (
                        <button
                          key={oi}
                          onClick={() => setAnswers((prev) => ({ ...prev, [qi]: String(opt.label ?? '') }))}
                          className={`text-left px-3 py-2 rounded-lg border text-[11.5px] transition-colors ${
                            selected
                              ? 'bg-amber-500/15 border-amber-600/60 text-amber-200'
                              : 'bg-zinc-900/60 border-zinc-800 text-zinc-300 hover:bg-zinc-900 hover:border-zinc-700'
                          }`}
                        >
                          <span className="font-medium">{opt.label}</span>
                          {opt.description && <span className="block text-[10px] text-zinc-500 mt-0.5">{opt.description}</span>}
                        </button>
                      )
                    })}
                    <input
                      value={answers[qi] && (q.options ?? []).every((o) => o.label !== answers[qi]) ? answers[qi] : ''}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [qi]: e.target.value.slice(0, 400) }))}
                      placeholder="ou escreva a resposta (tokens/chaves também)…"
                      className="bg-zinc-900/60 border border-zinc-800 rounded-lg px-3 py-2 text-[11.5px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-800/60"
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="p-4 pt-0 flex items-center gap-2">
              <Button
                onClick={() => { void submitAnswer() }}
                disabled={sendingAnswer || !(pendingQuestion.questions as QuestionUi[]).some((_, i) => (answers[i] ?? '').trim().length > 0)}
                className="bg-amber-600 hover:bg-amber-500 h-8 flex-1"
                size="sm"
              >
                {sendingAnswer ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                Enviar resposta
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
