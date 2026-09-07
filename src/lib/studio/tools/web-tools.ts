// ============================================================
// TOOLS / WEB — web_search (FASE 4 da auditoria)
// ============================================================
// Pesquisa web REAL para o Poskli: o agente pode buscar
// informações atualizadas, referências de design, documentação
// e contexto externo — ANTES de criar projetos (inspiração) e
// durante a implementação (docs/APIs).
//
// Contrato (pedido do usuário):
//   input : { query: string (OBRIGATÓRIO), max_results?: number }
//   output: array de { title, url, snippet } (default 5)
//   timeout: 5 segundos (AbortSignal)
//   rate limit: 1 requisição/segundo (global, módulo)
//
// Implementação: fetch nativo → DuckDuckGo Lite (sem Puppeteer —
// o pacote npm `ddgs` baixa Chrome ~150MB, inviável no serverless).
// Parser puro em web-search-core.ts (testável com node:test).
// ============================================================

import {
  parseDuckDuckGoLite, rateLimitDecision, formatWebResults,
  type WebSearchResult,
} from './web-search-core.ts'
import type { ToolDefinition, ToolResult } from './types'

// NOTA: esta tool NÃO emite eventos diretamente — o runTool()
// (tools/index.ts) emite tool.called/tool.completed com auditoria.
// Isso mantém o módulo IMPORTÁVEL por testes puros (sem DB).

const SEARCH_TIMEOUT_MS = 5_000
const RATE_LIMIT_INTERVAL_MS = 1_000
const MIN_QUERY_CHARS = 2
const MAX_RESULTS_CAP = 10

/** Endpoints do DuckDuckGo (validados ao vivo 2026-09):
 *  1. html.duckduckgo.com/html/ — primário (mais resultados)
 *  2. lite.duckduckgo.com/lite/ — fallback (às vezes soft-block 202) */
const SEARCH_ENDPOINTS = [
  (q: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  (q: string) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
] as const

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

/** Busca REAL no DuckDuckGo (html → fallback lite). Separada da tool
 *  p/ testabilidade. Timeout de 5s PARTILHADO pelos 2 endpoints. */
export async function duckDuckGoSearch(
  query: string,
  maxResults: number
): Promise<WebSearchResult[]> {
  const deadline = Date.now() + SEARCH_TIMEOUT_MS
  let lastError: Error | null = null
  for (const buildUrl of SEARCH_ENDPOINTS) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      const res = await fetch(buildUrl(query), {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html',
          'accept-language': 'en-US,en;q=0.9,pt;q=0.8',
        },
        signal: AbortSignal.timeout(Math.max(500, remaining)),
        redirect: 'follow',
      })
      if (!res.ok) {
        lastError = Object.assign(new Error(`HTTP ${res.status}`), { code: 'SEARCH_HTTP_ERROR' })
        continue
      }
      const html = await res.text()
      const results = parseDuckDuckGoLite(html, maxResults)
      if (results.length > 0) return results
      // 0 resultados: pode ser página vazia/soft-block → tenta o próximo
      // endpoint ANTES de desistir (mantém o mesmo orçamento de 5s)
      lastError = null
    } catch (e) {
      lastError = e as Error
    }
  }
  if (lastError) throw lastError
  return []
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'Pesquisa na web por informações atualizadas, referências de design, documentação e boas práticas. ' +
    'Use ANTES de planejar projetos visuais (inspiração/design refs) e para APIs/docs recentes. ' +
    'Retorna até 10 resultados {título, url, resumo}.',
  category: 'web',
  permissions: ['web:search'],
  params: [
    { name: 'query', type: 'string', required: true, description: 'Termo de busca (obrigatório)' },
    { name: 'max_results', type: 'number', required: false, description: 'Máximo de resultados (default 5, máx 10)' },
  ],
  timeoutMs: SEARCH_TIMEOUT_MS + 2_000,
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

    try {
      const results = await duckDuckGoSearch(query, maxResults)
      return {
        ok: true,
        output: formatWebResults(results),
        data: { query, count: results.length, results },
      }
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError'
        ? `BUSCA_TIMEOUT: a pesquisa excedeu ${SEARCH_TIMEOUT_MS / 1000}s — tente uma query mais específica.`
        : `BUSCA_FALHOU: ${(e as Error).message}`
      return { ok: false, output: msg, data: { query } }
    }
  },
}

// Evento de atividade é emitido pelo runTool (tool.called/completed) —
// o utilizador vê "A pesquisar na web…" (poskli-activity.ts) e NUNCA
// detalhes técnicos da tool.
