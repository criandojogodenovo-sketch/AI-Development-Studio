'use client'

// ============================================================
// EXPLORER — árvore de arquivos do workspace persistido
// criar arquivo/pasta · renomear · remover · abrir
// ============================================================

import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  ChevronRight, ChevronDown, File as FileIcon, Folder, FolderOpen,
  FilePlus, FolderPlus, Trash2, Pencil, RefreshCw, Search,
} from 'lucide-react'
import { useIde } from './use-ide'
import { toast } from 'sonner'

interface FlatNode {
  path: string
  name: string
  depth: number
  isDir: boolean
}

export function Explorer(): React.ReactElement {
  const { tree, treeLoading, tabs, activePath, openFile, refreshTree, createFile, createDir, deleteEntry, renameEntry } = useIde()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [dialog, setDialog] = useState<{ kind: 'new-file' | 'new-dir' | 'rename'; base: string; current?: string } | null>(null)
  const [input, setInput] = useState('')

  useEffect(() => {
    refreshTree()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useIde.getState().projectId])

  const dirtySet = useMemo(() => new Set(tabs.filter((t) => t.dirty).map((t) => t.path)), [tabs])

  const visible = useMemo<FlatNode[]>(() => {
    const nodes: FlatNode[] = []
    const byParent = new Map<string, typeof tree>()
    for (const n of tree) {
      const parent = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : ''
      const arr = byParent.get(parent) ?? []
      arr.push(n)
      byParent.set(parent, arr)
    }
    const walk = (parent: string, depth: number) => {
      const children = (byParent.get(parent) ?? []).slice().sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.path.localeCompare(b.path)
      })
      for (const c of children) {
        const name = c.path.split('/').pop() ?? c.path
        if (filter && c.type === 'file' && !c.path.toLowerCase().includes(filter.toLowerCase())) continue
        nodes.push({ path: c.path, name, depth, isDir: c.type === 'dir' })
        if (c.type === 'dir' && expanded.has(c.path)) walk(c.path, depth + 1)
      }
    }
    walk('', 0)
    return nodes
  }, [tree, expanded, filter])

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const submitDialog = async () => {
    if (!dialog) return
    const value = input.trim()
    if (!value) return setDialog(null)
    try {
      if (dialog.kind === 'new-file') {
        const path = dialog.base ? `${dialog.base}/${value}` : value
        await createFile(path)
      } else if (dialog.kind === 'new-dir') {
        const path = dialog.base ? `${dialog.base}/${value}` : value
        await createDir(path)
        setExpanded((prev) => new Set([...prev, path]))
      } else if (dialog.kind === 'rename' && dialog.current) {
        const dir = dialog.current.includes('/') ? dialog.current.slice(0, dialog.current.lastIndexOf('/')) : ''
        await renameEntry(dialog.current, dir ? `${dir}/${value}` : value)
      }
    } finally {
      setDialog(null)
      setInput('')
    }
  }

  const rootBase = '' // criação na raiz

  return (
    <div className="h-full flex flex-col bg-zinc-950/80 border-r border-zinc-800/60">
      {/* toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-800/60 shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 flex-1">Explorer</span>
        <button title="Novo arquivo" onClick={() => { setDialog({ kind: 'new-file', base: rootBase }); setInput('') }}
          className="p-1 rounded text-zinc-500 hover:text-emerald-400 hover:bg-zinc-800/60">
          <FilePlus className="w-3.5 h-3.5" />
        </button>
        <button title="Nova pasta" onClick={() => { setDialog({ kind: 'new-dir', base: rootBase }); setInput('') }}
          className="p-1 rounded text-zinc-500 hover:text-emerald-400 hover:bg-zinc-800/60">
          <FolderPlus className="w-3.5 h-3.5" />
        </button>
        <button title="Atualizar" onClick={refreshTree}
          className="p-1 rounded text-zinc-500 hover:text-emerald-400 hover:bg-zinc-800/60">
          <RefreshCw className={`w-3.5 h-3.5 ${treeLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* filtro */}
      <div className="px-2 py-1.5 border-b border-zinc-800/60 shrink-0">
        <div className="relative">
          <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filtrar arquivos"
            className="w-full bg-zinc-900/70 border border-zinc-800 rounded pl-6 pr-2 py-1 text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-800"
          />
        </div>
      </div>

      {/* árvore */}
      <div className="flex-1 overflow-y-auto py-1 text-xs">
        {tree.length === 0 && (
          <p className="px-3 py-4 text-[11px] text-zinc-600 text-center">
            {treeLoading ? 'carregando…' : 'workspace vazio — crie um arquivo'}
          </p>
        )}
        {visible.map((n) => {
          const isOpen = expanded.has(n.path)
          const active = activePath === n.path
          return (
            <div key={n.path} className="group relative">
              <button
                onClick={() => (n.isDir ? toggleDir(n.path) : openFile(n.path))}
                className={`w-full flex items-center gap-1 py-[3px] pr-14 text-left hover:bg-zinc-800/50 ${active ? 'bg-emerald-950/50 text-emerald-300' : 'text-zinc-300'}`}
                style={{ paddingLeft: 8 + n.depth * 12 }}
              >
                {n.isDir ? (
                  <>
                    {isOpen ? <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" /> : <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />}
                    {isOpen ? <FolderOpen className="w-3.5 h-3.5 text-amber-500/80 shrink-0" /> : <Folder className="w-3.5 h-3.5 text-amber-500/80 shrink-0" />}
                  </>
                ) : (
                  <FileIcon className={`w-3.5 h-3.5 ml-3 shrink-0 ${dirtySet.has(n.path) ? 'text-amber-400' : 'text-zinc-500'}`} />
                )}
                <span className={`truncate ${dirtySet.has(n.path) ? 'text-amber-300' : ''}`}>{n.name}</span>
                {dirtySet.has(n.path) && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 ml-1" title="não salvo" />}
              </button>
              {/* ações por item */}
              <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-0.5">
                <button title="Renomear" onClick={() => { setDialog({ kind: 'rename', base: '', current: n.path }); setInput(n.name) }}
                  className="p-0.5 rounded text-zinc-500 hover:text-sky-400 hover:bg-zinc-800">
                  <Pencil className="w-3 h-3" />
                </button>
                <button title="Remover" onClick={() => deleteEntry(n.path)}
                  className="p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800">
                  <Trash2 className="w-3 h-3" />
                </button>
                {n.isDir && (
                  <>
                    <button title="Novo arquivo aqui" onClick={() => { setDialog({ kind: 'new-file', base: n.path }); setInput('') }}
                      className="p-0.5 rounded text-zinc-500 hover:text-emerald-400 hover:bg-zinc-800">
                      <FilePlus className="w-3 h-3" />
                    </button>
                    <button title="Nova pasta aqui" onClick={() => { setDialog({ kind: 'new-dir', base: n.path }); setInput('') }}
                      className="p-0.5 rounded text-zinc-500 hover:text-emerald-400 hover:bg-zinc-800">
                      <FolderPlus className="w-3 h-3" />
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* dialog inline */}
      {dialog && (
        <div className="p-2 border-t border-zinc-800/60 bg-zinc-900/80 shrink-0">
          <p className="text-[10px] text-zinc-500 mb-1">
            {dialog.kind === 'new-file' ? 'Novo arquivo' : dialog.kind === 'new-dir' ? 'Nova pasta' : 'Renomear'}
            {dialog.base ? ` em ${dialog.base}/` : ''}
          </p>
          <div className="flex gap-1">
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitDialog()
                if (e.key === 'Escape') setDialog(null)
              }}
              placeholder={dialog.kind === 'new-dir' ? 'pasta/' : 'arquivo.js'}
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-emerald-800"
            />
            <button onClick={submitDialog} className="px-2 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-[11px]">
              ok
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
