'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useStudio } from '@/hooks/use-studio'
import { formatTokens, modelRoleLabel } from './ui-helpers'
import { readStoredPoskliVersion, poskliVersionOption } from '@/lib/poskli-version'
import { Brain, ShieldAlert, BarChart3, ChevronRight, Cpu } from 'lucide-react'

interface ModelInfo {
  id: string; label: string; role: string; description: string
  enabledByDefault: boolean; available: boolean; reason?: string
}
interface UsageRow {
  day: string; model: string; requests: number; promptTokens: number
  completionTokens: number; totalTokens: number; errors: number
}

const ROLE_ICONS: Record<string, string> = {
  master: '🧠', coding: '⚡', review: '🔬', deepseek: '🚀',
}

// Linguagem de produto — papéis dos agentes, sem nomes técnicos de modelos
const ROLE_LABELS: Record<string, string> = {
  master: 'Planejador',
  coding: 'Engenheiro de Implementação',
  review: 'Revisor de Qualidade',
  deepseek: 'Reserva técnica',
}
const ROLE_PRODUCT_DESC: Record<string, string> = {
  master: 'Analisa seu pedido, define a arquitetura e planeja o grafo de tarefas.',
  coding: 'Implementa o código dos projetos com as ferramentas do estúdio.',
  review: 'Verifica qualidade, roda testes e pede correções quando necessário.',
  deepseek: 'Alternativa para casos difíceis — desativada por padrão para controlar custos.',
}

/** Sanitiza mensagens internas (nomes de env vars) para linguagem de produto. */
function productReason(reason?: string): string | undefined {
  if (!reason) return undefined
  if (/ENABLE_DEEPSEEK/i.test(reason)) return 'Desativado por padrão no produto'
  if (/provider indisponível/i.test(reason)) return 'Indisponível no momento'
  return reason.replace(/ENABLE_\w+/g, 'configuração do produto')
}

const LIMIT_LABELS: Record<string, string> = {
  maxAgentSteps: 'Máx. passos por agente',
  maxTaskAttempts: 'Máx. tentativas por tarefa',
  maxReviewCycles: 'Máx. ciclos de revisão',
  maxToolCalls: 'Máx. chamadas de ferramenta',
  maxTotalExecutionMs: 'Tempo máx. de execução',
  repeatedFailureThreshold: 'Limiar de falha repetida',
}

function formatLimitValue(k: string, v: string | number): string {
  if (k === 'maxTotalExecutionMs') {
    const ms = Number(v)
    return ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)}s`
  }
  return String(v)
}

export function ModelsView() {
  const { api } = useStudio()
  const [data, setData] = useState<any>(null)

  // reflete o SELETOR DE MODELOS (localStorage) — o snapshot do chain
  // (disponibilidade/providers) é calculado para a versão selecionada
  useEffect(() => {
    const v = readStoredPoskliVersion()
    const q = v ? `?version=${encodeURIComponent(v)}` : ''
    api<any>(`/api/models${q}`).then(setData).catch(() => {})
  }, [api])

  if (!data) return <p className="text-sm text-zinc-500">carregando…</p>

  const totals = data.totalsToday ?? { requests: 0, totalTokens: 0, errors: 0 }
  const chainVersion: string | undefined = data.chain?.version
  const chainProviders: string[] = data.chain?.providers ?? []
  const routes: Record<string, string[]> = data.routes ?? {}
  const highlight = poskliVersionOption(chainVersion ?? '')?.highlight ?? false

  const routeLabel = (r?: string[]) =>
    r && r.length ? r.map((s) => s.split(':')[1]).join(' → ') : ''

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-lg font-bold">Motor de IA & Uso</h2>
        {chainVersion && (
          <Badge
            variant="outline"
            title={`Cadeia de providers: ${chainProviders.join(' → ')}`}
            className={`text-[10px] ${
              highlight
                ? 'bg-violet-500/15 text-violet-300 border-violet-500/30'
                : 'bg-sky-500/10 text-sky-300 border-sky-500/30'
            }`}
          >
            <Cpu className="w-3 h-3 mr-1" /> Poskli v{chainVersion}
          </Badge>
        )}
      </div>
      {chainProviders.length > 0 && (
        <p className="text-[11px] text-zinc-500 -mt-3">
          Cadeia ativa nesta versão: <span className="font-mono text-zinc-400">{chainProviders.join(' → ')}</span>
          {highlight && ' — superagent (dupla de coding Hy3+Qwen)'}
        </p>
      )}
      {routes.master && (
        <p className="text-[11px] text-zinc-500 -mt-2">
          Rotas: master <span className="font-mono text-zinc-400">{routeLabel(routes.master)}</span> · coding{' '}
          <span className="font-mono text-zinc-400">{routeLabel(routes.coding)}</span> · review{' '}
          <span className="font-mono text-zinc-400">{routeLabel(routes.review)}</span>
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="p-4">
            <p className="text-xs text-zinc-400">Requisições hoje</p>
            <p className="text-2xl font-bold">{totals.requests}</p>
          </CardContent>
        </Card>
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="p-4">
            <p className="text-xs text-zinc-400">Tokens hoje</p>
            <p className="text-2xl font-bold">{formatTokens(totals.totalTokens)}</p>
          </CardContent>
        </Card>
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="p-4">
            <p className="text-xs text-zinc-400">Erros hoje</p>
            <p className="text-2xl font-bold">{totals.errors}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {(data.models ?? []).map((m: ModelInfo) => (
          <Card key={m.role} className={`border-zinc-800 bg-zinc-900/60 ${!m.available ? 'opacity-70' : ''}`}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-lg shrink-0">{ROLE_ICONS[m.role] ?? '🤖'}</span>
                  <p className="font-semibold text-sm truncate">{ROLE_LABELS[m.role] ?? 'Motor de IA'}</p>
                </div>
                <Badge variant="outline" className={m.available ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'}>
                  {m.available ? 'ATIVO' : 'DESATIVADO'}
                </Badge>
              </div>
              <p className="text-xs text-zinc-400">{ROLE_PRODUCT_DESC[m.role] ?? m.description}</p>
              {!m.available && productReason(m.reason) && (
                <p className="text-[11px] text-amber-500/80 flex items-start gap-1">
                  <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" /> {productReason(m.reason)}
                </p>
              )}
              {/* Detalhes técnicos (modo desenvolvedor) */}
              <details className="group">
                <summary className="text-[11px] text-zinc-500 flex items-center gap-1 cursor-pointer list-none select-none hover:text-zinc-400">
                  <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
                  detalhes técnicos
                </summary>
                <p className="text-[10px] text-zinc-600 font-mono mt-1 break-all">{m.id}</p>
                <p className="text-[10px] text-zinc-600 mt-0.5">{m.description}</p>
              </details>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Modelo reserva */}
      <Card className="border-amber-900/40 bg-amber-950/10">
        <CardContent className="p-4 flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-300">
              Reserva técnica: {data.deepseek?.enabled ? 'habilitada' : 'desativada'} (padrão do produto)
            </p>
            <p className="text-xs text-zinc-400">
              Uma reserva técnica é usada apenas em casos difíceis e permanece desativada por padrão para controlar custos.
            </p>
            <p className="text-xs text-zinc-500">Limite diário quando ativa: {data.deepseek?.maxDailyRequests} requisições.</p>
          </div>
        </CardContent>
      </Card>

      {/* Limites do sistema */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-2"><CardTitle className="text-sm text-zinc-400 flex items-center gap-2"><Brain className="w-4 h-4" /> Proteções contra loops infinitos</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          {Object.entries(data.limits ?? {}).map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-zinc-800/50 pb-1">
              <span className="text-zinc-500">{LIMIT_LABELS[k] ?? k}</span>
              <span className="font-mono text-zinc-300">{formatLimitValue(k, v as string | number)}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Histórico de uso */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-2"><CardTitle className="text-sm text-zinc-400 flex items-center gap-2"><BarChart3 className="w-4 h-4" /> Histórico de uso (14 dias)</CardTitle></CardHeader>
        <CardContent className="space-y-1 max-h-72 overflow-y-auto">
          {(data.history ?? []).length === 0 && <p className="text-xs text-zinc-500">Sem uso registrado ainda.</p>}
          {(data.history ?? []).map((u: UsageRow, i: number) => (
            <div key={i} className="flex items-center gap-2 text-[11px] border-b border-zinc-800/50 pb-1">
              <span className="text-zinc-500 w-20">{u.day}</span>
              <span className="text-zinc-400 flex-1 truncate">{modelRoleLabel(u.model)}</span>
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
