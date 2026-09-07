// ============================================================
// TOOLS / WEB — web_search (degradação graciosa — NUNCA bloqueia)
// ============================================================
// Pesquisa web para o Poskli. CONTRATO REVISADO (fix do travamento):
//   input : { query: string (OBRIGATÓRIO), max_results?: number }
//   output: array de { title, url, snippet } (default 5, cap 10)
//   timeout: 10 segundos (AbortSignal, orçamento PARTILHADO pelos
//            3 endpoints — html → lite → api instant answer)
//   rate limit: 1 requisição/segundo (global, módulo)
//
// REGRA DE OURO (anti-travamento): a pesquisa é BEST-EFFORT.
//   - Falha de rede / HTTP de erro / soft-block / timeout → a tool
//     devolve ok:true com lista VAZIA e aviso "pesquisa indisponível
//     — prosseguir sem pesquisar". O agente NUNCA fica bloqueado.
//   - A ÚNICA falha ok:false é QUERY_INVÁLIDA (erro de argumento
//     que o modelo corrige no próximo passo).
//   - O runner (base.ts) trata web_search como best-effort: falhas
//     não contam para o detector de loops nem derrubam o run.
//
// Implementação: fetch nativo, 3 endpoints do DuckDuckGo (o pacote
// npm `ddgs` baixa Chrome ~150MB, inviável no serverless). Parsers
// puros em web-search-core.ts (testáveis com node:test).
// ============================================================

import {
  parseDuckDuckGo, parseDuckInstantAnswer, rateLimitDecision, formatWebResults,
  type WebSearchResult,
} from './web-search-core.ts'
import type { ToolDefinition, ToolResult } from './types'

// NOTA: esta tool NÃO emite eventos diretamente — o runTool()
// (tools/index.ts) emite tool.called/tool.completed com auditoria.
// Isso mantém o módulo IMPORTÁVEL por testes puros (sem DB).

const SEARCH_TIMEOUT_MS = 10_000
const RATE_LIMIT_INTERVAL_MS = 1_000
const MIN_QUERY_CHARS = 2
const MAX_RESULTS_CAP = 10

/** Endpoints do DuckDuckGo (ordem de tentativa — 2026-09):
 *  1. html.duckduckgo.com/html/ — primário (mais resultados)
 *  2. lite.duckduckgo.com/lite/ — fallback (às vezes soft-block 202)
 *  3. api.duckduckgo.com — Instant Answer JSON (raramente bloqueado) */
interface EndpointDef {
  url: (q: string) => string
  parse: (body: string, max: number) => WebSearchResult[]
  /** endpoint JSON (Instant Answer) — header accept diferente. */
  json?: boolean
}

const SEARCH_ENDPOINTS: readonly EndpointDef[] = [
  {
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: (b, m) => parseDuckDuckGo(b, m),
  },
  {
    url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    parse: (b, m) => parseDuckDuckGo(b, m),
  },
  {
    url: (q) => `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`,
    parse: (b, m) => parseDuckInstantAnswer(safeJsonParse(b), m),
    json: true,
  },
]

/** JSON tolerante a corpo vazio/lixeira (nunca lança). */
function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/** Estado do rate limiter global (1 req/s entre chamadas da tool). */
let lastSearchAt: number | null = null

/** Reseta o rate limiter (usado por testes). */
export function resetWebSearchRateLimit(): void {
  lastSearchAt = null
}

/** Espera ativa quando o rate limit exige (máx. ~1s — nunca bloqueia mais). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Resultado interno da varredura de endpoints. */
export interface DuckSearchOutcome {
  results: WebSearchResult[]
  /** true quando TODOS os endpoints falharam/estavam bloqueados. */
  degraded: boolean
  /** motivo da degradação (para o aviso ao agente — nunca bloqueia). */
  reason?: string
}

/** Busca REAL no DuckDuckGo (html → lite → api). Separada da tool
 *  p/ testabilidade. Timeout de 10s PARTILHADO pelos 3 endpoints.
 *  NUNCA LANÇA: falha total → { results: [], degraded: true }. */
export async function duckDuckGoSearch(
  query: string,
  maxResults: number
): Promise<DuckSearchOutcome> {
  const deadline = Date.now() + SEARCH_TIMEOUT_MS
  let lastReason = 'sem resposta dos endpoints'
  for (const ep of SEARCH_ENDPOINTS) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      lastReason = 'tempo esgotado'
      break
    }
    try {
      const res = await fetch(ep.url(query), {
        headers: {
          'user-agent': USER_AGENT,
          accept: ep.json ? 'application/json' : 'text/html',
          'accept-language': 'en-US,en;q=0.9,pt;q=0.8',
        },
        signal: AbortSignal.timeout(Math.max(500, remaining)),
        redirect: 'follow',
      })
      if (!res.ok) {
        // 403/429/5xx… → tenta o PRÓXIMO endpoint (soft-block comum
        // em IPs de datacenter — ex.: egress da Vercel)
        lastReason = `HTTP ${res.status} em ${new URL(ep.url(query)).host}`
        continue
      }
      const body = await res.text()
      const results = ep.parse(body, maxResults)
      if (results.length > 0) return { results, degraded: false }
      // 0 resultados: soft-block 202/página vazia → próximo endpoint
      lastReason = `sem resultados em ${new URL(ep.url(query)).host}`
    } catch (e) {
      const err = e as Error
      lastReason =
        err.name === 'TimeoutError' || err.name === 'AbortError'
          ? `timeout de ${SEARCH_TIMEOUT_MS / 1000}s`
          : `rede: ${err.message.slice(0, 80)}`
    }
  }
  return { results: [], degraded: true, reason: lastReason }
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'OPCIONAL — pesquisa na web por informações atualizadas. Use SOMENTE quando o pedido depender de ' +
    'dados externos que você não conhece (versão recente de framework, API, referência explícita). ' +
    'Pedidos comuns de sites/apps/jogos NÃO precisam de pesquisa. Se devolver vazio, PROSSIGA sem pesquisar. ' +
    'Retorna até 10 resultados {título, url, resumo}.',
  category: 'web',
  permissions: ['web:search'],
  params: [
    { name: 'query', type: 'string', required: true, description: 'Termo de busca (obrigatório)' },
    { name: 'max_results', type: 'number', required: false, description: 'Máximo de resultados (default 5, máx 10)' },
  ],
  timeoutMs: SEARCH_TIMEOUT_MS + 3_000,
  async execute(args): Promise<ToolResult> {
    const query = String(args.query ?? '').trim()
    if (query.length < MIN_QUERY_CHARS) {
      return { ok: false, output: `QUERY_INVÁLIDA: forneça um termo de busca (mín ${MIN_QUERY_CHARS} caracteres).` }
    }
    // NaN-safe: Number(undefined) é NaN e ?? NÃO apanha NaN — validar
    const n = Number(args.max_results)
    const maxResults = Number.isFinite(n) && n > 0
      ? Math.min(Math.floor(n), MAX_RESULTS_CAP)
      : 5

    // ---- rate limit: 1 req/s (espera o intervalo, nunca excede) ----
    const decision = rateLimitDecision(lastSearchAt, Date.now(), RATE_LIMIT_INTERVAL_MS)
    if (!decision.allowed) await sleep(decision.waitMs + 20)
    lastSearchAt = Date.now()

    // ---- busca best-effort: falha NUNCA bloqueia o agente ----
    const outcome = await duckDuckGoSearch(query, maxResults)
    if (outcome.degraded) {
      // CONTRATO (fix do travamento): erro → lista VAZIA + aviso de
      // prosseguir. ok:true para o runner não tratar como falha.
      return {
        ok: true,
        output:
          'NENHUM resultado (pesquisa indisponível — ' +
          `${outcome.reason ?? 'indisponível'}). PROSSIGA com a tarefa SEM pesquisar: use o contexto e as boas práticas que já conhece.`,
        data: { query, count: 0, results: [], degraded: true, reason: outcome.reason },
      }
    }
    return {
      ok: true,
      output: formatWebResults(outcome.results),
      data: { query, count: outcome.results.length, results: outcome.results },
    }
  },
}

// Evento de atividade é emitido pelo runTool (tool.called/completed) —
// o utilizador vê "A pesquisar na web…" (poskli-activity.ts) e NUNCA
// detalhes técnicos da tool.
