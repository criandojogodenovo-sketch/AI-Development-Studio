'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useStudio } from '@/hooks/use-studio'
import { statusColor, formatTokens } from './ui-helpers'
import { Brain, Cpu, ShieldAlert, BarChart3 } from 'lucide-react'

interface ModelInfo {
  id: string; label: string; role: string; description: string
  enabledByDefault: boolean; available: boolean; reason?: string
}
interface UsageRow {
  day: string; model: string; requests: number; promptTokens: number
  completionTokens: number; totalTokens: number; errors: number
}

const MODEL_ICONS: Record<string, string> = {
  master: '🧠', coding: '⚡', review: '🔬', deepseek: '🚀',
}

export function ModelsView() {
  const { api } = useStudio()
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    api<any>('/api/models').then(setData).catch(() => {})
  }, [api])

  if (!data) return <p className="text-sm text-zinc-600">carregando modelos…</p>

  const totals = data.totalsToday ?? { requests: 0, totalTokens: 0, errors: 0 }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Modelos & Uso</h2>

      <div className="grid grid-cols-3 gap-3">
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="p-4">
            <p className="text-xs text-zinc-500">Requisições hoje</p>
            <p className="text-2xl font-bold">{totals.requests}</p>
          </CardContent>
        </Card>
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="p-4">
            <p className="text-xs text-zinc-500">Tokens hoje</p>
            <p className="text-2xl font-bold">{formatTokens(totals.totalTokens)}</p>
          </CardContent>
        </Card>
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="p-4">
            <p className="text-xs text-zinc-500">Erros hoje</p>
            <p className="text-2xl font-bold">{totals.errors}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {(data.models ?? []).map((m: ModelInfo) => (
          <Card key={m.id} className={`border-zinc-800 bg-zinc-900/60 ${!m.available ? 'opacity-70' : ''}`}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{MODEL_ICONS[m.role] ?? '🤖'}</span>
                  <div>
                    <p className="font-semibold text-sm">{m.label}</p>
                    <p className="text-[10px] text-zinc-600 font-mono">{m.id}</p>
                  </div>
                </div>
                <Badge variant="outline" className={m.available ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'}>
                  {m.available ? 'ATIVO' : 'OFF'}
                </Badge>
              </div>
              <p className="text-xs text-zinc-500">{m.description}</p>
              {!m.available && m.reason && (
                <p className="text-[11px] text-amber-500/80 flex items-start gap-1">
                  <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" /> {m.reason}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* DeepSeek status explícito */}
      <Card className="border-amber-900/40 bg-amber-950/10">
        <CardContent className="p-4 flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-300">
              DeepSeek-V4-Flash: {data.deepseek?.enabled ? 'HABILITADO' : 'DESATIVADO'} (padrão)
            </p>
            <p className="text-xs text-zinc-500">{data.deepseek?.note}</p>
            <p className="text-xs text-zinc-600">Limite diário quando ativo: {data.deepseek?.maxDailyRequests} requisições.</p>
          </div>
        </CardContent>
      </Card>

      {/* Limites do sistema */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-2"><CardTitle className="text-sm text-zinc-400 flex items-center gap-2"><Brain className="w-4 h-4" /> Limites anti-loop-infinito</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          {Object.entries(data.limits ?? {}).map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-zinc-800/50 pb-1">
              <span className="text-zinc-600">{k}</span>
              <span className="font-mono text-zinc-300">{String(v)}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Histórico de uso */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-2"><CardTitle className="text-sm text-zinc-400 flex items-center gap-2"><BarChart3 className="w-4 h-4" /> Histórico (14 dias)</CardTitle></CardHeader>
        <CardContent className="space-y-1 max-h-72 overflow-y-auto">
          {(data.history ?? []).length === 0 && <p className="text-xs text-zinc-600">Sem uso registrado ainda.</p>}
          {(data.history ?? []).map((u: UsageRow, i: number) => (
            <div key={i} className="flex items-center gap-2 text-[11px] border-b border-zinc-800/50 pb-1">
              <span className="text-zinc-600 w-20">{u.day}</span>
              <span className="text-zinc-400 flex-1 truncate">{u.model}</span>
              <span className="text-zinc-500">{u.requests} req</span>
              <span className="text-emerald-500/80">{formatTokens(u.totalTokens)} tok</span>
              {u.errors > 0 && <span className="text-red-400">{u.errors} err</span>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
