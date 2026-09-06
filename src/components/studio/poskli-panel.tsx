'use client'

// ============================================================
// POSKLI PANEL 0.2 — painel do orquestrador
//
// Hierarquia (spec §36):
//   STATUS GLOBAL → PROGRESSO → ETAPAS → TAREFAS →
//   EXECUÇÕES → EVIDÊNCIAS
//
// A UI NUNCA inventa estado: tudo vem do backend
// (run.state + run.derived = deriveFinalStatus persistido).
// Sem chain-of-thought: só progresso operacional e evidências.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStudio } from '@/hooks/use-studio'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Markdown } from './markdown'
import { statusColor, statusLabel, formatDuration, timeAgo } from './ui-helpers'
import {
  POSKLI_VERSION_OPTIONS, poskliVersionOption, readStoredPoskliVersion, storePoskliVersion,
} from '@/lib/poskli-version'
import {
  Brain, ListTodo, Hammer, FlaskConical, SearchCheck, Wrench, BadgeCheck,
  Circle, CheckCircle2, XCircle, Loader2, Square, ChevronDown, ChevronRight,
  Timer, Repeat2, Coins, FileTerminal, ShieldQuestion, Ban, CircleAlert, Cpu,
} from 'lucide-react'
import { toast } from 'sonner'

interface StageEntry {
  stage: string
  state: 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED'
  startedAt: string
  finishedAt?: string
  durationMs?: number
  summary?: string
}

interface Criterion {
  id: string
  label: string
  status: 'PASS' | 'FAIL' | 'BLOCKED'
  evidence: string
}

interface Derived {
  state: 'SUCCESS' | 'FAILED' | 'BLOCKED' | 'PARTIAL' | 'CANCELLED'
  reason: string
  summary: string
  criteria: Criterion[]
  counters: {
    tasks: { total: number; completed: number; failed: number; blocked: number; pending: number }
    corrections: { necessary: boolean; planned: number; applied: number; failed: number }
    tests: { runs: number; passed: number; failed: number; lastStatus: string | null }
    review: string
  }
  conservative: boolean
  derivedAt: string
}

interface TestRecord {
  id: string
  executionId: string
  command: string
  status: 'PASS' | 'FAIL'
  exitCode: number | null
  trigger: string
  ts: string
  durationMs?: number
}

interface CorrectionRecord {
  id: string
  attempt: number
  trigger: string
  state: 'PLANNED' | 'STARTED' | 'COMPLETED' | 'FAILED' | 'BLOCKED'
  startedAt: string
  finishedAt?: string
  evidence?: string
  errorCode?: string
}

interface ReviewResult {
  status: 'NOT_RUN' | 'PASS' | 'CHANGES_REQUESTED' | 'FAILED' | 'BLOCKED'
  verdict?: string
  issues?: unknown[]
  summary?: string
  blockedReason?: string
  attempts: number
  ts?: string
}

interface PoskliRunInfo {
  id: string
  request: string
  state: string
  iteration: number
  maxIterations: number
  testsPassed: boolean
  previewOk: boolean
  tokensIn: number
  tokensOut: number
  startedAt: string
  finishedAt: string | null
  error?: string | null
  result?: string | null
  stages: StageEntry[] | null
  derived?: Derived | null
  testRecords?: TestRecord[] | null
  corrections?: CorrectionRecord[] | null
  reviewResult?: ReviewResult | null
  errorCode?: string | null
  outcomeReason?: string | null
}

interface TaskInfo {
  id: string; order: number; title: string; status: string; agentRole: string
  attempts: number; maxAttempts: number; error?: string; result?: string
}

interface ExecutionInfo {
  id: string; command: string; status: string; exitCode: number | null
  durationMs: number | null; stdout?: string | null; stderr?: string | null
}

const STAGE_ICONS: Record<string, typeof Brain> = {
  ANALYZING: Brain,
  PLANNING: ListTodo,
  IMPLEMENTING: Hammer,
  TESTING: FlaskConical,
  REVIEWING: SearchCheck,
  CORRECTING: Wrench,
  VERIFYING: BadgeCheck,
}

const STAGE_LABELS: Record<string, string> = {
  ANALYZING: 'Analisando',
  PLANNING: 'Planejando',
  IMPLEMENTING: 'Implementando',
  TESTING: 'Testando',
  REVIEWING: 'Revisando',
  CORRECTING: 'Corrigindo',
  VERIFYING: 'Verificando',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
  BLOCKED: 'Bloqueado',
  PARTIAL: 'Parcial',
  CANCELLED: 'Cancelado',
}

const STAGE_ORDER = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING']
const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'BLOCKED', 'PARTIAL', 'CANCELLED']
const ACTIVE_STATES = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING']

const TRIGGER_LABELS: Record<string, string> = {
  INITIAL: 'execução inicial',
  AFTER_CORRECTION: 'após correção',
  POST_REVIEW: 'pós-revisão',
  FINAL: 'verificação final',
}

const CORRECTION_LABELS: Record<string, string> = {
  PLANNED: 'Planejada',
  STARTED: 'Iniciada',
  COMPLETED: 'Concluída',
  FAILED: 'Falhou',
  BLOCKED: 'Bloqueada',
}

const REVIEW_LABELS: Record<string, string> = {
  NOT_RUN: 'não executada',
  PASS: 'aprovada',
  CHANGES_REQUESTED: 'solicitou mudanças',
  FAILED: 'reprovada',
  BLOCKED: 'bloqueada',
}

export function PoskliPanel({ projectId, prefill }: { projectId: string; prefill?: string | null }): React.ReactElement {
  const { api } = useStudio()
  const [run, setRun] = useState<PoskliRunInfo | null>(null)
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [execs, setExecs] = useState<ExecutionInfo[]>([])
  const [request, setRequest] = useState('')
  const [starting, setStarting] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [expandedTask, setExpandedTask] = useState<string | null>(null)
  // ---- SELETOR DE MODELOS: versão do Poskli (localStorage > default do servidor) ----
  const [version, setVersion] = useState<string>('')

  // versão inicial: escolha persistida OU default do servidor (via catálogo do GET /run)
  useEffect(() => {
    const stored = readStoredPoskliVersion()
    if (stored) {
      setVersion(stored)
      return
    }
    api<{ poskliVersions?: { default?: string } }>('/api/poskli/run?project=' + encodeURIComponent(projectId))
      .then((d) => {
        if (d.poskliVersions?.default) setVersion(d.poskliVersions.default)
      })
      .catch(() => {})
  }, [api, projectId])

  const changeVersion = (v: string) => {
    setVersion(v)
    storePoskliVersion(v) // persistida — próxima visita começa aqui
    const opt = poskliVersionOption(v)
    toast.success(opt ? `Motor Poskli: ${opt.short}` : `Motor Poskli: ${v}`)
  }

  /** header enviado em TODAS as chamadas Poskli deste painel. */
  const versionHeaders = useMemo<Record<string, string>>(() => {
    const h: Record<string, string> = {}
    if (version) h['x-poskli-version'] = version
    return h
  }, [version])

  // prefill vindo do preview ("Pedir correção ao Poskli")
  useEffect(() => {
    if (prefill) {
      setRequest(prefill)
      setDetailsOpen(false)
    }
  }, [prefill])

  const isActive = run ? ACTIVE_STATES.includes(run.state) : false

  const load = useCallback(async () => {
    try {
      const d = await api<{ runs: PoskliRunInfo[]; poskliVersions?: { versions?: string[]; default?: string } }>(
        `/api/poskli/run?project=${projectId}`,
        { headers: versionHeaders }
      )
      const latest = d.runs[0] ?? null
      setRun(latest)
      if (latest) {
        const detail = await api<{ run: PoskliRunInfo; tasks: TaskInfo[]; executions: ExecutionInfo[] }>(
          `/api/poskli/${latest.id}`,
          { headers: versionHeaders }
        )
        setRun(detail.run)
        setTasks(detail.tasks.filter((t) => t.status !== 'CANCELLED'))
        setExecs(detail.executions)
      } else {
        setTasks([])
        setExecs([])
      }
    } catch {
      /* silencioso — painel secundário */
    }
  }, [api, projectId, versionHeaders])

  useEffect(() => { load() }, [load])
  // polling enquanto ativo (produção sem websocket)
  useEffect(() => {
    if (!isActive) return
    const iv = setInterval(load, 4000)
    return () => clearInterval(iv)
  }, [isActive, load])

  const startRun = async () => {
    if (!request.trim()) return
    setStarting(true)
    try {
      await api('/api/poskli/run', {
        method: 'POST',
        headers: versionHeaders,
        body: JSON.stringify({ project: projectId, request: request.trim(), poskliVersion: version || undefined }),
      })
      toast.success('Poskli iniciado — analise em andamento')
      setRequest('')
      setDetailsOpen(true)
      setTimeout(load, 1500)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const cancel = async () => {
    if (!run) return
    try {
      await api(`/api/poskli/${run.id}`, { method: 'DELETE', headers: versionHeaders })
      toast.success('Cancelamento solicitado')
      setTimeout(load, 2000)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // timeline de estágios (agregada por tipo, com repetições de TESTING/CORRECTING)
  const timeline = useMemo(() => {
    if (!run?.stages) return []
    return run.stages.filter((s) => STAGE_LABELS[s.stage])
  }, [run])

  const activeStage = run?.state && isActive ? run.state : null
  const completedStages = new Set(timeline.filter((s) => s.state === 'DONE').map((s) => s.stage))

  // ---- CONTADORES: sempre dos dados reais (derived quando existe; live senão) ----
  const counters = useMemo(() => {
    if (run?.derived) return run.derived.counters
    const testRecords = run?.testRecords ?? []
    const corrections = run?.corrections ?? []
    const last = testRecords[testRecords.length - 1]
    return {
      tasks: {
        total: tasks.length,
        completed: tasks.filter((t) => t.status === 'COMPLETED').length,
        failed: tasks.filter((t) => t.status === 'FAILED').length,
        blocked: tasks.filter((t) => t.status === 'BLOCKED').length,
        pending: tasks.filter((t) => ['PENDING', 'RUNNING', 'REVIEWING'].includes(t.status)).length,
      },
      corrections: {
        necessary: testRecords.some((t) => t.status === 'FAIL') || run?.reviewResult?.status === 'CHANGES_REQUESTED',
        planned: corrections.length,
        applied: corrections.filter((c) => c.state === 'COMPLETED').length,
        failed: corrections.filter((c) => c.state === 'FAILED' || c.state === 'BLOCKED').length,
      },
      tests: {
        runs: testRecords.length,
        passed: testRecords.filter((t) => t.status === 'PASS').length,
        failed: testRecords.filter((t) => t.status === 'FAIL').length,
        lastStatus: last ? last.status : null,
      },
      review: run?.reviewResult?.status ?? 'NOT_RUN',
    }
  }, [run, tasks])

  const derived = run?.derived ?? null

  return (
    <div className="flex flex-col h-full min-h-0 bg-zinc-950/80">
      {/* 1) STATUS GLOBAL + comando */}
      <div className="p-3 border-b border-zinc-800/60 shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-md bg-emerald-600/15 border border-emerald-800/60 flex items-center justify-center shrink-0">
            <Brain className="w-3.5 h-3.5 text-emerald-400" />
          </span>
          <span className="text-xs font-bold tracking-wide">POSKLI</span>
          {/* badge da versão ativa (seletor de modelos) */}
          {version && (
            <Badge
              variant="outline"
              title={poskliVersionOption(version)?.description ?? version}
              className={`scale-[0.8] shrink-0 ${
                poskliVersionOption(version)?.highlight
                  ? 'bg-violet-500/15 text-violet-300 border-violet-500/30'
                  : 'bg-sky-500/10 text-sky-300 border-sky-500/30'
              }`}
            >
              v{version}
            </Badge>
          )}
          {run && (
            <Badge variant="outline" className={`${statusColor(badgeState(run))} scale-90`}>
              {STAGE_LABELS[run.state] ?? run.state}
            </Badge>
          )}
          {run?.errorCode && !isActive && (
            <Badge variant="outline" className="bg-orange-500/15 text-orange-400 border-orange-500/30 scale-[0.85]">
              {run.errorCode === 'QUOTA_EXHAUSTED'
                ? 'cota esgotada'
                : run.errorCode === 'PROVIDER_RATE_LIMIT'
                  ? 'limite do provedor'
                  : 'erro classificado'}
            </Badge>
          )}
          {isActive && (
            <Button size="sm" variant="outline" onClick={cancel} className="ml-auto h-6 text-[10px] border-red-900/60 text-red-400 hover:bg-red-950/40 hover:text-red-300">
              <Square className="w-2.5 h-2.5 mr-1" /> parar
            </Button>
          )}
        </div>

        {/* SELETOR DE MODELOS — versão do Poskli usada nos runs deste painel.
            Persistida em localStorage (poskli-version); enviada ao backend
            no corpo (poskliVersion) e header (x-poskli-version). Bloqueada
            durante run ativo: a versão é aplicada no início do run. */}
        <div className="flex items-center gap-2">
          <Cpu className="w-3 h-3 text-zinc-500 shrink-0" aria-hidden />
          <Select value={version || undefined} onValueChange={changeVersion} disabled={isActive || starting}>
            <SelectTrigger
              size="sm"
              aria-label="Versão do Poskli (seletor de modelos)"
              title={poskliVersionOption(version)?.description ?? 'Escolha a versão do Poskli'}
              className="h-7 w-full text-[11px] font-medium bg-zinc-900/70 border-zinc-800 text-zinc-300 hover:bg-zinc-900 focus-visible:ring-0 data-[size=sm]:h-7"
            >
              <SelectValue placeholder="versão do motor…" />
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
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) startRun()
            }}
            placeholder="Peça ao Poskli: ex. 'Cria um jogo de esquivar obstáculos' ou 'Corrige o bug de colisão'"
            rows={2}
            disabled={isActive}
            className="flex-1 bg-zinc-900/70 border border-zinc-800 rounded-lg px-2.5 py-2 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-800 resize-none disabled:opacity-50"
          />
          <Button onClick={startRun} disabled={starting || isActive || !request.trim()} size="sm" className="bg-emerald-600 hover:bg-emerald-500 shrink-0 h-9">
            {starting || (isActive && run?.state === 'ANALYZING') ? <Loader2 className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
          </Button>
        </div>
        {isActive && (
          <p className="text-[10px] text-emerald-400/80 flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" />
            {STAGE_LABELS[run!.state] ?? run!.state} — atualização automática a cada 4s
          </p>
        )}
      </div>

      {/* corpo */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {!run && (
          <div className="p-8 text-center space-y-2">
            <Brain className="w-10 h-10 mx-auto text-zinc-700" />
            <p className="text-sm text-zinc-400">Nenhuma execução ainda</p>
            <p className="text-[11px] text-zinc-600 max-w-64 mx-auto">
              O Poskli planeja, implementa, testa no terminal real, revisa e corrige — e só declara conclusão quando todos os critérios têm evidência.
            </p>
          </div>
        )}

        {run && (
          <div className="p-3 space-y-3">
            {/* 2) PROGRESSO — contadores derivados dos dados reais */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
              <span className="flex items-center gap-1"><Timer className="w-3 h-3" />{formatDuration(run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : Date.now() - new Date(run.startedAt).getTime())}</span>
              <span className="flex items-center gap-1"><ListTodo className="w-3 h-3" />{counters.tasks.completed}/{counters.tasks.total} tarefas</span>
              <span className="flex items-center gap-1"><Repeat2 className="w-3 h-3" />{counters.corrections.applied}/{counters.corrections.planned || (counters.corrections.necessary ? 1 : 0)} correções aplicadas</span>
              {counters.tests.lastStatus && (
                <span className={`flex items-center gap-1 ${counters.tests.lastStatus === 'PASS' ? 'text-emerald-500' : 'text-red-400'}`}>
                  <FlaskConical className="w-3 h-3" />testes: {counters.tests.lastStatus === 'PASS' ? 'PASS' : 'FAIL'} ({counters.tests.runs} exec.)
                </span>
              )}
              <span className="flex items-center gap-1"><Coins className="w-3 h-3" />{(run.tokensIn + run.tokensOut).toLocaleString('pt-BR')} tokens</span>
              <span className="ml-auto">{timeAgo(run.startedAt)}</span>
            </div>

            {/* 3) ETAPAS */}
            <div className="space-y-1">
              {STAGE_ORDER.map((stage) => {
                const Icon = STAGE_ICONS[stage] ?? Circle
                const entries = timeline.filter((s) => s.stage === stage)
                const done = completedStages.has(stage) && !(activeStage === stage)
                const current = activeStage === stage
                const failed = entries.some((e) => e.state === 'FAILED')
                const lastEntry = entries[entries.length - 1]
                const repeated = entries.length > 1
                return (
                  <div key={stage} className={`flex items-start gap-2.5 px-2 py-1.5 rounded-lg ${current ? 'bg-emerald-950/40 border border-emerald-900/40' : ''}`}>
                    <span className="shrink-0 mt-0.5">
                      {current ? (
                        <Loader2 className="w-4 h-4 text-emerald-400 animate-spin" />
                      ) : failed ? (
                        <XCircle className="w-4 h-4 text-red-400" />
                      ) : done ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      ) : (
                        <Circle className="w-4 h-4 text-zinc-700" />
                      )}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Icon className={`w-3.5 h-3.5 shrink-0 ${done ? 'text-emerald-500' : current ? 'text-emerald-400' : 'text-zinc-600'}`} />
                        <span className={`text-xs font-medium ${done || current ? 'text-zinc-200' : 'text-zinc-500'}`}>{STAGE_LABELS[stage]}</span>
                        {repeated && <span className="text-[9px] text-amber-500/80">×{entries.length}</span>}
                        {lastEntry?.durationMs !== undefined && (done || failed) && (
                          <span className="text-[9px] text-zinc-600 ml-auto shrink-0">{formatDuration(lastEntry.durationMs)}</span>
                        )}
                      </div>
                      {lastEntry?.summary && (done || failed || current) && (
                        <p className="text-[10px] text-zinc-500 mt-0.5 pl-5.5 break-words">{lastEntry.summary}</p>
                      )}
                    </div>
                  </div>
                )
              })}
              {/* estado terminal — SEMPRE do backend */}
              {TERMINAL_STATES.includes(run.state) && (
                <div className={`flex items-center gap-2.5 px-2 py-2 rounded-lg border ${
                  run.state === 'COMPLETED' ? 'border-emerald-900/50 bg-emerald-950/30'
                    : run.state === 'PARTIAL' ? 'border-amber-900/50 bg-amber-950/20'
                      : run.state === 'BLOCKED' ? 'border-orange-900/50 bg-orange-950/20'
                        : run.state === 'CANCELLED' ? 'border-zinc-800 bg-zinc-900/40'
                          : 'border-red-900/50 bg-red-950/30'
                }`}>
                  {run.state === 'COMPLETED' ? <BadgeCheck className="w-4 h-4 text-emerald-400" />
                    : run.state === 'PARTIAL' ? <CircleAlert className="w-4 h-4 text-amber-400" />
                      : run.state === 'BLOCKED' ? <ShieldQuestion className="w-4 h-4 text-orange-400" />
                        : run.state === 'CANCELLED' ? <Square className="w-4 h-4 text-zinc-400" />
                          : <XCircle className="w-4 h-4 text-red-400" />}
                  <span className="text-xs font-semibold">{STAGE_LABELS[run.state]}</span>
                  {derived?.summary && (
                    <span className="text-[10px] text-zinc-500 truncate flex-1 min-w-0" title={derived.summary}>{derived.summary}</span>
                  )}
                  <span className="ml-auto flex gap-1.5 shrink-0">
                    {run.testsPassed && <Badge variant="outline" className="bg-emerald-600/15 text-emerald-400 border-emerald-600/30 scale-90">testes OK</Badge>}
                    {run.previewOk && run.testsPassed && <Badge variant="outline" className="bg-emerald-600/15 text-emerald-400 border-emerald-600/30 scale-90">preview OK</Badge>}
                  </span>
                </div>
              )}
            </div>

            {/* detalhes */}
            <button
              onClick={() => setDetailsOpen(!detailsOpen)}
              className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 w-full pt-1 border-t border-zinc-800/50"
            >
              {detailsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Ver detalhes ({tasks.length} tarefas · {execs.length} execuções)
            </button>

            {detailsOpen && (
              <div className="space-y-2">
                {/* 6) EVIDÊNCIAS — critérios da derivação (fonte única da verdade) */}
                {derived && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-600 px-1">Critérios de conclusão</p>
                    <div className="px-2 py-2 rounded-lg bg-zinc-900/40 border border-zinc-800/40 space-y-1">
                      {derived.criteria.map((c) => (
                        <div key={c.id} className="flex items-start gap-2">
                          <span className="shrink-0 mt-0.5">
                            {c.status === 'PASS' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                              : c.status === 'FAIL' ? <XCircle className="w-3.5 h-3.5 text-red-400" />
                                : <ShieldQuestion className="w-3.5 h-3.5 text-orange-400" />}
                          </span>
                          <div className="min-w-0">
                            <span className={`text-[11px] font-medium ${c.status === 'PASS' ? 'text-zinc-300' : c.status === 'FAIL' ? 'text-red-300' : 'text-orange-300'}`}>
                              {c.label}
                            </span>
                            <p className="text-[10px] text-zinc-500 break-words">{c.evidence}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* revisão */}
                {run.reviewResult && run.reviewResult.status !== 'NOT_RUN' && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-600 px-1">Revisão</p>
                    <div className="px-2 py-1.5 rounded-lg bg-zinc-900/40 border border-zinc-800/40">
                      <div className="flex items-center gap-2">
                        <SearchCheck className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        <span className="text-[11px] text-zinc-300">{REVIEW_LABELS[run.reviewResult.status] ?? run.reviewResult.status}</span>
                        {run.reviewResult.blockedReason && (
                          <Badge variant="outline" className="bg-orange-500/15 text-orange-400 border-orange-500/30 scale-[0.85]">{run.reviewResult.blockedReason}</Badge>
                        )}
                        <span className="text-[9px] text-zinc-600 ml-auto">{run.reviewResult.attempts} tentativa(s)</span>
                      </div>
                      {run.reviewResult.summary && (
                        <details className="mt-1 pl-5">
                          <summary className="text-[9px] text-zinc-600 cursor-pointer hover:text-zinc-400">detalhes da revisão</summary>
                          <p className="mt-1 text-[10px] text-zinc-500 whitespace-pre-wrap break-words">{run.reviewResult.summary.slice(0, 600)}</p>
                        </details>
                      )}
                    </div>
                  </div>
                )}

                {/* 4) TAREFAS */}
                {tasks.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-600 px-1">Tarefas</p>
                    {tasks.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setExpandedTask(expandedTask === t.id ? null : t.id)}
                        className="w-full text-left px-2 py-1.5 rounded-lg bg-zinc-900/40 hover:bg-zinc-900/70 border border-zinc-800/40"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] text-zinc-600 font-mono w-5 shrink-0">#{String(t.order + 1).padStart(2, '0')}</span>
                          <span className="text-[11px] text-zinc-300 flex-1 truncate">{t.title}</span>
                          {t.attempts > 1 && <span className="text-[9px] text-amber-500/80 shrink-0">tentativa {t.attempts}/{t.maxAttempts + 1}</span>}
                          <Badge variant="outline" className={`${statusColor(t.status)} scale-[0.85] shrink-0`}>{statusLabel(t.status)}</Badge>
                        </div>
                        {expandedTask === t.id && (
                          <div className="mt-1.5 pl-7 space-y-1.5">
                            {t.error && <p className="text-[10px] text-red-400/90 break-words">{t.error}</p>}
                            {t.result && <Markdown content={String(t.result).slice(0, 1500)} compact />}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {/* correções (registros com estado individual) */}
                {(run.corrections?.length ?? 0) > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-600 px-1">Correções ({counters.corrections.applied}/{run.corrections!.length} aplicadas)</p>
                    {run.corrections!.map((c) => (
                      <div key={c.id} className="px-2 py-1.5 rounded-lg bg-zinc-900/40 border border-zinc-800/40">
                        <div className="flex items-center gap-2">
                          <Wrench className={`w-3 h-3 shrink-0 ${c.state === 'COMPLETED' ? 'text-emerald-500' : c.state === 'BLOCKED' ? 'text-orange-400' : c.state === 'FAILED' ? 'text-red-400' : 'text-zinc-500'}`} />
                          <span className="text-[10px] text-zinc-400">Correção #{c.attempt}</span>
                          <span className="text-[9px] text-zinc-600">{c.trigger === 'TEST_FAILURE' ? 'falha de testes' : 'revisão solicitou mudanças'}</span>
                          <Badge variant="outline" className={`${statusColor(c.state === 'COMPLETED' ? 'COMPLETED' : c.state === 'BLOCKED' ? 'BLOCKED' : c.state === 'STARTED' ? 'RUNNING' : 'FAILED')} scale-[0.8] ml-auto shrink-0`}>
                            {CORRECTION_LABELS[c.state] ?? c.state}
                          </Badge>
                        </div>
                        {c.evidence && <p className="text-[9.5px] text-zinc-600 mt-0.5 pl-5 break-words">{c.evidence}</p>}
                      </div>
                    ))}
                  </div>
                )}

                {/* 5) EXECUÇÕES reais (testes com identidade — dedup por id) */}
                {(run.testRecords?.length ?? 0) > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-600 px-1">Testes executados ({run.testRecords!.length})</p>
                    {run.testRecords!.map((t) => {
                      const exec = execs.find((e) => e.id === t.executionId)
                      return (
                        <div key={t.id} className="px-2 py-1.5 rounded-lg bg-zinc-900/40 border border-zinc-800/40">
                          <div className="flex items-center gap-2 text-[10px] font-mono">
                            {t.status === 'PASS' ? <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" /> : <XCircle className="w-3 h-3 text-red-400 shrink-0" />}
                            <span className="text-zinc-300 truncate flex-1">{t.command}</span>
                            <span className="text-[9px] text-zinc-600 shrink-0">{TRIGGER_LABELS[t.trigger] ?? t.trigger}</span>
                            <Badge variant="outline" className={`${t.status === 'PASS' ? 'bg-emerald-600/15 text-emerald-400 border-emerald-600/30' : 'bg-red-500/15 text-red-400 border-red-500/30'} scale-[0.8] shrink-0`}>
                              {t.status} {t.exitCode !== null ? `(${t.exitCode})` : ''}
                            </Badge>
                          </div>
                          {exec && (exec.stderr || exec.stdout) && (
                            <details className="mt-1 pl-5">
                              <summary className="text-[9px] text-zinc-600 cursor-pointer hover:text-zinc-400">saída</summary>
                              <pre className="mt-1 max-h-32 overflow-y-auto text-[9.5px] font-mono whitespace-pre-wrap break-words text-zinc-500">
                                {exec.stderr ? <span className="text-red-400">{exec.stderr.slice(0, 2000)}</span> : exec.stdout?.slice(0, 2000)}
                              </pre>
                            </details>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* outras execuções (build etc.) */}
                {execs.filter((e) => !run.testRecords?.some((t) => t.executionId === e.id)).length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-600 px-1">Outras execuções (terminal real)</p>
                    {execs.filter((e) => !run.testRecords?.some((t) => t.executionId === e.id)).map((e) => (
                      <div key={e.id} className="px-2 py-1.5 rounded-lg bg-zinc-900/40 border border-zinc-800/40">
                        <div className="flex items-center gap-2 text-[10px] font-mono">
                          <FileTerminal className="w-3 h-3 text-emerald-500 shrink-0" />
                          <span className="text-zinc-300 truncate flex-1">{e.command}</span>
                          <Badge variant="outline" className={`${statusColor(e.status)} scale-[0.85] shrink-0`}>{statusLabel(e.status)}</Badge>
                        </div>
                        {(e.stderr || e.stdout) ? (
                          <details className="mt-1 pl-5">
                            <summary className="text-[9px] text-zinc-600 cursor-pointer hover:text-zinc-400">saída</summary>
                            <pre className="mt-1 max-h-32 overflow-y-auto text-[9.5px] font-mono whitespace-pre-wrap break-words text-zinc-500">
                              {e.stderr ? <span className="text-red-400">{e.stderr.slice(0, 2000)}</span> : e.stdout?.slice(0, 2000)}
                            </pre>
                          </details>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}

                {/* resultado markdown (gerado da MESMA derivação) */}
                {run.result && (
                  <Card className="border-zinc-800/60 bg-zinc-900/40">
                    <CardContent className="p-2.5">
                      <Markdown content={run.result} compact />
                    </CardContent>
                  </Card>
                )}

                {/* erro honesto */}
                {run.error && !run.result?.includes(run.error.slice(0, 50)) && (
                  <div className="px-2.5 py-2 rounded-lg bg-red-950/20 border border-red-900/40">
                    <p className="text-[10px] uppercase tracking-wider text-red-400/80 mb-1">Causa real</p>
                    <p className="text-[10.5px] text-red-300/90 break-words">{run.error}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function badgeState(run: PoskliRunInfo): string {
  if (TERMINAL_STATES.includes(run.state)) return run.state
  return 'RUNNING'
}
