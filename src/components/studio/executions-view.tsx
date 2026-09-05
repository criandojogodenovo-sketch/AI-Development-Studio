'use client'

// ============================================================
// EXECUTIONS VIEW — histórico REAL de execuções (Execution Engine)
// Estados, exit code, duração, arquivos sincronizados, output
// completo. Observabilidade de terminal + Poskli.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { useStudio } from '@/hooks/use-studio'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RefreshCw, TerminalSquare, ChevronDown, ChevronRight, Timer, ArrowLeftRight } from 'lucide-react'
import { statusColor, statusLabel, formatDuration, timeAgo } from './ui-helpers'
import { toast } from 'sonner'

interface ExecutionInfo {
  id: string
  command: string
  source: string
  trigger: string | null
  status: string
  exitCode: number | null
  durationMs: number | null
  timedOut: boolean
  syncedFiles: number
  startedAt: string
  finishedAt: string | null
}

export function ExecutionsView(): React.ReactElement {
  const { api, projects, activeProjectId } = useStudio()
  const [execs, setExecs] = useState<ExecutionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, { stdout: string | null; stderr: string | null }>>({})

  const projectId = activeProjectId ?? projects[0]?.id ?? null

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const d = await api<{ executions: ExecutionInfo[] }>(`/api/executions?project=${projectId}&take=50`)
      setExecs(d.executions)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [api, projectId])

  useEffect(() => {
    load()
    const iv = setInterval(load, 10_000) // atualiza enquanto aberto
    return () => clearInterval(iv)
  }, [load])

  const toggle = async (id: string) => {
    if (expanded === id) return setExpanded(null)
    setExpanded(id)
    if (!detail[id]) {
      try {
        const d = await api<{ execution: { stdout: string | null; stderr: string | null } }>(`/api/executions/${id}`)
        setDetail((prev) => ({ ...prev, [id]: { stdout: d.execution.stdout, stderr: d.execution.stderr } }))
      } catch { /* ignora */ }
    }
  }

  const sourceLabel: Record<string, string> = {
    terminal: 'Terminal',
    poskli: 'Poskli',
    pipeline: 'Pipeline',
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold flex items-center gap-2">
          <TerminalSquare className="w-5 h-5 text-emerald-400" />
          Execuções
        </h1>
        {projectId && (
          <span className="text-xs text-zinc-500 truncate">
            {projects.find((p) => p.id === projectId)?.name}
          </span>
        )}
        <Button variant="ghost" size="icon" onClick={load} className="ml-auto">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {!projectId && (
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="p-8 text-center text-sm text-zinc-500">
            Selecione um projeto para ver as execuções.
          </CardContent>
        </Card>
      )}

      {projectId && execs.length === 0 && !loading && (
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="p-8 text-center space-y-2">
            <TerminalSquare className="w-10 h-10 mx-auto text-zinc-600" />
            <p className="text-sm text-zinc-400">Nenhuma execução ainda</p>
            <p className="text-xs text-zinc-500">Rode comandos no Terminal ou peça ao Poskli — cada execução fica registrada aqui com saída completa.</p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-1.5">
        {execs.map((e) => {
          const isOpen = expanded === e.id
          return (
            <Card key={e.id} className={`border-zinc-800 bg-zinc-900/60 ${isOpen ? 'border-emerald-900/60' : ''}`}>
              <CardContent className="p-2.5">
                <button className="w-full text-left" onClick={() => toggle(e.id)} aria-expanded={isOpen}>
                  <div className="flex items-center gap-2">
                    {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />}
                    <span className="font-mono text-xs text-emerald-400 shrink-0">$</span>
                    <span className="font-mono text-xs text-zinc-200 flex-1 truncate">{e.command}</span>
                    <Badge variant="outline" className={`${statusColor(e.status)} shrink-0 scale-90`}>{statusLabel(e.status)}</Badge>
                  </div>
                  <div className="flex items-center gap-3 mt-1 pl-7 text-[10px] text-zinc-500 font-mono">
                    <span>{sourceLabel[e.source] ?? e.source}</span>
                    {e.exitCode !== null && <span>exit {e.exitCode}</span>}
                    {e.durationMs !== undefined && e.durationMs !== null && (
                      <span className="flex items-center gap-0.5"><Timer className="w-2.5 h-2.5" />{formatDuration(e.durationMs)}</span>
                    )}
                    {e.syncedFiles > 0 && (
                      <span className="flex items-center gap-0.5"><ArrowLeftRight className="w-2.5 h-2.5" />{e.syncedFiles} sync</span>
                    )}
                    <span className="ml-auto">{timeAgo(e.startedAt)}</span>
                  </div>
                </button>

                {isOpen && (
                  <div className="mt-2 border-t border-zinc-800/60 pt-2 space-y-2">
                    <ScrollArea className="h-64 rounded bg-zinc-950 border border-zinc-900">
                      <pre className="p-2 font-mono text-[10.5px] whitespace-pre-wrap break-words">
                        {detail[e.id] ? (
                          <>
                            {detail[e.id].stdout && <span className="text-zinc-300">{detail[e.id].stdout}</span>}
                            {detail[e.id].stderr && <span className="text-red-400">{detail[e.id].stderr}</span>}
                            {!detail[e.id].stdout && !detail[e.id].stderr && <span className="text-zinc-600">(sem saída)</span>}
                          </>
                        ) : (
                          <span className="text-zinc-600">carregando saída…</span>
                        )}
                      </pre>
                    </ScrollArea>
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
