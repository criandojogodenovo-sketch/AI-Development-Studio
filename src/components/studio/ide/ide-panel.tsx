'use client'

// ============================================================
// IDE PANEL — Explorer | Tabs | Monaco + busca + preferências
// Montado pelo layout do Workspace (C8). Integra com o Studio
// (auth) e mantém tabs sincronizadas com o workspace persistido.
// ============================================================

import { useEffect, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { useStudio } from '@/hooks/use-studio'
import { useIde, IDE_THEMES } from './use-ide'
import { Explorer } from './explorer'
import { EditorTabs } from './editor-tabs'
import { Search, X, Map, WrapText, Palette, SaveAll } from 'lucide-react'

const MonacoCodeEditor = dynamic(() => import('./code-editor').then((m) => m.MonacoCodeEditor), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center bg-zinc-950">
      <span className="text-xs text-zinc-600">carregando editor…</span>
    </div>
  ),
})

/** Busca textual no workspace (resultados clicáveis). */
function SearchOverlay(): React.ReactElement | null {
  const { searchOpen, searchResults, searching, setSearchOpen, openFile } = useIde()
  const [q, setQ] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchOpen(false)
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault()
        setSearchOpen(!searchOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searchOpen, setSearchOpen])

  if (!searchOpen) return null

  return (
    <div className="absolute inset-x-0 top-0 z-20 p-2 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 shadow-xl">
      <div className="flex items-center gap-2">
        <Search className="w-4 h-4 text-zinc-500 shrink-0" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') useIde.getState().search(q)
          }}
          placeholder="buscar nos arquivos (Enter) — Ctrl+P abre/fecha"
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-800"
        />
        {searching && <span className="text-[10px] text-zinc-500">buscando…</span>}
        <button onClick={() => setSearchOpen(false)} className="p-1 rounded text-zinc-500 hover:text-zinc-200">
          <X className="w-4 h-4" />
        </button>
      </div>
      {searchResults && (
        <div className="mt-2 max-h-64 overflow-y-auto text-[11px] font-mono">
          {searchResults.length === 0 && <p className="text-zinc-600 p-2">nenhuma ocorrência</p>}
          {searchResults.map((r, i) => (
            <button
              key={i}
              onClick={() => { openFile(r.path, r.line); setSearchOpen(false) }}
              className="w-full text-left px-2 py-1 hover:bg-zinc-800/60 rounded truncate"
            >
              <span className="text-emerald-400">{r.path}:{r.line}</span>
              <span className="text-zinc-400 ml-2 truncate">{r.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Barra de preferências do editor (tema, minimap, wrap). */
function IdeToolbar(): React.ReactElement {
  const { theme, setTheme, minimap, toggleMinimap, wordWrap, toggleWordWrap, tabs, saveTab } = useIde()
  const [themeOpen, setThemeOpen] = useState(false)
  const dirtyCount = tabs.filter((t) => t.dirty).length

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-zinc-800/60 bg-zinc-900/40 text-[10px] text-zinc-500 shrink-0">
      <span className="font-semibold uppercase tracking-wider">Editor</span>
      <div className="flex-1" />
      {dirtyCount > 0 && (
        <button
          onClick={() => tabs.filter((t) => t.dirty).forEach((t) => saveTab(t.path))}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-amber-400 hover:bg-zinc-800/60"
          title="salvar todos"
        >
          <SaveAll className="w-3 h-3" />
          {dirtyCount}
        </button>
      )}
      <button onClick={toggleMinimap} title="minimapa" className={`p-1 rounded hover:bg-zinc-800/60 ${minimap ? 'text-emerald-400' : ''}`}>
        <Map className="w-3 h-3" />
      </button>
      <button onClick={toggleWordWrap} title="quebra de linha" className={`p-1 rounded hover:bg-zinc-800/60 ${wordWrap ? 'text-emerald-400' : ''}`}>
        <WrapText className="w-3 h-3" />
      </button>
      <div className="relative">
        <button onClick={() => setThemeOpen(!themeOpen)} title="tema" className="p-1 rounded hover:bg-zinc-800/60 flex items-center gap-1">
          <Palette className="w-3 h-3" />
          <span className="hidden sm:inline">{IDE_THEMES.find((t) => t.id === theme)?.label}</span>
        </button>
        {themeOpen && (
          <div className="absolute right-0 top-6 z-30 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-36">
            {IDE_THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => { setTheme(t.id); setThemeOpen(false) }}
                className={`w-full text-left px-3 py-1.5 hover:bg-zinc-800/70 ${theme === t.id ? 'text-emerald-400' : 'text-zinc-300'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function IdePanel({ projectId }: { projectId: string }): React.ReactElement {
  const { api } = useStudio()
  const init = useIde((s) => s.init)
  const refreshTree = useIde((s) => s.refreshTree)
  const saveActive = useIde((s) => s.saveActive)

  useEffect(() => {
    if (projectId) init(projectId, api)
  }, [projectId, api, init])

  // primeiro load da árvore quando o projeto muda
  useEffect(() => {
    if (projectId) refreshTree()
  }, [projectId, refreshTree])

  // Ctrl+S global (fallback fora do Monaco)
  const onKey = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      saveActive()
    }
  }, [saveActive])
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKey])

  return (
    <div className="h-full flex min-h-0 relative">
      {/* Explorer (largura fixa; C8 envolve em painel redimensionável) */}
      <div className="w-48 sm:w-56 shrink-0 hidden md:block">
        <Explorer />
      </div>
      {/* Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        <IdeToolbar />
        <EditorTabs />
        <div className="flex-1 min-h-0 relative">
          <SearchOverlay />
          <MonacoCodeEditor />
        </div>
      </div>
    </div>
  )
}
