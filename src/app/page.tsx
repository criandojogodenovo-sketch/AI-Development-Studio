'use client'

// ============================================================
// AI DEVELOPMENT STUDIO — página principal (SPA mobile-first)
// Views: dashboard, projects, workspace, models, settings, activity
// ============================================================

import { useState } from 'react'
import { StudioProvider, useStudio } from '@/hooks/use-studio'
import { AuthView } from '@/components/studio/auth-view'
import { DashboardView } from '@/components/studio/dashboard-view'
import { ProjectsView } from '@/components/studio/projects-view'
import { WorkspaceView } from '@/components/studio/workspace-view'
import { ModelsView } from '@/components/studio/models-view'
import { SettingsView } from '@/components/studio/settings-view'
import { Toaster } from '@/components/ui/sonner'
import { Loader2, Bot, LayoutDashboard, FolderKanban, Cpu, Settings as SettingsIcon, Activity } from 'lucide-react'

type View = 'dashboard' | 'projects' | 'workspace' | 'models' | 'settings'

function StudioApp() {
  const { user, authChecked, activeProjectId, setActiveProject, wsConnected } = useStudio()
  const [view, setView] = useState<View>('dashboard')
  const [presetRequest, setPresetRequest] = useState<string | null>(null)

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
      </div>
    )
  }

  if (!user) return <AuthView />

  const openProject = (id: string) => {
    setActiveProject(id)
    setView('workspace')
  }

  const navigate = (target: string) => {
    if (target.startsWith('projects:')) {
      setPresetRequest(target.slice('projects:'.length))
      setView('projects')
    } else {
      setView(target as View)
    }
  }

  const navItems: Array<{ id: View; label: string; icon: any }> = [
    { id: 'dashboard', label: 'Início', icon: LayoutDashboard },
    { id: 'projects', label: 'Projetos', icon: FolderKanban },
    { id: 'workspace', label: 'Workspace', icon: Bot },
    { id: 'models', label: 'Modelos', icon: Cpu },
    { id: 'settings', label: 'Ajustes', icon: SettingsIcon },
  ]

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/75">
        <div className="mx-auto max-w-6xl px-4 h-14 flex items-center gap-3">
          <button onClick={() => { setView('dashboard'); setActiveProject(null) }} className="flex items-center gap-2 font-bold text-emerald-400">
            <Bot className="w-6 h-6" />
            <span className="hidden sm:inline">AI Development Studio</span>
            <span className="sm:hidden">AI Studio</span>
          </button>
          <span className={`ml-auto flex items-center gap-1.5 text-[10px] ${wsConnected ? 'text-emerald-500' : 'text-zinc-600'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-600'}`} />
            {wsConnected ? 'tempo real' : 'offline'}
          </span>
          <span className="text-xs text-zinc-500 truncate max-w-24">{user.name}</span>
        </div>
      </header>

      {/* Conteúdo */}
      <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-5 pb-24 md:pb-8">
        {view === 'dashboard' && (
          <DashboardView
            onOpenProject={openProject}
            onNewProject={() => setView('projects')}
            onNavigate={navigate}
          />
        )}
        {view === 'projects' && (
          <ProjectsView onOpenProject={openProject} presetRequest={presetRequest} />
        )}
        {view === 'workspace' && (
          activeProjectId ? (
            <WorkspaceView onBack={() => { setView('projects'); setActiveProject(null) }} />
          ) : (
            <div className="text-center py-16 space-y-2">
              <Activity className="w-10 h-10 mx-auto text-zinc-700" />
              <p className="text-zinc-500">Selecione um projeto em Projetos para abrir o workspace.</p>
            </div>
          )
        )}
        {view === 'models' && <ModelsView />}
        {view === 'settings' && <SettingsView />}
      </main>

      {/* Bottom nav (mobile-first) */}
      <nav className="fixed bottom-0 inset-x-0 z-40 border-t border-zinc-800/80 bg-zinc-950/95 backdrop-blur md:hidden">
        <div className="grid grid-cols-5">
          {navItems.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={`flex flex-col items-center gap-0.5 py-2.5 text-[10px] min-h-[52px] ${
                view === n.id ? 'text-emerald-400' : 'text-zinc-500'
              }`}
            >
              <n.icon className="w-5 h-5" />
              {n.label}
            </button>
          ))}
        </div>
        <div className="h-[env(safe-area-inset-bottom)]" />
      </nav>

      {/* Side nav (desktop) */}
      <nav className="hidden md:flex fixed left-4 top-1/2 -translate-y-1/2 z-40 flex-col gap-1">
        {navItems.map((n) => (
          <button
            key={n.id}
            onClick={() => setView(n.id)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
              view === n.id ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-900/60' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <n.icon className="w-4 h-4" />
            {n.label}
          </button>
        ))}
      </nav>
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
