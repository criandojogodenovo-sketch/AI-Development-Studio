'use client'

// ============================================================
// IDE STORE — estado do editor (tabs, dirty, tema, busca)
// Trabalha DIRETAMENTE com o Workspace persistido (/api/workspace)
// ============================================================

import { create } from 'zustand'
import { toast } from 'sonner'

export interface EditorTab {
  path: string
  content: string
  original: string
  dirty: boolean
  language: string
}

export type IdeTheme =
  | 'studio-dark' | 'studio-light' | 'midnight' | 'dracula' | 'nord' | 'monokai' | 'high-contrast'

export const IDE_THEMES: Array<{ id: IdeTheme; label: string }> = [
  { id: 'studio-dark', label: 'Studio Dark' },
  { id: 'studio-light', label: 'Studio Light' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'nord', label: 'Nord' },
  { id: 'monokai', label: 'Monokai' },
  { id: 'high-contrast', label: 'High Contrast' },
]

export interface TreeNode {
  path: string
  type: 'file' | 'dir'
}

type Api = <T>(path: string, init?: RequestInit) => Promise<T>

interface IdeState {
  // contexto
  projectId: string
  api: Api | null
  // tabs
  tabs: EditorTab[]
  activePath: string | null
  loading: boolean
  // tree
  tree: TreeNode[]
  treeLoading: boolean
  // prefs
  theme: IdeTheme
  minimap: boolean
  wordWrap: boolean
  // busca
  searchOpen: boolean
  searchResults: Array<{ path: string; line: number; text: string }> | null
  searching: boolean
  // reveal (abrir arquivo em linha — vindo de erro do preview/testes)
  revealFn: ((path: string, line: number) => void) | null

  init: (projectId: string, api: Api) => void
  openFile: (path: string, line?: number) => Promise<void>
  closeTab: (path: string, force?: boolean) => void
  setActive: (path: string) => void
  updateContent: (path: string, content: string) => void
  saveActive: () => Promise<void>
  saveTab: (path: string) => Promise<void>
  refreshTree: () => Promise<void>
  createFile: (path: string, content?: string) => Promise<void>
  createDir: (path: string) => Promise<void>
  deleteEntry: (path: string) => Promise<void>
  renameEntry: (from: string, to: string) => Promise<void>
  search: (q: string) => Promise<void>
  setTheme: (t: IdeTheme) => void
  toggleMinimap: () => void
  toggleWordWrap: () => void
  setSearchOpen: (open: boolean) => void
  setRevealFn: (fn: ((path: string, line: number) => void) | null) => void
  reveal: (path: string, line: number) => void
}

export function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown',
    py: 'python', yml: 'yaml', yaml: 'yaml', xml: 'xml', svg: 'xml',
    sql: 'sql', sh: 'shell', txt: 'plaintext',
  }
  return map[ext] ?? 'plaintext'
}

export const useIde = create<IdeState>((set, get) => ({
  projectId: '',
  api: null,
  tabs: [],
  activePath: null,
  loading: false,
  tree: [],
  treeLoading: false,
  theme: (typeof window !== 'undefined' && (localStorage.getItem('ide-theme') as IdeTheme)) || 'studio-dark',
  minimap: true,
  wordWrap: false,
  searchOpen: false,
  searchResults: null,
  searching: false,
  revealFn: null,

  init: (projectId, api) => {
    const { projectId: current } = get()
    set({ api })
    if (current !== projectId) {
      set({ projectId, tabs: [], activePath: null, tree: [], searchResults: null, searchOpen: false })
    }
  },

  openFile: async (path, line) => {
    const existing = get().tabs.find((t) => t.path === path)
    if (existing) {
      set({ activePath: path })
      if (line !== undefined) get().reveal(path, line)
      return
    }
    const api = get().api
    if (!api) return
    set({ loading: true })
    try {
      const d = await api<{ path: string; content: string }>(`/api/workspace/file?project=${get().projectId}&path=${encodeURIComponent(path)}`)
      set((s) => ({
        tabs: [...s.tabs, { path, content: d.content, original: d.content, dirty: false, language: languageForPath(path) }],
        activePath: path,
        loading: false,
      }))
      if (line !== undefined) get().reveal(path, line)
    } catch (e) {
      set({ loading: false })
      toast.error(`Falha ao abrir ${path}: ${(e as Error).message}`)
    }
  },

  closeTab: (path, force) => {
    const tab = get().tabs.find((t) => t.path === path)
    if (tab?.dirty && !force) {
      if (typeof window !== 'undefined' && !window.confirm(`"${path}" tem alterações não salvas. Fechar mesmo assim?`)) return
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.path !== path)
      const activePath = s.activePath === path ? (tabs.length ? tabs[tabs.length - 1].path : null) : s.activePath
      return { tabs, activePath }
    })
  },

  setActive: (path) => set({ activePath: path }),

  updateContent: (path, content) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, content, dirty: content !== t.original } : t)),
    })),

  saveActive: async () => {
    const path = get().activePath
    if (path) await get().saveTab(path)
  },

  saveTab: async (path) => {
    const api = get().api
    const tab = get().tabs.find((t) => t.path === path)
    if (!api || !tab) return
    try {
      await api('/api/workspace/file', {
        method: 'POST',
        body: JSON.stringify({ project: get().projectId, path, content: tab.content }),
      })
      set((s) => ({
        tabs: s.tabs.map((t) => (t.path === path ? { ...t, original: t.content, dirty: false } : t)),
      }))
      toast.success(`Salvo: ${path}`)
    } catch (e) {
      toast.error(`Falha ao salvar: ${(e as Error).message}`)
    }
  },

  refreshTree: async () => {
    const api = get().api
    if (!api) return
    set({ treeLoading: true })
    try {
      const d = await api<{ tree: TreeNode[] }>(`/api/workspace/tree?project=${get().projectId}`)
      set({ tree: d.tree, treeLoading: false })
    } catch {
      set({ treeLoading: false })
    }
  },

  createFile: async (path, content = '') => {
    const api = get().api
    if (!api) return
    try {
      await api('/api/workspace/file', {
        method: 'POST',
        body: JSON.stringify({ project: get().projectId, path, content }),
      })
      await get().refreshTree()
      await get().openFile(path)
      toast.success(`Arquivo criado: ${path}`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  },

  createDir: async (path) => {
    const api = get().api
    if (!api) return
    try {
      await api('/api/workspace/dir', {
        method: 'POST',
        body: JSON.stringify({ project: get().projectId, path }),
      })
      await get().refreshTree()
      toast.success(`Pasta criada: ${path}`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  },

  deleteEntry: async (path) => {
    const api = get().api
    if (!api) return
    if (typeof window !== 'undefined' && !window.confirm(`Remover "${path}"? (snapshots permitem restaurar)`)) return
    try {
      await api(`/api/workspace/entry?project=${get().projectId}&path=${encodeURIComponent(path)}`, { method: 'DELETE' })
      get().closeTab(path, true)
      await get().refreshTree()
      toast.success(`Removido: ${path}`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  },

  renameEntry: async (from, to) => {
    const api = get().api
    if (!api) return
    try {
      await api('/api/workspace/rename', {
        method: 'POST',
        body: JSON.stringify({ project: get().projectId, from, to }),
      })
      set((s) => ({
        tabs: s.tabs.map((t) => (t.path === from ? { ...t, path: to, language: languageForPath(to) } : t)),
        activePath: s.activePath === from ? to : s.activePath,
      }))
      await get().refreshTree()
      toast.success(`Renomeado: ${from} → ${to}`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  },

  search: async (q) => {
    const api = get().api
    if (!api || !q || q.length < 2) return
    set({ searching: true })
    try {
      const d = await api<{ results: Array<{ path: string; line: number; text: string }> }>(`/api/workspace/search?project=${get().projectId}&q=${encodeURIComponent(q)}`)
      set({ searchResults: d.results, searching: false, searchOpen: true })
    } catch {
      set({ searching: false })
    }
  },

  setTheme: (t) => {
    set({ theme: t })
    if (typeof window !== 'undefined') localStorage.setItem('ide-theme', t)
  },

  toggleMinimap: () => set((s) => ({ minimap: !s.minimap })),
  toggleWordWrap: () => set((s) => ({ wordWrap: !s.wordWrap })),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setRevealFn: (fn) => set({ revealFn: fn }),
  reveal: (path, line) => {
    set({ activePath: path })
    get().revealFn?.(path, line)
  },
}))
