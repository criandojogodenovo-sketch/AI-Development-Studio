'use client'

// ============================================================
// AI DEVELOPMENT STUDIO — FASE 2 — SHELL DE NAVEGAÇÃO
// Desktop: sidebar fixa. Mobile: hamburger + drawer.
// Seções: Início · Projetos · Workspace · Execuções · Git ·
//         Modelos · Ajustes · Diagnóstico
// SEM tabs inferiores. Ícones Lucide (nunca emojis).
// ============================================================

import { useState, useCallback } from 'react'
import { StudioProvider, useStudio } from '@/hooks/use-studio'
import { AuthView } from '@/components/studio/auth-view'
import { DashboardView } from '@/components/studio/dashboard-view'
import { ProjectsView } from '@/components/studio/projects-view'
import { WorkspaceView } from '@/components/studio/workspace-view'
import { ModelsView } from '@/components/studio/models-view'
import { SettingsView } from '@/components/studio/settings-view'
import { ExecutionsView } from '@/components/studio/executions-view'
import { GitView } from '@/components/studio/git-view'
import { DiagnosticsView } from '@/components/studio/diagnostics-view'
import { Toaster } from '@/components/ui/sonner'
import {
  Loader2, Bot, LayoutDashboard, FolderKanban, TerminalSquare, GitBranch,
  Cpu, Settings as SettingsIcon, Stethoscope, Menu, X, LogOut, ChevronRight,
} from 'lucide-react'

type View = 'dashboard' | 'projects' | 'workspace' | 'executions' | 'git' | 'models' | 'settings' | 'diagnostics'

const NAV_ITEMS: Array<{ id: View; label: string; icon: typeof Bot; needsProject?: boolean }> = [
  { id: 'dashboard', label: 'Início', icon: LayoutDashboard },
  { id: 'projects', label: 'Projetos', icon: FolderKanban },
  { id: 'workspace', label: 'Workspace', icon: Bot, needsProject: true },
  { id: 'executions', label: 'Execuções', icon: TerminalSquare, needsProject: true },
  { id: 'git', label: 'Git', icon: GitBranch, needsProject: true },
  { id: 'models', label: 'Modelos', icon: Cpu },
  { id: 'settings', label: 'Ajustes', icon: SettingsIcon },
  { id: 'diagnostics', label: 'Diagnóstico', icon: Stethoscope },
]

function StudioApp() {
  const { user, authChecked, activeProjectId, setActiveProject, wsConnected, projects, logout } = useStudio()
  const [view, setView] = useState<View>('dashboard')
  const [presetRequest, setPresetRequest] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const navigate = useCallback((target: string) => {
    if (target.startsWith('projects:')) {
      setPresetRequest(target.slice('projects:'.length))
      setView('projects')
    } else {
      setView(target as View)
    }
    setDrawerOpen(false)
  }, [])

  const openProject = useCallback((id: string) => {
    setActiveProject(id)
    setView('workspace')
    setDrawerOpen(false)
  }, [setActiveProject])

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
      </div>
    )
  }

  if (!user) return <AuthView />

  const activeProject = projects.find((p) => p.id === activeProjectId)
  const currentLabel = NAV_ITEMS.find((n) => n.id === view)?.label ?? ''

  const navContent = (
    <>
      {/* marca */}
      <button
        onClick={() => { navigate('dashboard'); setActiveProject(null) }}
        className="flex items-center gap-2.5 px-3 py-3 mb-1 w-full group"
      >
        <span className="w-8 h-8 rounded-lg bg-emerald-600/15 border border-emerald-800/60 flex items-center justify-center shrink-0 group-hover:border-emerald-600/60 transition-colors">
          <Bot className="w-4.5 h-4.5 text-emerald-400" />
        </span>
        <span className="text-left leading-tight">
          <span className="block text-[13px] font-bold text-zinc-100">AI Development</span>
          <span className="block text-[13px] font-bold text-emerald-400">Studio</span>
        </span>
      </button>

      {/* projeto ativo */}
      {activeProject && (
        <div className="mx-3 mb-2 px-2.5 py-2 rounded-lg bg-zinc-900/70 border border-zinc-800/60">
          <p className="text-[9px] uppercase tracking-wider text-zinc-600 font-semibold mb-0.5">Projeto ativo</p>
          <p className="text-[11px] text-zinc-300 truncate font-medium">{activeProject.name}</p>
        </div>
      )}

      {/* navegação */}
      <nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {NAV_ITEMS.map((n) => {
          const blocked = n.needsProject && !activeProjectId
          return (
            <button
              key={n.id}
              onClick={() => (blocked ? navigate('projects') : navigate(n.id))}
              title={blocked ? 'Selecione um projeto primeiro' : n.label}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] transition-colors ${
                view === n.id
                  ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-900/50'
                  : blocked
                    ? 'text-zinc-600 hover:text-zinc-500'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
              }`}
            >
              <n.icon className="w-4 h-4 shrink-0" />
              <span className="flex-1 text-left truncate">{n.label}</span>
              {blocked && <ChevronRight className="w-3 h-3 opacity-40" />}
            </button>
          )
        })}
      </nav>

      {/* rodapé: usuário + logout */}
      <div className="p-2 border-t border-zinc-800/60">
        <div className="flex items-center gap-2 px-1.5 py-1.5">
          <span className="w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-[10px] font-bold text-zinc-300 shrink-0">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="text-[11px] text-zinc-400 truncate flex-1">{user.name}</span>
          <button onClick={logout} title="sair" className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800/60">
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
        {wsConnected && (
          <p className="px-2 pb-1 text-[9px] text-emerald-500 flex items-center gap-1">
            <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" /> tempo real conectado
          </p>
        )}
      </div>
    </>
  )

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* ===== SIDEBAR DESKTOP ===== */}
      <aside className="hidden md:flex fixed left-0 top-0 bottom-0 w-52 z-40 flex-col border-r border-zinc-800/60 bg-zinc-950/90 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/70">
        {navContent}
      </aside>

      {/* ===== DRAWER MOBILE ===== */}
      {drawerOpen && (
        <>
          <div className="md:hidden fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <aside className="md:hidden fixed left-0 top-0 bottom-0 w-64 z-50 flex flex-col border-r border-zinc-800/60 bg-zinc-950 shadow-2xl slide-in-left">
            <button onClick={() => setDrawerOpen(false)} className="absolute right-2 top-2 p-1.5 rounded text-zinc-500 hover:text-zinc-200">
              <X className="w-4 h-4" />
            </button>
            {navContent}
          </aside>
        </>
      )}

      {/* ===== CONTEÚDO ===== */}
      <div className="md:pl-52 flex flex-col min-h-screen">
        {/* header mobile */}
        <header className="md:hidden sticky top-0 z-40 flex items-center gap-2 h-12 px-3 border-b border-zinc-800/60 bg-zinc-950/90 backdrop-blur">
          <button onClick={() => setDrawerOpen(true)} className="p-2 -ml-1 rounded-lg text-zinc-400 hover:bg-zinc-900/60" aria-label="menu">
            <Menu className="w-5 h-5" />
          </button>
          <span className="flex items-center gap-1.5 font-bold text-[13px] text-emerald-400">
            <Bot className="w-4 h-4" />
            AI Studio
          </span>
          <span className="ml-auto text-[11px] text-zinc-500 truncate max-w-28">{currentLabel}</span>
        </header>

        {/* views */}
        <main className={`flex-1 min-h-0 ${view === 'workspace' && activeProjectId ? '' : 'mx-auto w-full max-w-6xl px-3 py-4 md:px-6 md:py-6'}`}>
          {view === 'dashboard' && (
            <DashboardView onOpenProject={openProject} onNewProject={() => navigate('projects')} onNavigate={navigate} />
          )}
          {view === 'projects' && (
            <ProjectsView onOpenProject={openProject} presetRequest={presetRequest} />
          )}
          {view === 'workspace' && (
            activeProjectId ? (
              <WorkspaceView onBack={() => { navigate('projects'); setActiveProject(null) }} />
            ) : (
              <div className="text-center py-16 space-y-2">
                <Bot className="w-10 h-10 mx-auto text-zinc-700" />
                <p className="text-zinc-500">Selecione um projeto em Projetos para abrir o Workspace.</p>
              </div>
            )
          )}
          {view === 'executions' && <ExecutionsView />}
          {view === 'git' && <GitView />}
          {view === 'models' && <ModelsView />}
          {view === 'settings' && <SettingsView />}
          {view === 'diagnostics' && <DiagnosticsView />}
        </main>
      </div>
    </div>
  )
}

export default function Home() {
  return (
    <StudioProvider>
      <StudioApp />
      <Toaster theme="dark" position="top-center" richColors />
    </StudioProvider>
  )
}
