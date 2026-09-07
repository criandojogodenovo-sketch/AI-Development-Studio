// ============================================================
// WEB SEARCH CORE (NÚCLEO PURO) — parser + rate limiter
// ============================================================
// Ferramenta web_search do Poskli (FASE 4 — auditoria):
//   input : { query: string (obrigatório), max_results?: number (default 5) }
//   output: Array<{ title, url, snippet }>
//
// Implementação SEM dependências (o pacote npm `ddgs` arrasta
// Puppeteer/Chrome ~150MB — inviável em Vercel serverless): fetch
// nativo ao DuckDuckGo + parser por regex.
//
// Dois endpoints suportados (validados ao vivo em 2026-09):
//   1. html.duckduckgo.com/html/  (primário — mais resultados)
//   2. lite.duckduckgo.com/lite/  (fallback — às vezes soft-block 202)
// Estruturas com atributos EM ORDEM VARIÁVEL:
//   <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=<enc>">T</a>
//   <a class="result__snippet" href="...">S</a>
//   <a class='result-link' href="//duckduckgo.com/l/?uddg=<enc>">T</a>
//   <td class='result-snippet'>S</td>
//
// Este módulo é 100% PURO (zero imports de runtime) → testável
// com node:test (mocks do HTML/decisões do rate limiter).
// ============================================================

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

/** Decodifica a URL real do redirect do DDG (`uddg=<url-encoded>`). */
export function decodeDuckRedirect(href: string): string | null {
  const m = href.match(/[?&]uddg=([^&]+)/)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}

/** É um resultado de ANÚNCIO (patrocinado)? Nunca deve ir ao agente. */
export function isAdResult(url: string): boolean {
  return (
    /duckduckgo\.com\/y\.js/i.test(url) ||
    /[?&](ad_domain|ad_provider|ad_domain)=/i.test(url) ||
    /bing\.com\/(aclick|aclk)/i.test(url) ||
    /ad_domain=/i.test(url)
  )
}

/** Normaliza entidades HTML básicas (o DDG usa &amp; etc.). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => {
      try { return String.fromCodePoint(Number(d)) } catch { return _ as string }
    })
}

function clean(s: string): string {
  return decodeEntities(s)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Extrai um atributo de uma tag HTML (aspas simples/duplas, ordem qualquer). */
function attrOf(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return m ? m[1] : null
}

/** Matchea âncoras/tds com a classe dada (ordem de atributos livre).
 *  Âncoras e tds usam regex SEPARADAS: a âncora do formato lite vive
 *  DENTRO de um <td> — uma regex única `(a|td)` engoliria a âncora
 *  como conteúdo do td (bug real encontrado na validação E2E). */
function elementsWithClass(html: string, className: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = []
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g
  const tdRe = /<td\b([^>]*)>([\s\S]*?)<\/td>/g
  for (const re of [anchorRe, tdRe]) {
    for (const m of html.matchAll(re)) {
      const attrs = m[1] ?? ''
      const cls = attrOf(attrs, 'class') ?? ''
      if (cls.split(/\s+/).includes(className)) {
        out.push({ attrs, inner: m[2] ?? '' })
      }
    }
  }
  return out
}

/**
 * Parser do HTML do DuckDuckGo (endpoint html OU lite).
 * Puro e determinístico — testável com HTML capturado.
 * - títulos: .result__a (html) ou .result-link (lite)
 * - snippets: .result__snippet (html) ou .result-snippet (lite)
 * - URLs decodificadas do redirect uddg=, anúncios REMOVIDOS,
 *   duplicados removidos, teto maxResults respeitado.
 */
export function parseDuckDuckGo(html: string, maxResults = 5): WebSearchResult[] {
  const out: WebSearchResult[] = []
  const seen = new Set<string>()

  const titles = [
    ...elementsWithClass(html, 'result__a'),
    ...elementsWithClass(html, 'result-link'),
  ]
  const snippets = [
    ...elementsWithClass(html, 'result__snippet'),
    ...elementsWithClass(html, 'result-snippet'),
  ]

  let snippetIdx = 0
  for (const t of titles) {
    const href = attrOf(t.attrs, 'href') ?? ''
    const url = decodeDuckRedirect(href)
    const title = clean(t.inner)
    if (!url || !title) continue
    if (isAdResult(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    const snippet = clean(snippets[snippetIdx]?.inner ?? '')
    if (snippets[snippetIdx]) snippetIdx++
    out.push({ title, url, snippet })
    if (out.length >= Math.max(1, maxResults)) break
  }
  return out
}

/** Alias de compatibilidade (endpoint lite). */
export const parseDuckDuckGoLite = parseDuckDuckGo

// ---------- RATE LIMIT (1 requisição por segundo — global) ----------

export interface RateLimitDecision {
  allowed: boolean
  /** ms que faltam para poder executar (0 quando allowed). */
  waitMs: number
}

/** Decisão pura do rate limiter: mínimo 1 req/s (intervalo configurável). */
export function rateLimitDecision(
  lastCallAt: number | null,
  now: number,
  minIntervalMs = 1_000
): RateLimitDecision {
  if (lastCallAt === null) return { allowed: true, waitMs: 0 }
  const elapsed = now - lastCallAt
  if (elapsed >= minIntervalMs) return { allowed: true, waitMs: 0 }
  return { allowed: false, waitMs: minIntervalMs - elapsed }
}

/** Formata os resultados para o contexto do LLM (compacto e truncável). */
export function formatWebResults(results: WebSearchResult[]): string {
  if (results.length === 0) return 'NENHUM resultado encontrado.'
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n')
}
