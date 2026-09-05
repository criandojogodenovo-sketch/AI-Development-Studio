'use client'

// ============================================================
// WORKSPACE — COMMAND CENTER (Fase K)
//
// Desktop:
//   ┌─────────┬──────────────────┬────────────┐
//   │Explorer │ Tabs + Editor    │ Preview /  │
//   │         │                  │ Poskli     │
//   ├─────────┴──────────────────┴────────────┤
//   │ Terminal (painel inferior redimensionável)│
//   └──────────────────────────────────────────┘
// Mobile: hamburger já global; sub-abas Editor/Preview/Terminal/Poskli
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels'
import { useStudio } from '@/hooks/use-studio'
import { useIsMobile } from '@/hooks/use-mobile'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useIde } from './ide/use-ide'
import { IdePanel } from './ide/ide-panel'
import { TerminalPanel } from './ide/terminal-panel'
import { PreviewPanel } from './ide/preview-panel'
import { PoskliPanel } from './poskli-panel'
import { statusColor, statusLabel } from './ui-helpers'
import {
  ArrowLeft, RefreshCw, Loader2, Eye, Brain, TerminalSquare, Code2, PanelRightClose, PanelRightOpen,
} from 'lucide-react'
import { toast } from 'sonner'

type MobileTab = 'editor' | 'preview' | 'terminal' | 'poskli'
type RightPanel = 'preview' | 'poskli'

export function WorkspaceView({ onBack }: { onBack: () => void }): React.ReactElement {
  const { api, activeProjectId, liveEvents } = useStudio()
  const isMobile = useIsMobile() // UM layout por vez (sem montagem duplicada de Monaco/Explorer)
  const [project, setProject] = useState<{ id: string; name: string; status: string; type: string } | null>(null)
  const [mobileTab, setMobileTab] = useState<MobileTab>('editor')
  const [rightPanel, setRightPanel] = useState<RightPanel>('preview')
  const [rightOpen, setRightOpen] = useState(true)
  const [termOpen, setTermOpen] = useState(true)
  const [poskliPrefill, setPoskliPrefill] = useState<string | null>(null)

  const refreshTabs = useIde((s) => s.refreshTree)

  const load = useCallback(async () => {
    if (!activeProjectId) return
    try {
      const d = await api<{ project: { id: string; name: string; status: string; type: string } }>(`/api/projects/${activeProjectId}`)
      setProject(d.project)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [api, activeProjectId])

  useEffect(() => { load() }, [load])

  // eventos do projeto → refresh header (estado do pipeline)
  useEffect(() => {
    const relevant = liveEvents.some((e) => e.projectId === activeProjectId)
    if (relevant) {
      const t = setTimeout(load, 800)
      return () => clearTimeout(t)
    }
  }, [liveEvents, activeProjectId, load])

  // eventos em tempo real → editor reflete alterações do Poskli
  useEffect(() => {
    const fileChanged = liveEvents.some(
      (e) => e.projectId === activeProjectId && (e.type === 'tool.completed' || e.type === 'task.completed') && String(e.tool ?? '').match(/create_file|modify_file|delete_file|terminal|execution/)
    )
    if (fileChanged) {
      const t = setTimeout(() => refreshTabs(), 1200)
      return () => clearTimeout(t)
    }
  }, [liveEvents, activeProjectId, refreshTabs])

  const pipelineActive = project?.status === 'PLANNING' || project?.status === 'RUNNING'

  const askPoskli = useCallback((message: string) => {
    setPoskliPrefill(message)
    setRightPanel('poskli')
    setRightOpen(true)
    setMobileTab('poskli')
  }, [])

  const focusTerminal = useCallback(() => {
    setTermOpen(true)
    setMobileTab('terminal')
  }, [])

  const header = (
    <div className="flex items-center gap-2 px-3 h-11 border-b border-zinc-800/60 bg-zinc-950/90 shrink-0">
      <Button variant="ghost" size="icon" onClick={onBack} className="h-7 w-7 text-zinc-400">
        <ArrowLeft className="w-4 h-4" />
      </Button>
      <h2 className="font-bold text-sm truncate max-w-40 sm:max-w-none">{project?.name ?? 'Carregando…'}</h2>
      <Badge variant="outline" className={statusColor(project?.status)}>{statusLabel(project?.status)}</Badge>
      {pipelineActive && (
        <span className="flex items-center gap-1 text-[10px] text-emerald-400">
          <Loader2 className="w-3 h-3 animate-spin" />
          agentes em execução
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="icon" onClick={load} className="h-7 w-7">
          <RefreshCw className="w-3.5 h-3.5 text-zinc-400" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => setRightOpen(!rightOpen)} className="h-7 w-7 hidden lg:flex" title={rightOpen ? 'ocultar painel direito' : 'mostrar painel direito'}>
          {rightOpen ? <PanelRightClose className="w-4 h-4 text-zinc-400" /> : <PanelRightOpen className="w-4 h-4 text-zinc-400" />}
        </Button>
      </div>
    </div>
  )

  const mobileTabs = useMemo(() => ([
    { id: 'editor' as MobileTab, label: 'Editor', icon: Code2 },
    { id: 'preview' as MobileTab, label: 'Preview', icon: Eye },
    { id: 'terminal' as MobileTab, label: 'Terminal', icon: TerminalSquare },
    { id: 'poskli' as MobileTab, label: 'Poskli', icon: Brain },
  ]), [])

  if (!activeProjectId) return <div />

  // ===== MOBILE: sub-abas =====
  const mobileNav = (
    <div className="sticky top-12 z-30 flex border-b border-zinc-800/60 bg-zinc-950/95 backdrop-blur">
      {mobileTabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setMobileTab(t.id)}
          className={`flex-1 flex flex-col items-center gap-0.5 py-1.5 text-[9px] min-h-[42px] ${
            mobileTab === t.id ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-zinc-500'
          }`}
        >
          <t.icon className="w-4 h-4" />
          {t.label}
        </button>
      ))}
    </div>
  )

  // UM layout por vez: mobile OU desktop (nunca ambos no DOM)
  if (isMobile) {
    return (
      <div className="flex flex-col h-[calc(100dvh-3rem)] overflow-hidden">
        {header}
        {mobileNav}
        <div className="flex-1 min-h-0">
          {mobileTab === 'editor' && <IdePanel projectId={activeProjectId} />}
          {mobileTab === 'preview' && (
            <PreviewPanel projectId={activeProjectId} onRequestTerminal={focusTerminal} onAskPoskli={askPoskli} />
          )}
          {mobileTab === 'terminal' && <TerminalPanel projectId={activeProjectId} />}
          {mobileTab === 'poskli' && <PoskliPanel projectId={activeProjectId} prefill={poskliPrefill} />}
        </div>
      </div>
    )
  }

  // ===== DESKTOP: COMMAND CENTER =====
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {header}
      <div className="flex-1 min-h-0">
        <PanelGroup direction="horizontal" autoSaveId="studio-workspace">
          {/* coluna central: editor + terminal */}
          <Panel defaultSize={rightOpen ? 62 : 100} minSize={40}>
            <PanelGroup direction="vertical" autoSaveId="studio-center">
              <Panel defaultSize={termOpen ? 68 : 100} minSize={25}>
                <div className="h-full border-r border-zinc-800/60">
                  <IdePanel projectId={activeProjectId} />
                </div>
              </Panel>
              {termOpen && (
                <>
                  <PanelResizeHandle className="h-1.5 bg-zinc-900 hover:bg-emerald-800/60 transition-colors cursor-row-resize" />
                  <Panel defaultSize={32} minSize={12} maxSize={70} onCollapse={() => setTermOpen(false)} id="terminal">
                    <TerminalPanel projectId={activeProjectId} />
                  </Panel>
                </>
              )}
            </PanelGroup>
          </Panel>

          {/* painel direito: preview/poskli */}
          {rightOpen && (
            <>
              <PanelResizeHandle className="w-1.5 bg-zinc-900 hover:bg-emerald-800/60 transition-colors cursor-col-resize" />
              <Panel defaultSize={38} minSize={25} maxSize={55}>
                <div className="h-full flex flex-col border-l border-zinc-800/60">
                  {/* seletor preview/poskli */}
                  <div className="flex border-b border-zinc-800/60 bg-zinc-950/90 shrink-0">
                    <button
                      onClick={() => setRightPanel('preview')}
                      className={`flex items-center gap-1.5 px-3 py-2 text-[11px] ${rightPanel === 'preview' ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                      <Eye className="w-3.5 h-3.5" /> Preview
                    </button>
                    <button
                      onClick={() => setRightPanel('poskli')}
                      className={`flex items-center gap-1.5 px-3 py-2 text-[11px] ${rightPanel === 'poskli' ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                      <Brain className="w-3.5 h-3.5" /> Poskli
                    </button>
                    <button
                      onClick={() => setTermOpen(!termOpen)}
                      className={`ml-auto px-2.5 py-2 text-[11px] flex items-center gap-1 ${termOpen ? 'text-zinc-500 hover:text-zinc-300' : 'text-emerald-400'}`}
                      title={termOpen ? 'ocultar terminal' : 'mostrar terminal'}
                    >
                      <TerminalSquare className="w-3.5 h-3.5" />
                      {termOpen ? 'ocultar' : 'terminal'}
                    </button>
                  </div>
                  <div className="flex-1 min-h-0">
                    {rightPanel === 'preview' ? (
                      <PreviewPanel projectId={activeProjectId} onRequestTerminal={focusTerminal} onAskPoskli={askPoskli} />
                    ) : (
                      <PoskliPanel projectId={activeProjectId} prefill={poskliPrefill} />
                    )}
                  </div>
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
    </div>
  )
}
