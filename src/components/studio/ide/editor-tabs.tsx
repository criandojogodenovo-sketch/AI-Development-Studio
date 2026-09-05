'use client'

// ============================================================
// EDITOR TABS — abas com dirty state, breadcrumbs e ações
// ============================================================

import { X, Save, Circle } from 'lucide-react'
import { useIde } from './use-ide'

export function EditorTabs(): React.ReactElement {
  const { tabs, activePath, setActive, closeTab, saveTab, saveActive } = useIde()
  const active = tabs.find((t) => t.path === activePath)

  return (
    <div className="flex flex-col border-b border-zinc-800/60 bg-zinc-900/60 shrink-0">
      {/* abas */}
      <div className="flex items-stretch overflow-x-auto scrollbar-none">
        {tabs.map((t) => (
          <div
            key={t.path}
            onClick={() => setActive(t.path)}
            className={`group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 text-[11px] cursor-pointer border-r border-zinc-800/60 shrink-0 max-w-52 ${
              activePath === t.path
                ? 'bg-zinc-950 text-zinc-100 border-t-2 border-t-emerald-500'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/60 border-t-2 border-t-transparent'
            }`}
          >
            <span className="truncate font-mono">{t.path.split('/').pop()}</span>
            {t.dirty ? <Circle className="w-2 h-2 fill-amber-400 text-amber-400 shrink-0" /> : null}
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(t.path) }}
              className="p-0.5 rounded opacity-40 hover:opacity-100 hover:bg-zinc-800 text-zinc-400"
              aria-label={`fechar ${t.path}`}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        {tabs.length === 0 && <span className="px-3 py-1.5 text-[11px] text-zinc-600">nenhum arquivo aberto</span>}
        {active && (
          <button
            onClick={saveActive}
            disabled={!active.dirty}
            className="ml-auto my-1 mr-2 flex items-center gap-1 px-2 rounded text-[11px] shrink-0 disabled:opacity-30 enabled:hover:bg-emerald-900/40 enabled:text-emerald-400"
            title="Salvar (Ctrl+S)"
          >
            <Save className="w-3 h-3" />
          </button>
        )}
      </div>
      {/* breadcrumbs */}
      {active && (
        <div className="flex items-center gap-1 px-3 py-1 text-[10px] text-zinc-500 border-t border-zinc-800/40 font-mono truncate">
          {active.path.split('/').map((seg, i, arr) => (
            <span key={i} className={i === arr.length - 1 ? 'text-zinc-300' : ''}>
              {seg}{i < arr.length - 1 && <span className="text-zinc-600 mx-0.5">/</span>}
            </span>
          ))}
          {active.dirty && <span className="ml-auto text-amber-400 shrink-0">não salvo</span>}
        </div>
      )}
    </div>
  )
}
