'use client'

// ============================================================
// POSKLI PANEL — painel de execução do orquestrador
// Estágios (● em execução ✓ concluído ○ pendente), contador de
// tarefas, iteração, tempo, tokens, detalhes expandíveis.
// Sem chain-of-thought: só progresso operacional e resultados.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStudio } from '@/hooks/use-studio'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Markdown } from './markdown'
import { statusColor, statusLabel, formatDuration, timeAgo } from './ui-helpers'
import {
  Brain, ListTodo, Hammer, FlaskConical, SearchCheck, Wrench, BadgeCheck,
  Circle, CheckCircle2, XCircle, Loader2, Square, ChevronDown, ChevronRight,
  Timer, Repeat2, Coins, FileTerminal,
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
}

interface TaskInfo {
  id: string; order: number; title: string; status: string; agentRole: string
  attempts: number; error?: string; result?: string
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
  CANCELLED: 'Cancelado',
}

const STAGE_ORDER = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'VERIFYING']

export function PoskliPanel({ projectId, prefill }: { projectId: string; prefill?: string | null }): React.ReactElement {
  const { api } = useStudio()
  const [run, setRun] = useState<PoskliRunInfo | null>(null)
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [execs, setExecs] = useState<ExecutionInfo[]>([])
  const [request, setRequest] = useState('')
  const [starting, setStarting] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [expandedTask, setExpandedTask] = useState<string | null>(null)

  // prefill vindo do preview ("Pedir correção ao Poskli")
  useEffect(() => {
    if (prefill) {
      setRequest(prefill)
      setDetailsOpen(false)
    }
  }, [prefill])

  const isActive = run ? ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING'].includes(run.state) : false

  const load = useCallback(async () => {
    try {
      const d = await api<{ runs: PoskliRunInfo[] }>(`/api/poskli/run?project=${projectId}`)
      const latest = d.runs[0] ?? null
      setRun(latest)
      if (latest) {
        const detail = await api<{ run: PoskliRunInfo; tasks: TaskInfo[]; executions: ExecutionInfo[] }>(`/api/poskli/${latest.id}`)
        setRun(detail.run)
        setTasks(detail.tasks)
        setExecs(detail.executions)
      } else {
        setTasks([])
        setExecs([])
      }
    } catch {
      /* silencioso — painel secundário */
    }
  }, [api, projectId])

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
        body: JSON.stringify({ project: projectId, request: request.trim() }),
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
      await api(`/api/poskli/${run.id}`, { method: 'DELETE' })
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

  return (
    <div className="flex flex-col h-full min-h-0 bg-zinc-950/80">
      {/* command bar */}
      <div className="p-3 border-b border-zinc-800/60 shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-md bg-emerald-600/15 border border-emerald-800/60 flex items-center justify-center shrink-0">
            <Brain className="w-3.5 h-3.5 text-emerald-400" />
          </span>
          <span className="text-xs font-bold tracking-wide">POSKLI</span>
          {run && (
            <Badge variant="outline" className={`${statusColor(poskliBadgeState(run))} scale-90`}>
              {STAGE_LABELS[run.state] ?? run.state}
            </Badge>
          )}
          {isActive && (
            <Button size="sm" variant="outline" onClick={cancel} className="ml-auto h-6 text-[10px] border-red-900/60 text-red-400 hover:bg-red-950/40 hover:text-red-300">
              <Square className="w-2.5 h-2.5 mr-1" /> parar
            </Button>
          )}
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
              O Poskli planeja, implementa, testa no terminal real, revisa e corrige até os testes passarem.
            </p>
          </div>
        )}

        {run && (
          <div className="p-3 space-y-3">
            {/* metadados */}
            <div className="flex flex-wrap items-center gap-3 text-[10px] text-zinc-500">
              <span className="flex items-center gap-1"><Timer className="w-3 h-3" />{formatDuration(run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : Date.now() - new Date(run.startedAt).getTime())}</span>
              <span className="flex items-center gap-1"><Repeat2 className="w-3 h-3" />correção {run.iteration}/{run.maxIterations}</span>
              <span className="flex items-center gap-1"><Coins className="w-3 h-3" />{(run.tokensIn + run.tokensOut).toLocaleString('pt-BR')} tokens</span>
              <span className="ml-auto">{timeAgo(run.startedAt)}</span>
            </div>

            {/* pipeline de estágios */}
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
              {/* estados terminais */}
              {['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state) && (
                <div className={`flex items-center gap-2.5 px-2 py-2 rounded-lg border ${
                  run.state === 'COMPLETED' ? 'border-emerald-900/50 bg-emerald-950/30' : run.state === 'CANCELLED' ? 'border-zinc-800 bg-zinc-900/40' : 'border-red-900/50 bg-red-950/30'
                }`}>
                  {run.state === 'COMPLETED' ? <BadgeCheck className="w-4 h-4 text-emerald-400" />
                    : run.state === 'CANCELLED' ? <Square className="w-4 h-4 text-zinc-400" />
                    : <XCircle className="w-4 h-4 text-red-400" />}
                  <span className="text-xs font-semibold">{STAGE_LABELS[run.state]}</span>
                  <span className="ml-auto flex gap-1.5">
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
                {/* tarefas */}
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

                {/* execuções reais */}
                {execs.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-600 px-1">Execuções (terminal real)</p>
                    {execs.map((e) => (
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

                {/* resultado markdown */}
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

function poskliBadgeState(run: PoskliRunInfo): string {
  if (run.state === 'COMPLETED') return 'COMPLETED'
  if (run.state === 'FAILED') return 'FAILED'
  if (run.state === 'CANCELLED') return 'CANCELLED'
  return 'RUNNING'
}
