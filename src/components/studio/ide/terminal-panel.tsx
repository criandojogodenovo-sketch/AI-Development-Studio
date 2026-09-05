'use client'

// ============================================================
// TERMINAL — terminal REAL integrado ao Execution Engine
// streaming SSE em tempo real · tabs · histórico · stop · clear ·
// restart · exit code + duração honestos
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, X, Square, Trash2, RotateCw, TerminalSquare } from 'lucide-react'
import { useStudio } from '@/hooks/use-studio'
import { toast } from 'sonner'

type LineKind = 'cmd' | 'stdout' | 'stderr' | 'status' | 'error'
interface TermLine { kind: LineKind; text: string }

interface TermTab {
  id: string
  title: string
  lines: TermLine[]
  lastCommand: string | null
  running: boolean
  executionId: string | null
}

let tabSeq = 0
function newTab(): TermTab {
  tabSeq++
  return { id: `t${tabSeq}-${Date.now()}`, title: `bash ${tabSeq}`, lines: [], lastCommand: null, running: false, executionId: null }
}

export function TerminalPanel({ projectId }: { projectId: string }): React.ReactElement {
  const { token } = useStudio()
  const [tabs, setTabs] = useState<TermTab[]>([newTab()])
  const [activeId, setActiveId] = useState<string>('')
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!tabs.find((t) => t.id === activeId) && tabs.length > 0) setActiveId(tabs[0].id)
  }, [tabs, activeId])

  // histórico persistido localmente por projeto
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`term-history:${projectId}`)
      if (raw) setHistory(JSON.parse(raw))
    } catch { /* ignora */ }
  }, [projectId])

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]

  const patchTab = useCallback((id: string, patch: Partial<TermTab> | ((t: TermTab) => Partial<TermTab>)) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)))
  }, [])

  const appendLine = useCallback((id: string, line: TermLine) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t
        const lines = [...t.lines, line]
        // cap de memória: mantém as últimas 800 linhas
        return { ...t, lines: lines.length > 800 ? lines.slice(-800) : lines }
      })
    )
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [active?.lines.length])

  const persistHistory = (cmd: string) => {
    setHistory((prev) => {
      const next = [...prev.filter((h) => h !== cmd), cmd].slice(-50)
      try { localStorage.setItem(`term-history:${projectId}`, JSON.stringify(next)) } catch { /* ignora */ }
      return next
    })
    setHistIdx(-1)
  }

  /** Executa comando com STREAMING SSE em tempo real. */
  const runCommand = useCallback(async (cmd: string) => {
    if (!cmd.trim() || !active) return
    const tabId = active.id
    const command = cmd.trim()
    persistHistory(command)
    setInput('')
    appendLine(tabId, { kind: 'cmd', text: command })
    patchTab(tabId, { running: true, executionId: null, title: command.slice(0, 18) || tabId })

    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch('/api/executions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ project: projectId, command }),
        signal: ctrl.signal,
      })

      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        appendLine(tabId, { kind: 'error', text: d.error ?? `HTTP ${res.status}` })
        patchTab(tabId, { running: false })
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          if (!frame.startsWith('data: ')) continue
          let ev: Record<string, unknown>
          try { ev = JSON.parse(frame.slice(6)) } catch { continue }

          const type = ev.type as string
          if (type === 'start') {
            patchTab(tabId, { executionId: (ev.executionId as string) ?? null })
          } else if (type === 'stdout') {
            appendLine(tabId, { kind: 'stdout', text: String(ev.chunk ?? '') })
          } else if (type === 'stderr') {
            appendLine(tabId, { kind: 'stderr', text: String(ev.chunk ?? '') })
          } else if (type === 'exit') {
            const status = String(ev.status ?? '')
            const exitCode = ev.exitCode as number
            const dur = ev.durationMs as number
            const synced = ev.syncedFiles as number
            appendLine(tabId, {
              kind: status === 'SUCCESS' ? 'status' : 'error',
              text: `exit code: ${exitCode} · ${status} · ${(dur / 1000).toFixed(1)}s${synced ? ` · ${synced} arquivo(s) sincronizado(s)` : ''}${ev.message ? ` · ${ev.message}` : ''}`,
            })
            patchTab(tabId, { running: false, lastCommand: command })
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        appendLine(tabId, { kind: 'error', text: '^C execução encerrada pelo usuário' })
        patchTab(tabId, { running: false })
      } else {
        appendLine(tabId, { kind: 'error', text: `ERRO: ${(e as Error).message}` })
        patchTab(tabId, { running: false })
      }
    } finally {
      abortRef.current = null
    }
  }, [active, projectId, token, appendLine, patchTab])

  /** STOP: cancela execução no servidor + aborta stream. */
  const stop = useCallback(async () => {
    if (!active) return
    const execId = active.executionId
    if (execId && token) {
      try {
        await fetch(`/api/executions/${execId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        })
      } catch { /* best-effort */ }
    }
    abortRef.current?.abort()
  }, [active, token])

  const lineColor: Record<LineKind, string> = {
    cmd: 'text-emerald-400',
    stdout: 'text-zinc-300',
    stderr: 'text-red-400',
    status: 'text-zinc-500',
    error: 'text-red-400 font-medium',
  }

  if (!active) return <div className="h-full" />

  return (
    <div className="h-full flex flex-col bg-zinc-950/95 min-h-0">
      {/* header com tabs */}
      <div className="flex items-stretch border-b border-zinc-800/60 bg-zinc-900/50 shrink-0 overflow-x-auto scrollbar-none">
        <div className="flex items-center pl-2 pr-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-r border-zinc-800/60">
          <TerminalSquare className="w-3.5 h-3.5 mr-1" />
          Terminal
        </div>
        {tabs.map((t) => (
          <div
            key={t.id}
            onClick={() => setActiveId(t.id)}
            className={`group flex items-center gap-1.5 px-2.5 py-1 text-[11px] cursor-pointer border-r border-zinc-800/60 shrink-0 max-w-44 ${
              t.id === activeId ? 'bg-zinc-950 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.running && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />}
            <span className="truncate font-mono">{t.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setTabs((prev) => (prev.length > 1 ? prev.filter((x) => x.id !== t.id) : [newTab()]))
              }}
              className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-zinc-800"
              aria-label="fechar aba"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        <button onClick={() => setTabs((prev) => [...prev, newTab()])} title="nova aba" className="px-2 text-zinc-500 hover:text-emerald-400 shrink-0">
          <Plus className="w-3.5 h-3.5" />
        </button>
        {/* ações */}
        <div className="ml-auto flex items-center gap-0.5 pr-1.5 shrink-0">
          {active.running ? (
            <button onClick={stop} title="parar execução" className="p-1 rounded text-red-400 hover:bg-red-950/50">
              <Square className="w-3 h-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => active.lastCommand && runCommand(active.lastCommand)}
              title="reexecutar último comando"
              disabled={!active.lastCommand}
              className="p-1 rounded text-zinc-500 hover:text-emerald-400 enabled:hover:bg-zinc-800 disabled:opacity-30"
            >
              <RotateCw className="w-3 h-3" />
            </button>
          )}
          <button onClick={() => patchTab(active.id, { lines: [] })} title="limpar" className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* saída */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed min-h-0">
        {active.lines.length === 0 && (
          <p className="text-zinc-600 p-2">
            Terminal real conectado ao Execution Engine. Comandos permitidos: node · npm · npx · bun · git · ls · cat · mkdir · grep · find.
            <br />
            <span className="text-zinc-700">Dica: seta ↑ navega o histórico · botão vermelho encerra processos em execução.</span>
          </p>
        )}
        {active.lines.map((l, i) => (
          <pre key={i} className={`whitespace-pre-wrap break-words ${lineColor[l.kind]}`}>
            {l.kind === 'cmd' ? `$ ${l.text}` : l.text}
          </pre>
        ))}
        {active.running && <span className="inline-block w-1.5 h-3.5 bg-emerald-400 animate-pulse align-middle" />}
      </div>

      {/* entrada */}
      <div className="flex items-center gap-2 border-t border-zinc-800/60 px-2 py-1.5 shrink-0">
        <span className="text-emerald-500 font-mono text-xs shrink-0">$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !active.running) runCommand(input)
            else if (e.key === 'ArrowUp') {
              e.preventDefault()
              const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1)
              if (history[next] !== undefined) { setHistIdx(next); setInput(history[next]) }
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              if (histIdx >= 0 && histIdx < history.length - 1) { setHistIdx(histIdx + 1); setInput(history[histIdx + 1]) }
              else { setHistIdx(-1); setInput('') }
            }
          }}
          disabled={active.running}
          placeholder={active.running ? 'executando…' : 'comando (ex: npm test, node --test, git status, ls -la)'}
          className="flex-1 bg-transparent border-0 outline-none font-mono text-xs text-zinc-200 placeholder:text-zinc-600 disabled:opacity-50"
          autoFocus
        />
      </div>
    </div>
  )
}
