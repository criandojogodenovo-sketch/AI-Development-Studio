'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStudio } from '@/hooks/use-studio'
import { statusColor, eventIcon, timeAgo, formatDuration, AGENT_ICONS, formatTokens } from './ui-helpers'
import {
  Loader2, Send, File as FileIcon, FileCode, TerminalSquare, Play,
  FolderTree, ListChecks, Activity, Save, RefreshCw, Eye, ChevronRight, Bot
} from 'lucide-react'
import { toast } from 'sonner'

interface TaskInfo {
  id: string; order: number; title: string; status: string; priority: string
  agentRole: string; attempts: number; maxAttempts: number; dependencies: string[]; error?: string
}
interface RunInfo {
  id: string; agentId: string; model: string; runType: string; status: string
  steps: number; tokensIn: number; tokensOut: number; durationMs: number; startedAt: string
}
interface FileNode { path: string; type: 'file' | 'dir' }

export function WorkspaceView({ onBack }: { onBack: () => void }) {
  const { api, activeProjectId, liveEvents, wsConnected, projects } = useStudio()
  const [project, setProject] = useState<any>(null)
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [progress, setProgress] = useState({ percent: 0, completed: 0, total: 0, byStatus: {} as Record<string, number> })
  const [files, setFiles] = useState<FileNode[]>([])
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [memory, setMemory] = useState<any>({})
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const [tab, setTab] = useState('tasks')
  const [editPath, setEditPath] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editDirty, setEditDirty] = useState(false)
  const [editLoading, setEditLoading] = useState(false)
  const [termHistory, setTermHistory] = useState<Array<{ cmd: string; out: string; err: string; code: number }>>([])
  const [termCmd, setTermCmd] = useState('')
  const [termBusy, setTermBusy] = useState(false)
  const termRef = useRef<HTMLDivElement>(null)

  const projectSummary = projects.find((p) => p.id === activeProjectId)

  const load = useCallback(async () => {
    if (!activeProjectId) return
    try {
      const d = await api<any>(`/api/projects/${activeProjectId}`)
      setProject(d.project)
      setTasks(d.progress.tasks)
      setProgress({ percent: d.progress.percent, completed: d.progress.completed, total: d.progress.total, byStatus: d.progress.byStatus })
      setFiles(d.files)
      setRuns(d.runs)
      setMemory(d.memory)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [api, activeProjectId])

  useEffect(() => { load() }, [load])

  // Auto-refresh quando eventos do projeto chegam
  useEffect(() => {
    const relevant = liveEvents.some((e) => e.projectId === activeProjectId)
    if (relevant) {
      const t = setTimeout(load, 600)
      return () => clearTimeout(t)
    }
  }, [liveEvents, activeProjectId, load])

  const startPipeline = async () => {
    if (!command.trim() || !activeProjectId) return
    setRunning(true)
    try {
      await api(`/api/projects/${activeProjectId}/run`, {
        method: 'POST',
        body: JSON.stringify({ request: command.trim() }),
      })
      toast.success('Pipeline iniciado — Master Agent analisando o pedido')
      setCommand('')
      setTab('tasks')
      setTimeout(load, 1500)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const openFile = async (path: string) => {
    setEditLoading(true)
    setEditPath(path)
    setTab('editor')
    try {
      const d = await api<{ content: string }>(`/api/files?project=${activeProjectId}&path=${encodeURIComponent(path)}`)
      setEditContent(d.content)
      setEditDirty(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setEditLoading(false)
    }
  }

  const saveFile = async () => {
    if (!editPath) return
    try {
      await api('/api/files', {
        method: 'POST',
        body: JSON.stringify({ project: activeProjectId, path: editPath, content: editContent }),
      })
      setEditDirty(false)
      toast.success(`Salvo: ${editPath}`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const runTerminal = async () => {
    if (!termCmd.trim() || !activeProjectId) return
    const cmd = termCmd.trim()
    setTermCmd('')
    setTermBusy(true)
    try {
      const d = await api<{ ok: boolean; stdout: string; stderr: string; exitCode: number; durationMs: number }>('/api/terminal', {
        method: 'POST',
        body: JSON.stringify({ project: activeProjectId, command: cmd }),
      })
      setTermHistory((h) => [{ cmd, out: d.stdout, err: d.stderr, code: d.exitCode }, ...h].slice(0, 30))
    } catch (e) {
      setTermHistory((h) => [{ cmd, out: '', err: (e as Error).message, code: 1 }, ...h].slice(0, 30))
    } finally {
      setTermBusy(false)
    }
  }

  const projectEvents = useMemo(
    () => liveEvents.filter((e) => e.projectId === activeProjectId).slice(0, 60),
    [liveEvents, activeProjectId]
  )

  const fileGroups = useMemo(() => {
    const groups: Record<string, FileNode[]> = {}
    for (const f of files) {
      const dir = f.path.includes('/') ? f.path.split('/')[0] + '/' : '(raiz)'
      groups[dir] = groups[dir] ?? []
      groups[dir].push(f)
    }
    return groups
  }, [files])

  if (!activeProjectId) return null

  return (
    <div className="space-y-4">
      {/* Header do projeto */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-zinc-400">← Voltar</Button>
        <h2 className="font-bold text-lg truncate">{project?.name ?? '...'}</h2>
        <Badge variant="outline" className={statusColor(project?.status)}>{project?.status ?? '—'}</Badge>
        {wsConnected && <span className="flex items-center gap-1 text-[10px] text-emerald-500"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />live</span>}
        <Button variant="ghost" size="icon" onClick={load} className="ml-auto"><RefreshCw className="w-4 h-4" /></Button>
      </div>

      {/* Barra de comando — conversa com os agentes */}
      <Card className="border-emerald-900/50 bg-zinc-900/80">
        <CardContent className="p-3">
          <div className="flex items-start gap-2">
            <Bot className="w-5 h-5 text-emerald-500 mt-1 shrink-0" />
            <Textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Ex: Cria um mini-game 2D de sobrevivência para celular. / Corrige o bug nos controles. / Adiciona sistema de vidas."
              rows={2}
              className="border-0 bg-transparent focus-visible:ring-0 text-sm resize-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) startPipeline()
              }}
            />
            <Button onClick={startPipeline} disabled={running || !command.trim()} className="bg-emerald-600 hover:bg-emerald-500 shrink-0" size="sm">
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-[10px] text-zinc-600 mt-1">
            MASTER AGENT → análise → plano → task graph → agentes → implementação → testes → review → correções
          </p>
        </CardContent>
      </Card>

      {/* Progresso */}
      {progress.total > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-zinc-500">
            <span>{progress.completed}/{progress.total} tarefas ({progress.percent}%)</span>
            <span>{Object.entries(progress.byStatus).filter(([k]) => k !== 'COMPLETED').map(([k, v]) => `${k}:${v}`).join(' ')}</span>
          </div>
          <Progress value={progress.percent} className="h-2" />
        </div>
      )}

      {/* Painéis */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid grid-cols-3 sm:grid-cols-6 h-auto gap-0.5">
          <TabsTrigger value="tasks" className="text-xs gap-1"><ListChecks className="w-3.5 h-3.5" />Tarefas</TabsTrigger>
          <TabsTrigger value="files" className="text-xs gap-1"><FolderTree className="w-3.5 h-3.5" />Arquivos</TabsTrigger>
          <TabsTrigger value="editor" className="text-xs gap-1"><FileCode className="w-3.5 h-3.5" />Editor</TabsTrigger>
          <TabsTrigger value="terminal" className="text-xs gap-1"><TerminalSquare className="w-3.5 h-3.5" />Terminal</TabsTrigger>
          <TabsTrigger value="preview" className="text-xs gap-1"><Eye className="w-3.5 h-3.5" />Preview</TabsTrigger>
          <TabsTrigger value="activity" className="text-xs gap-1"><Activity className="w-3.5 h-3.5" />Atividade</TabsTrigger>
        </TabsList>

        {/* ---- TAREFAS (task graph) ---- */}
        <TabsContent value="tasks" className="mt-3 space-y-2">
          {tasks.length === 0 && (
            <Card className="border-zinc-800 bg-zinc-900/60">
              <CardContent className="p-6 text-center text-sm text-zinc-500">
                Nenhuma tarefa ainda. Envie um pedido na barra acima — o Master Agent criará o grafo de tarefas.
              </CardContent>
            </Card>
          )}
          {tasks.map((t, i) => (
            <Card key={t.id} className="border-zinc-800 bg-zinc-900/60">
              <CardContent className="p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-600 font-mono w-6">#{String(t.order + 1).padStart(2, '0')}</span>
                  <span>{AGENT_ICONS[t.agentRole] ?? '🤖'}</span>
                  <span className="text-sm font-medium flex-1 truncate">{t.title}</span>
                  <Badge variant="outline" className={statusColor(t.status)}>{t.status}</Badge>
                </div>
                <div className="flex items-center gap-3 mt-1 pl-8 text-[11px] text-zinc-600">
                  <span>agente: {t.agentRole}</span>
                  <span>tentativa: {t.attempts}/{t.maxAttempts + 5}</span>
                  <span>prio: {t.priority}</span>
                  {t.dependencies?.length > 0 && <span>deps: {t.dependencies.map((d) => tasks.findIndex((x) => x.id === d) + 1).filter(Boolean).join(',')}</span>}
                </div>
                {t.error && <p className="text-[11px] text-red-400/80 mt-1 pl-8 truncate">{t.error}</p>}
              </CardContent>
            </Card>
          ))}
          {/* Runs */}
          {runs.length > 0 && (
            <Card className="border-zinc-800 bg-zinc-900/60">
              <CardHeader className="py-2"><CardTitle className="text-xs text-zinc-500">Execuções de agentes</CardTitle></CardHeader>
              <CardContent className="space-y-1">
                {runs.slice(0, 10).map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-[11px] border-b border-zinc-800/50 pb-1">
                    <span>{AGENT_ICONS[r.agentId] ?? '🤖'}</span>
                    <span className="text-zinc-400 w-24 truncate">{r.agentId} · {r.runType}</span>
                    <Badge variant="outline" className={`${statusColor(r.status)} scale-90`}>{r.status}</Badge>
                    <span className="text-zinc-600">{r.steps} passos</span>
                    <span className="text-zinc-600">{formatTokens(r.tokensIn + r.tokensOut)} tok</span>
                    <span className="text-zinc-600 ml-auto">{formatDuration(r.durationMs)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ---- ARQUIVOS ---- */}
        <TabsContent value="files" className="mt-3">
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardContent className="p-2">
              <ScrollArea className="h-[420px]">
                {files.length === 0 && <p className="p-4 text-sm text-zinc-600 text-center">Workspace vazio.</p>}
                {Object.entries(fileGroups).map(([dir, items]) => (
                  <div key={dir} className="mb-2">
                    <p className="text-[10px] uppercase tracking-wide text-zinc-600 px-2 py-1">{dir}</p>
                    {items.map((f) => (
                      <button
                        key={f.path}
                        onClick={() => f.type === 'file' && openFile(f.path)}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left hover:bg-zinc-800/60 ${f.type === 'dir' ? 'text-zinc-500' : 'text-zinc-300'} ${editPath === f.path ? 'bg-emerald-950/40 text-emerald-300' : ''}`}
                      >
                        {f.type === 'dir' ? <FolderTree className="w-3.5 h-3.5 text-zinc-600" /> : <FileIcon className="w-3.5 h-3.5 text-zinc-500" />}
                        <span className="truncate">{f.path.split('/').pop()}</span>
                        {f.type === 'file' && <ChevronRight className="w-3 h-3 ml-auto opacity-30" />}
                      </button>
                    ))}
                  </div>
                ))}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- EDITOR ---- */}
        <TabsContent value="editor" className="mt-3">
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="py-2 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-xs font-mono text-zinc-400 truncate">{editPath ?? 'nenhum arquivo aberto'}</CardTitle>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={saveFile} disabled={!editPath || !editDirty} className="h-7 text-xs">
                  <Save className="w-3 h-3 mr-1" /> Salvar
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {editLoading ? (
                <div className="flex justify-center p-8"><Loader2 className="w-5 h-5 animate-spin text-zinc-600" /></div>
              ) : editPath ? (
                <Textarea
                  value={editContent}
                  onChange={(e) => { setEditContent(e.target.value); setEditDirty(true) }}
                  className="font-mono text-xs border-0 rounded-none bg-zinc-950 min-h-[420px] focus-visible:ring-0 resize-y"
                  spellCheck={false}
                />
              ) : (
                <p className="p-8 text-center text-sm text-zinc-600">Abra um arquivo no painel Arquivos.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- TERMINAL (allowlist) ---- */}
        <TabsContent value="terminal" className="mt-3">
          <Card className="border-zinc-800 bg-zinc-950">
            <CardContent className="p-3 space-y-2">
              <div className="flex gap-2">
                <Input
                  value={termCmd}
                  onChange={(e) => setTermCmd(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runTerminal()}
                  placeholder="comando permitido: npm test · node --test test/ · git log · ls -la"
                  className="font-mono text-xs bg-zinc-900 border-zinc-800"
                />
                <Button size="sm" onClick={runTerminal} disabled={termBusy || !termCmd.trim()} className="bg-emerald-600 hover:bg-emerald-500">
                  {termBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                </Button>
              </div>
              <p className="text-[10px] text-zinc-600">Executa na allowlist de segurança (mesma dos agentes). Comandos fora da lista são negados.</p>
              <div ref={termRef} className="font-mono text-[11px] space-y-2 max-h-[400px] overflow-y-auto">
                {termHistory.map((h, i) => (
                  <div key={i} className="border-b border-zinc-900 pb-2">
                    <p className="text-emerald-500">$ {h.cmd}</p>
                    {h.out && <pre className="text-zinc-300 whitespace-pre-wrap">{h.out}</pre>}
                    {h.err && <pre className="text-red-400 whitespace-pre-wrap">{h.err}</pre>}
                    <p className="text-zinc-600">exit {h.code}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- PREVIEW ---- */}
        <TabsContent value="preview" className="mt-3">
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardHeader className="py-2">
              <CardTitle className="text-xs text-zinc-400">Preview real do projeto (workspace servido)</CardTitle>
            </CardHeader>
            <CardContent>
              {project?.type === 'API' ? (
                <p className="text-sm text-zinc-500">Projetos API não têm preview visual. Use o Terminal para rodar o servidor (node server.js).</p>
              ) : (
                <div className="rounded-lg overflow-hidden border border-zinc-800 bg-white" style={{ aspectRatio: '9/16', maxHeight: 640 }}>
                  <iframe
                    src={`/api/preview/${activeProjectId}/`}
                    className="w-full h-full"
                    title="Preview do projeto"
                    sandbox="allow-scripts allow-pointer-lock"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- ATIVIDADE ---- */}
        <TabsContent value="activity" className="mt-3">
          <Card className="border-zinc-800 bg-zinc-900/60">
            <CardContent className="p-3">
              <ScrollArea className="h-[420px]">
                {projectEvents.length === 0 && (
                  <p className="text-sm text-zinc-600 text-center p-4">Sem eventos ainda — inicie um pipeline.</p>
                )}
                <div className="space-y-1.5">
                  {projectEvents.map((e, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs border-b border-zinc-800/50 pb-1.5">
                      <span>{eventIcon(e.type)}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-zinc-300">{e.message}</p>
                        <p className="text-zinc-600 text-[10px]">
                          {e.type}{e.agent ? ` · ${e.agent}` : ''}{e.durationMs ? ` · ${formatDuration(e.durationMs)}` : ''} · agora
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
