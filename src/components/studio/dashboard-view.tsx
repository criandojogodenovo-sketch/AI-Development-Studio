'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { useStudio } from '@/hooks/use-studio'
import { statusColor, statusLabel, eventIcon, timeAgo } from './ui-helpers'
import { Button } from '@/components/ui/button'
import { FolderKanban, Zap, Coins, Activity, ArrowRight, Gamepad2 } from 'lucide-react'

export function DashboardView({ onOpenProject, onNewProject, onNavigate }: {
  onOpenProject: (id: string) => void
  onNewProject: () => void
  onNavigate: (view: string) => void
}) {
  const { projects, liveEvents, events, templates, wsConnected } = useStudio()

  const totals = {
    projects: projects.length,
    running: projects.filter((p) => ['RUNNING', 'PLANNING', 'REVIEW'].includes(p.status)).length,
    completed: projects.filter((p) => p.status === 'COMPLETED').length,
    tasks: projects.reduce((a, p) => a + p.tasksTotal, 0),
    tasksDone: projects.reduce((a, p) => a + p.tasksCompleted, 0),
  }
  // Feed com deduplicação por identidade (WS pode reentregar evento já buscado do banco)
  const seen = new Set<string>()
  const feed = [...liveEvents, ...events]
    .filter((e) => {
      const key = e.id ? `id:${e.id}` : `${e.type}:${e.message}:${e.createdAt ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 12)

  const stats = [
    { label: 'Projetos', value: totals.projects, icon: FolderKanban, hint: `${totals.running} em execução` },
    { label: 'Tarefas concluídas', value: `${totals.tasksDone}/${totals.tasks}`, icon: Zap, hint: 'grafo de tarefas' },
    { label: 'Concluídos', value: totals.completed, icon: Coins, hint: 'pipelines finalizados' },
    { label: 'Eventos', value: liveEvents.length + events.length, icon: Activity, hint: 'atividade do estúdio' },
  ]

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((s) => (
          <Card key={s.label} className="border-zinc-800 bg-zinc-900/60">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-zinc-500">{s.label}</p>
                  <p className="text-2xl font-bold">{s.value}</p>
                  <p className="text-[11px] text-zinc-600">{s.hint}</p>
                </div>
                <s.icon className="w-8 h-8 text-emerald-500/70" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-900/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gamepad2 className="w-4 h-4 text-emerald-400" />
            O que os agentes vão construir hoje?
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {[
            'Cria um mini-game 2D de sobrevivência para celular.',
            'Cria uma landing page para minha empresa.',
            'Cria uma API REST de tarefas.',
          ].map((s) => (
            <button
              key={s}
              onClick={() => onNavigate('projects:' + s)}
              className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-left text-sm text-zinc-300 hover:border-emerald-600/50 hover:text-emerald-300 transition-colors"
            >
              <span>{s}</span>
              <ArrowRight className="w-4 h-4 opacity-50" />
            </button>
          ))}
          <Button size="sm" variant="outline" onClick={onNewProject} className="mt-1 border-emerald-700/50 text-emerald-400 hover:bg-emerald-950">
            Novo projeto do zero
          </Button>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-zinc-400">Projetos recentes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 max-h-96 overflow-y-auto">
            {projects.length === 0 && <p className="text-sm text-zinc-500">Nenhum projeto ainda — crie o primeiro.</p>}
            {projects.slice(0, 6).map((p) => (
              <button
                key={p.id}
                onClick={() => onOpenProject(p.id)}
                className="w-full text-left rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 hover:border-emerald-700/40 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm truncate">{p.name}</span>
                  <Badge variant="outline" className={`${statusColor(p.status)} shrink-0`}>{statusLabel(p.status)}</Badge>
                </div>
                <Progress value={p.percent} className="h-1.5 mt-2" />
                <div className="flex justify-between text-[11px] text-zinc-500 mt-1">
                  <span>{p.tasksCompleted}/{p.tasksTotal} tarefas</span>
                  <span>{timeAgo(p.updatedAt)}</span>
                </div>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-zinc-400 flex items-center justify-between">
              Atividade
              {wsConnected && (
                <span className="flex items-center gap-1 text-[10px] text-emerald-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> ao vivo
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="max-h-96 overflow-y-auto space-y-1.5">
            {feed.length === 0 && <p className="text-sm text-zinc-500">Sem eventos ainda — inicie um pipeline.</p>}
            {feed.map((e, i) => (
              <div key={e.id ?? i} className="flex items-start gap-2 text-xs border-b border-zinc-800/50 pb-1.5">
                <span>{eventIcon(e.type)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-zinc-300 break-words">{e.message}</p>
                  <p className="text-zinc-500 text-[10px]">{e.createdAt ? timeAgo(e.createdAt) : 'agora'}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
