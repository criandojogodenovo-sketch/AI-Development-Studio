'use client'

// ============================================================
// DIAGNOSTICS VIEW — área técnica separada (Fase L):
// validação de ambiente, uso de modelos, executions agregadas,
// status dos services. NADA disto aparece na UI de produto.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { useStudio } from '@/hooks/use-studio'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, Stethoscope, Activity, Server, Cpu, HardDrive, ShieldCheck } from 'lucide-react'
import { statusLabel, formatDuration } from './ui-helpers'

interface EnvCheck {
  nodeEnv: string
  database: string
  baiKeys: { key1: boolean; key2: boolean; provider: string }
  githubToken: string
  deepseekEnabled: boolean
  executionProvider: string
}

interface UsageRow {
  model: string
  requests: number
  totalTokens: number
  errors: number
}

export function DiagnosticsView(): React.ReactElement {
  const { api } = useStudio()
  const [env, setEnv] = useState<EnvCheck | null>(null)
  const [usage, setUsage] = useState<UsageRow[]>([])
  const [agents, setAgents] = useState<Array<{ id: string; name: string; enabled: boolean; future: boolean }>>([])
  const [tools, setTools] = useState<Array<{ name: string; category: string }>>([])
  const [execStats, setExecStats] = useState<Array<{ status: string; count: number; avgDurationMs: number | null }>>([])
  const [recentErrors, setRecentErrors] = useState<Array<{ type: string; message: string; at: string }>>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api<{
        validation: EnvCheck
        agents: Array<{ id: string; name: string; enabled: boolean; future: boolean }>
        tools: Array<{ name: string; category: string }>
        executions: Array<{ status: string; count: number; avgDurationMs: number | null }>
        recentErrors: Array<{ type: string; message: string; at: string }>
      }>('/api/diagnostics')
      setEnv(d.validation)
      setAgents(d.agents ?? [])
      setTools(d.tools ?? [])
      setExecStats(d.executions ?? [])
      setRecentErrors(d.recentErrors ?? [])
    } catch {
      /* silencioso */
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { load() }, [load])

  const Check = ({ ok, label, detail }: { ok: boolean; label: string; detail: string }) => (
    <div className="flex items-center gap-2 text-xs py-1">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ok ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
      <span className="text-zinc-300 w-36 shrink-0">{label}</span>
      <span className="text-zinc-500 font-mono text-[10px] truncate">{detail}</span>
    </div>
  )

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold flex items-center gap-2">
          <Stethoscope className="w-5 h-5 text-emerald-400" />
          Diagnóstico
        </h1>
        <span className="text-[10px] text-zinc-600">informação técnica — separada da UI de produto</span>
        <button onClick={load} className="ml-auto p-2 rounded-lg text-zinc-500 hover:text-emerald-400">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* ambiente */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-xs text-zinc-400 flex items-center gap-1.5"><Server className="w-3.5 h-3.5" /> Ambiente</CardTitle></CardHeader>
        <CardContent>
          {env ? (
            <>
              <Check ok label="Node env" detail={env.nodeEnv} />
              <Check ok={env.database.includes('ok')} label="Database" detail={env.database} />
              <Check ok={env.baiKeys.key1 || env.baiKeys.key2} label="Chaves de modelo" detail={`k1:${env.baiKeys.key1} k2:${env.baiKeys.key2} · provider: ${env.baiKeys.provider}`} />
              <Check ok={env.githubToken.includes('configurado')} label="GitHub token" detail={env.githubToken} />
              <Check ok label="Executor" detail={env.executionProvider} />
              <Check ok={!env.deepseekEnabled} label="Modelo reserva" detail={env.deepseekEnabled ? 'ativado' : 'desativado (padrão)'} />
            </>
          ) : (
            <p className="text-xs text-zinc-600">carregando…</p>
          )}
        </CardContent>
      </Card>

      {/* uso de modelos */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-xs text-zinc-400 flex items-center gap-1.5"><Cpu className="w-3.5 h-3.5" /> Execuções por estado</CardTitle></CardHeader>
        <CardContent>
          {execStats.length === 0 && <p className="text-xs text-zinc-600">sem execuções registradas</p>}
          <div className="space-y-1">
            {execStats.map((s) => (
              <div key={s.status} className="flex items-center gap-3 text-[11px] font-mono border-b border-zinc-800/40 pb-1">
                <span className="text-zinc-300 w-32 truncate">{statusLabel(s.status)}</span>
                <span className="text-zinc-500">{s.count} execução(ões)</span>
                {s.avgDurationMs && <span className="text-zinc-500">média {formatDuration(s.avgDurationMs)}</span>}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* erros recentes */}
      {recentErrors.length > 0 && (
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardHeader className="py-3"><CardTitle className="text-xs text-zinc-400 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> Eventos de erro recentes</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1">
              {recentErrors.map((e, i) => (
                <div key={i} className="text-[10.5px] text-zinc-500 border-b border-zinc-800/40 pb-1 break-words">
                  <span className="text-amber-500/70 font-mono">{e.type}</span> — {e.message}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* agentes */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-xs text-zinc-400 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> Agentes ({agents.length})</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {agents.map((a) => (
              <div key={a.id} className={`px-2 py-1.5 rounded-lg text-[11px] border ${a.enabled ? 'bg-zinc-900/60 border-zinc-800 text-zinc-300' : 'bg-zinc-950/40 border-zinc-900 text-zinc-600'}`}>
                <p className="truncate">{a.name}</p>
                <p className="text-[9px] text-zinc-600">{a.enabled ? 'ativo' : 'reservado'}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ferramentas */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-xs text-zinc-400 flex items-center gap-1.5"><HardDrive className="w-3.5 h-3.5" /> Ferramentas ({tools.length})</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1">
            {tools.map((t) => (
              <span key={t.name} className="px-1.5 py-0.5 rounded bg-zinc-900/60 border border-zinc-800 text-[10px] font-mono text-zinc-400">
                {t.name}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-xs text-zinc-400 flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> Segurança ativa</CardTitle></CardHeader>
        <CardContent className="text-[11px] text-zinc-500 space-y-1">
          <p>· Comandos: allowlist binária (spawn sem shell), sem metacaracteres, timeout + SIGKILL, cap de output 200KB</p>
          <p>· Arquivos: validação de traversal, extensões bloqueadas, limite por arquivo e por projeto</p>
          <p>· Execuções: fila por projeto, env mínimo do processo, masking de tokens na saída</p>
          <p>· Preview: isolado por sessão (cookie HttpOnly), sandbox de iframe, sem cache</p>
          <p>· Tokens GitHub/B.AI/DATABASE_URL: somente backend — nunca expostos em respostas de API</p>
        </CardContent>
      </Card>
    </div>
  )
}
