'use client'

// ============================================================
// PREVIEW PANEL — preview REAL conectado ao workspace
// viewports (mobile/tablet/desktop) · refresh · abrir externo ·
// console em tempo real (bridge postMessage) · status honesto ·
// ações de erro ([Abrir arquivo] [Abrir terminal] [Poskli])
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { Monitor, Smartphone, Tablet, RotateCw, ExternalLink, Eye, CircleAlert, CircleCheck, Loader2 } from 'lucide-react'
import { useStudio } from '@/hooks/use-studio'
import { useIde } from './use-ide'

type Viewport = 'mobile' | 'tablet' | 'desktop'
type PreviewStatus = 'LOADING' | 'READY' | 'ERROR'

interface ConsoleEntry {
  level: string
  text: string
  ts: number
}

const VIEWPORTS: Record<Viewport, { w: number; h: number; icon: typeof Smartphone; label: string }> = {
  mobile: { w: 390, h: 667, icon: Smartphone, label: 'Mobile' },
  tablet: { w: 768, h: 900, icon: Tablet, label: 'Tablet' },
  desktop: { w: 0, h: 0, icon: Monitor, label: 'Desktop' },
}

export function PreviewPanel({
  projectId,
  onRequestTerminal,
  onAskPoskli,
}: {
  projectId: string
  onRequestTerminal: () => void
  onAskPoskli: (message: string) => void
}): React.ReactElement {
  const { token } = useStudio()
  const openFile = useIde((s) => s.openFile)
  const [viewport, setViewport] = useState<Viewport>('mobile')
  const [status, setStatus] = useState<PreviewStatus>('LOADING')
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const [showConsole, setShowConsole] = useState(true)
  const [nonce, setNonce] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const previewUrl = `/api/preview/${projectId}/?v=${nonce}`

  // escuta o bridge do preview (console + erros + ações)
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as Record<string, unknown> | null
      if (!d || typeof d !== 'object') return

      if (d.__studioPreview) {
        const kind = String(d.kind)
        const level = String(d.level ?? 'info')
        const args = (d.args as string[]) ?? []
        if (kind === 'ready') {
          setStatus('READY')
          return
        }
        const text = args.join(' ')
        setConsoleEntries((prev) => [...prev.slice(-199), { level, text, ts: Date.now() }])
        if (kind === 'error' || level === 'error') setStatus('ERROR')
        return
      }

      if (d.__studioAction) {
        const action = String(d.action)
        if (action === 'open-file' && typeof d.path === 'string') {
          const line = Number(d.line) || 1
          openFile(d.path, line).catch(() => {})
        } else if (action === 'open-terminal') {
          onRequestTerminal()
        } else if (action === 'ask-poskli' && typeof d.message === 'string') {
          onAskPoskli(String(d.message))
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [openFile, onRequestTerminal, onAskPoskli])

  const refresh = useCallback(() => {
    setStatus('LOADING')
    setConsoleEntries([])
    setNonce((n) => n + 1)
  }, [])

  const openExternal = () => {
    // aba externa usa o cookie de sessão (HttpOnly — mesmo browser)
    window.open(`/api/preview/${projectId}/`, '_blank')
  }

  const vp = VIEWPORTS[viewport]
  const statusIcon =
    status === 'READY' ? <CircleCheck className="w-3 h-3 text-emerald-400" /> :
    status === 'ERROR' ? <CircleAlert className="w-3 h-3 text-red-400" /> :
    <Loader2 className="w-3 h-3 text-zinc-400 animate-spin" />
  const statusLabel = status === 'READY' ? 'READY' : status === 'ERROR' ? 'ERROR' : 'CARREGANDO'

  return (
    <div className="h-full flex flex-col bg-zinc-950/80 min-h-0">
      {/* toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-zinc-800/60 bg-zinc-900/40 shrink-0">
        <Eye className="w-3.5 h-3.5 text-zinc-500 mr-1" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Preview</span>
        <span className={`flex items-center gap-1 ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded border ${
          status === 'READY' ? 'border-emerald-900/60 text-emerald-400 bg-emerald-950/30'
          : status === 'ERROR' ? 'border-red-900/60 text-red-400 bg-red-950/30'
          : 'border-zinc-800 text-zinc-400 bg-zinc-900/50'
        }`}>
          {statusIcon}
          {statusLabel}
        </span>
        <div className="flex-1" />
        {/* viewports */}
        <div className="flex items-center gap-0.5 bg-zinc-900/60 rounded p-0.5">
          {(Object.keys(VIEWPORTS) as Viewport[]).map((v) => {
            const Icon = VIEWPORTS[v].icon
            return (
              <button
                key={v}
                onClick={() => setViewport(v)}
                title={VIEWPORTS[v].label}
                className={`p-1 rounded ${viewport === v ? 'bg-zinc-700/70 text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                <Icon className="w-3 h-3" />
              </button>
            )
          })}
        </div>
        <button onClick={refresh} title="recarregar" className="p-1 rounded text-zinc-500 hover:text-emerald-400 hover:bg-zinc-800">
          <RotateCw className="w-3.5 h-3.5" />
        </button>
        <button onClick={openExternal} title="abrir em nova aba" className="p-1 rounded text-zinc-500 hover:text-emerald-400 hover:bg-zinc-800">
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* área do iframe */}
      <div className="flex-1 min-h-0 overflow-auto flex items-start justify-center bg-[repeating-conic-gradient(#18181b_0%_25%,#141418_0%_50%)] bg-[length:16px_16px] p-2">
        {viewport === 'desktop' ? (
          <iframe
            key={nonce}
            ref={iframeRef}
            src={previewUrl}
            title="preview desktop"
            className="w-full h-full border border-zinc-800 rounded bg-white"
            sandbox="allow-scripts allow-pointer-lock allow-forms allow-modals"
            onLoad={() => setStatus((s) => (s === 'LOADING' ? 'READY' : s))}
          />
        ) : (
          <div
            className="border border-zinc-700 rounded-lg overflow-hidden bg-white shadow-xl"
            style={{ width: vp.w, height: vp.h, maxWidth: '100%' }}
          >
            <iframe
              key={nonce}
              ref={iframeRef}
              src={previewUrl}
              title={`preview ${viewport}`}
              className="w-full h-full"
              sandbox="allow-scripts allow-pointer-lock allow-forms allow-modals"
              onLoad={() => setStatus((s) => (s === 'LOADING' ? 'READY' : s))}
            />
          </div>
        )}
      </div>

      {/* console */}
      {showConsole && (
        <div className="h-32 border-t border-zinc-800/60 bg-zinc-950 shrink-0 flex flex-col">
          <div className="flex items-center gap-1 px-2 py-0.5 border-b border-zinc-900">
            <span className="text-[9px] uppercase tracking-wider text-zinc-600 font-semibold">Console</span>
            <span className="text-[9px] text-zinc-600">{consoleEntries.length}</span>
            <button onClick={() => setConsoleEntries([])} className="ml-auto text-[9px] text-zinc-600 hover:text-zinc-300 px-1">
              limpar
            </button>
            <button onClick={() => setShowConsole(false)} className="text-[9px] text-zinc-600 hover:text-zinc-300 px-1">
              ocultar
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-1 font-mono text-[10px] leading-snug">
            {consoleEntries.length === 0 && <p className="text-zinc-700 p-1">console.log/erros do preview aparecem aqui</p>}
            {consoleEntries.map((c, i) => (
              <pre
                key={i}
                className={`whitespace-pre-wrap break-words px-1 ${
                  c.level === 'error' ? 'text-red-400' : c.level === 'warn' ? 'text-amber-400' : 'text-zinc-400'
                }`}
              >
                {c.text}
              </pre>
            ))}
          </div>
        </div>
      )}
      {!showConsole && (
        <button onClick={() => setShowConsole(true)} className="border-t border-zinc-800/60 py-0.5 text-[9px] text-zinc-600 hover:text-zinc-300">
          mostrar console ({consoleEntries.length})
        </button>
      )}
    </div>
  )
}
