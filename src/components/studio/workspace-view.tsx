'use client'

// ============================================================
// WORKSPACE — CHAT CONVERSACIONAL (reconstrução)
// ============================================================
// O CHAT É A INTERFACE PRIMÁRIA (estilo Grok/ChatGPT): o
// utilizador escreve no centro e o agente trabalha por trás
// das cortinas. Editor, Terminal, Explorer e Preview estão
// OCULTOS POR DEFEITO — um botão discreto "Ver Detalhes
// Técnicos" abre um painel colapsável para quem quiser
// inspecionar código/terminal. NUNCA como interface principal.
//
// Desktop:   [ Chat (central) | Detalhes Técnicos (opcional) ]
// Mobile:    Chat em ecrã cheio; detalhes em overlay.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
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
import { ChatView } from './chat/chat-view'
import { statusColor, statusLabel } from './ui-helpers'
import {
  ArrowLeft, Loader2, Eye, TerminalSquare, Code2, FileCode2, X, Wrench,
} from 'lucide-react'

type TechTab = 'editor' | 'terminal' | 'preview' | 'run'

const TECH_TABS: Array<{ id: TechTab; label: string; icon: typeof Code2 }> = [
  { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'run', label: 'Execução', icon: Wrench },
]

export function WorkspaceView({ prefill, onConsumePrefill, onBack }: {
  prefill?: string | null
  onConsumePrefill?: () => void
  onBack: () => void
}): React.ReactElement {
  const { activeProjectId, setActiveProject, liveEvents, refreshProjects, projects } = useStudio()
  const isMobile = useIsMobile()
  const [techOpen, setTechOpen] = useState(false) // OCULTO por defeito
  const [techTab, setTechTab] = useState<TechTab>('editor')

  const refreshTabs = useIde((s) => s.refreshTree)

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null
  const pipelineActive = activeProject?.status === 'PLANNING' || activeProject?.status === 'RUNNING'

  // eventos em tempo real → editor reflete alterações do agente
  useEffect(() => {
    const fileChanged = liveEvents.some(
      (e) => e.projectId === activeProjectId && (e.type === 'tool.completed' || e.type === 'task.completed') && String(e.tool ?? '').match(/create_file|modify_file|delete_file|terminal|execution/)
    )
    if (fileChanged) {
      const t = setTimeout(() => refreshTabs(), 1200)
      return () => clearTimeout(t)
    }
  }, [liveEvents, activeProjectId, refreshTabs])

  const handleProjectCreated = useCallback((id: string) => {
    setActiveProject(id)
    refreshProjects().catch(() => {})
  }, [setActiveProject, refreshProjects])

  // ---------- painel de detalhes técnicos (colapsável) ----------
  const techContent = (
    <div className="h-full flex flex-col bg-zinc-950 min-h-0">
      <div className="flex items-center border-b border-zinc-800/60 bg-zinc-950/95 shrink-0 overflow-x-auto">
        {TECH_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTechTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-[11px] whitespace-nowrap ${
              techTab === t.id ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
        {isMobile && (
          <button
            onClick={() => setTechOpen(false)}
            className="ml-auto px-2.5 py-2 text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
          >
            <X className="w-3.5 h-3.5" /> fechar
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0">
        {techTab === 'editor' && activeProjectId && <IdePanel projectId={activeProjectId} />}
        {techTab === 'terminal' && activeProjectId && <TerminalPanel projectId={activeProjectId} />}
        {techTab === 'preview' && activeProjectId && (
          <PreviewPanel projectId={activeProjectId} onRequestTerminal={() => setTechTab('terminal')} onAskPoskli={() => setTechOpen(false)} />
        )}
        {techTab === 'run' && activeProjectId && <PoskliPanel projectId={activeProjectId} embedded />}
      </div>
    </div>
  )

  // ---------- header ----------
  const header = (
    <div className="flex items-center gap-2 px-3 h-11 border-b border-zinc-800/60 bg-zinc-950/90 shrink-0">
      <Button variant="ghost" size="icon" onClick={onBack} className="h-7 w-7 text-zinc-400">
        <ArrowLeft className="w-4 h-4" />
      </Button>
      <h2 className="font-bold text-sm truncate max-w-32 sm:max-w-none">
        {activeProject?.name ?? 'Nova conversa'}
      </h2>
      {activeProject && (
        <Badge variant="outline" className={statusColor(activeProject.status)}>{statusLabel(activeProject.status)}</Badge>
      )}
      {pipelineActive && (
        <span className="flex items-center gap-1 text-[10px] text-emerald-400">
          <Loader2 className="w-3 h-3 animate-spin" />
          agente em execução
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {/* botão DISCRETO — detalhes técnicos ocultos por defeito */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTechOpen(!techOpen)}
          disabled={!activeProjectId}
          title={
            !activeProjectId
              ? 'Disponível após o primeiro projeto'
              : techOpen
                ? 'Ocultar código, terminal e execuções'
                : 'Ver código, terminal e execuções (opcional)'
          }
          className={`h-7 text-[11px] gap-1.5 ${
            techOpen ? 'text-zinc-300' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {techOpen ? <X className="w-3.5 h-3.5" /> : <FileCode2 className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{techOpen ? 'Ocultar Detalhes' : 'Ver Detalhes Técnicos'}</span>
        </Button>
      </div>
    </div>
  )

  // ---------- chat (interface primária) ----------
  const chat = (
    <ChatView
      projectId={activeProjectId}
      prefill={prefill}
      onProjectCreated={handleProjectCreated}
      onPrefillConsumed={onConsumePrefill}
    />
  )

  // ===== MOBILE: chat em ecrã cheio; detalhes em overlay =====
  if (isMobile) {
    return (
      <div className="flex flex-col h-[calc(100dvh-3rem)] overflow-hidden">
        {header}
        <div className="flex-1 min-h-0">{chat}</div>
        {techOpen && (
          <div className="fixed inset-0 z-40 top-[3rem] bg-zinc-950">{techContent}</div>
        )}
      </div>
    )
  }

  // ===== DESKTOP: chat central + detalhes colapsáveis =====
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {header}
      <div className="flex-1 min-h-0">
        {techOpen ? (
          <PanelGroup direction="horizontal" autoSaveId="studio-chat-workspace">
            <Panel defaultSize={58} minSize={40}>
              <div className="h-full border-r border-zinc-800/60">{chat}</div>
            </Panel>
            <PanelResizeHandle className="w-1.5 bg-zinc-900 hover:bg-emerald-800/60 transition-colors cursor-col-resize" />
            <Panel defaultSize={42} minSize={25} maxSize={60}>
              {techContent}
            </Panel>
          </PanelGroup>
        ) : (
          <div className="h-full">{chat}</div>
        )}
      </div>
    </div>
  )
}
