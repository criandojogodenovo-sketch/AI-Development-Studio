'use client'

// ============================================================
// CODE EDITOR — Monaco Editor (assets LOCAIS em /public/monaco,
// nunca CDN). 7 temas: Studio Dark/Light, Midnight, Dracula,
// Nord, Monokai, High Contrast. Ctrl+S salva. Reveal de linha.
// ============================================================

import { useRef, useEffect, useCallback } from 'react'
import * as monacoApi from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import { useIde } from './use-ide'

// carrega Monaco dos assets locais (antes do primeiro mount)
loader.config({ paths: { vs: '/monaco/vs' } })

// Workers do Monaco PRECISAM de URL absoluta (worker não resolve relativo).
// Blob URL herda a ORIGEM da página → importScripts do workerMain funciona.
if (typeof window !== 'undefined' && !(window as { MonacoEnvironment?: unknown }).MonacoEnvironment) {
  ;(window as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorkerUrl: () => {
      const baseUrl = `${window.location.origin}/monaco/vs/`
      const code = `self.MonacoEnvironment={baseUrl:'${baseUrl}'};importScripts('${baseUrl}base/worker/workerMain.js');`
      return URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
    },
  }
}

// ---------- TEMAS (defineTheme) ----------
interface ThemeSpec {
  base: 'vs' | 'vs-dark' | 'hc-black'
  bg: string
  fg: string
  comment: string
  keyword: string
  string: string
  number: string
  selection: string
  lines: string
  cursor: string
}

const THEME_SPECS: Record<string, ThemeSpec> = {
  'studio-dark': {
    base: 'vs-dark', bg: '#101014', fg: '#d4d4d8', comment: '#6b7280',
    keyword: '#34d399', string: '#fbbf24', number: '#f472b6',
    selection: '#064e3b88', lines: '#27272a', cursor: '#34d399',
  },
  'studio-light': {
    base: 'vs', bg: '#fafafa', fg: '#27272a', comment: '#9ca3af',
    keyword: '#059669', string: '#b45309', number: '#be185d',
    selection: '#a7f3d088', lines: '#e4e4e7', cursor: '#059669',
  },
  midnight: {
    base: 'vs-dark', bg: '#0b1020', fg: '#c7d0e0', comment: '#5a6a8a',
    keyword: '#7aa2f7', string: '#e0af68', number: '#ff9e64',
    selection: '#24335588', lines: '#1b2440', cursor: '#7aa2f7',
  },
  dracula: {
    base: 'vs-dark', bg: '#282a36', fg: '#f8f8f2', comment: '#6272a4',
    keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9',
    selection: '#44475a88', lines: '#44475a', cursor: '#ff79c6',
  },
  nord: {
    base: 'vs-dark', bg: '#2e3440', fg: '#d8dee9', comment: '#616e88',
    keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead',
    selection: '#434c5e88', lines: '#3b4252', cursor: '#88c0d0',
  },
  monokai: {
    base: 'vs-dark', bg: '#272822', fg: '#f8f8f2', comment: '#75715e',
    keyword: '#f92672', string: '#e6db74', number: '#ae81ff',
    selection: '#49483e88', lines: '#3e3d32', cursor: '#f8f8f0',
  },
  'high-contrast': {
    base: 'hc-black', bg: '#000000', fg: '#ffffff', comment: '#7f7f7f',
    keyword: '#ffd700', string: '#00ff00', number: '#ff6fff',
    selection: '#3333ff66', lines: '#2a2a2a', cursor: '#ffffff',
  },
}

let themesRegistered = false
function registerThemes(monaco: typeof monacoApi): void {
  if (themesRegistered) return
  themesRegistered = true
  for (const [name, spec] of Object.entries(THEME_SPECS)) {
    monaco.editor.defineTheme(name, {
      base: spec.base,
      inherit: true,
      rules: [
        { token: 'comment', foreground: spec.comment.slice(1), fontStyle: 'italic' },
        { token: 'keyword', foreground: spec.keyword.slice(1) },
        { token: 'string', foreground: spec.string.slice(1) },
        { token: 'number', foreground: spec.number.slice(1) },
        { token: 'type', foreground: spec.keyword.slice(1) },
        { token: 'identifier', foreground: spec.fg.slice(1) },
      ],
      colors: {
        'editor.background': spec.bg,
        'editor.foreground': spec.fg,
        'editor.selectionBackground': spec.selection,
        'editor.lineHighlightBackground': spec.lines + '55',
        'editorLineNumber.foreground': spec.comment,
        'editorLineNumber.activeForeground': spec.fg,
        'editorCursor.foreground': spec.cursor,
        'editorIndentGuide.background1': spec.lines,
        'minimap.background': spec.bg,
      },
    })
  }
}

export function MonacoCodeEditor(): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monacoApi.editor.IStandaloneCodeEditor | null>(null)
  const pathRef = useRef<string | null>(null)
  const { tabs, activePath, loading, theme, minimap, wordWrap, updateContent, saveActive, setRevealFn } = useIde()

  const activeTab = tabs.find((t) => t.path === activePath)

  // ---- cria o editor UMA vez (container SEMPRE renderizado — bugfix:
  //      antes o container só existia com arquivo aberto e o Monaco nunca
  //      era criado; estados vazios agora são OVERLAYS) ----
  useEffect(() => {
    if (!containerRef.current || editorRef.current) return
    let cancelled = false

    // @monaco-editor/react expõe o monaco via loader
    loader.init().then((monaco) => {
      if (cancelled || !containerRef.current) return
      registerThemes(monaco)
      const editor = monaco.editor.create(containerRef.current, {
        value: '',
        language: 'plaintext',
        theme: 'studio-dark',
        automaticLayout: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
        minimap: { enabled: true },
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        bracketPairColorization: { enabled: true },
        padding: { top: 10 },
      })
      editorRef.current = editor

      // Ctrl+S / Cmd+S → salvar
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveActive()
      })

      // mudanças → store (dirty state)
      editor.onDidChangeModelContent(() => {
        const p = pathRef.current
        if (p) updateContent(p, editor.getValue())
      })
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- troca de tema ----
  useEffect(() => {
    loader.init().then((monaco) => {
      registerThemes(monaco)
      monaco.editor.setTheme(theme)
    })
  }, [theme])

  // ---- opções (minimap, wrap) ----
  useEffect(() => {
    loader.init().then(() => {
      editorRef.current?.updateOptions({
        minimap: { enabled: minimap },
        wordWrap: wordWrap ? 'on' : 'off',
      })
    })
  }, [minimap, wordWrap])

  // ---- troca de arquivo/tab ----
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    loader.init().then((monaco) => {
      if (!editorRef.current) return
      if (!activeTab) {
        pathRef.current = null
        return
      }
      const path = activeTab.path
      if (pathRef.current !== path) {
        pathRef.current = path
        const model = monaco.editor.createModel(activeTab.content, activeTab.language, monaco.Uri.parse('inmemory://studio/' + path))
        editor.setModel(model)
      } else {
        // conteúdo externo mudou (Poskli editou o arquivo) — sincroniza SEM
        // sobrescrever se o usuário tem edição não salva (preserva dirty)
        const current = editor.getValue()
        if (current === activeTab.original && activeTab.content !== current) {
          pathRef.current = null // força re-set do model no próximo ciclo
        }
      }
    })
  }, [activePath, activeTab])

  // ---- revealAtLine: abre arquivo em linha (erros de preview/testes) ----
  useEffect(() => {
    setRevealFn((path, line) => {
      const editor = editorRef.current
      if (!editor || pathRef.current !== path) return
      editor.revealLineInCenter(Math.max(1, line))
      editor.setPosition({ lineNumber: Math.max(1, line), column: 1 })
      editor.focus()
    })
    return () => setRevealFn(null)
  }, [setRevealFn])

  // ---- render: container SEMPRE no DOM; estados são overlays ----
  return (
    <div className="h-full w-full relative">
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ display: activeTab ? 'block' : 'none' }}
        aria-label="monaco-editor"
      />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950">
          <span className="text-xs text-zinc-600">carregando arquivo…</span>
        </div>
      )}
      {!loading && !activeTab && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950 text-center">
          <span className="text-3xl opacity-20 font-mono">{'</>'}</span>
          <p className="text-sm text-zinc-500">Abra um arquivo no Explorer</p>
          <p className="text-[11px] text-zinc-600">Ctrl+S salva · Ctrl+P busca arquivos</p>
        </div>
      )}
    </div>
  )
}
