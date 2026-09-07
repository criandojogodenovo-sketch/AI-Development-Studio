// ============================================================
// WEB SEARCH — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-web-search.test.ts
// FASE 4/5 da auditoria — tool web_search:
//   W1. parser do DuckDuckGo Lite extrai {title, url, snippet},
//       decodifica o redirect uddg=, deduplica e respeita max
//   W2. rate limiter: 1 req/s — 1ª permitida, imediata seguinte
//       bloqueada, após intervalo permitida de novo
//   W3. formatWebResults: lista numerada compacta
//   W4. TOOL (mock do fetch): query obrigatória, timeout 5s,
//       resultados no formato do contrato
//   W5. TOOL: HTTP de erro → BUSCA_FALHOU honesto (sem crash)
//   W6. TOOL: rate limit aplicado entre duas chamadas (espera)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDuckDuckGoLite,
  rateLimitDecision,
  formatWebResults,
  decodeDuckRedirect,
  decodeEntities,
  isAdResult,
} from '../src/lib/studio/tools/web-search-core.ts'
import { webSearchTool, resetWebSearchRateLimit } from '../src/lib/studio/tools/web-tools.ts'
import type { ToolCtx } from '../src/lib/studio/tools/types'

// ---------- fixtures: HTML real (estrutura capturada do DDG) ----------
// Endpoint html.duckduckgo.com (primário): atributos em ordem VARIÁVEL
const fakeHtml = `
<div class="results">
<h2 class="result__title">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcats&amp;rut=abc">Cats &amp; Design Guide</a>
</h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcats&amp;rut=abc">Everything about <b>cats</b> and modern design.</a>
<h2 class="result__title">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.org%2Fintro&amp;rut=def">Intro to Docs</a>
</h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.org%2Fintro&amp;rut=def">The official introduction.</a>
<!-- ANÚNCIO (patrocinado) — deve ser FILTRADO -->
<h2 class="result__title">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dhk.com&amp;rut=ad">Buy Cat Stuff Now</a>
</h2>
<!-- duplicado → dedup -->
<h2 class="result__title">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcats&amp;rut=dup">Duplicate URL</a>
</h2>
</div>`

// Endpoint lite.duckduckgo.com (fallback): classes result-link/result-snippet
const fakeLiteHtml = `
<table>
<tr><td>1.</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example.dev%2Fpage&rut=x" class='result-link'>Lite Result</a></td></tr>
<tr><td class='result-snippet'>From the lite endpoint.</td></tr>
</table>`

// Página de soft-block (status 202, SEM resultados)
const fakeBlockedHtml = '<html><head><title>q at DuckDuckGo</title></head><body><form action="/lite/"><input></form><a href="/lite/">nav</a></body></html>'

test('W1 — parser extrai {title,url,snippet}, decodifica uddg, deduplica e limita', () => {
  const results = parseDuckDuckGoLite(fakeHtml, 5)
  assert.equal(results.length, 2, 'anúncio filtrado + duplicado removido → 2 resultados')
  assert.deepEqual(results[0], {
    title: 'Cats & Design Guide',
    url: 'https://example.com/cats',
    snippet: 'Everything about cats and modern design.',
  })
  assert.equal(results[1].url, 'https://docs.example.org/intro')
  // o anúncio NUNCA aparece
  assert.ok(!results.some((r) => /y\.js|ad_domain/i.test(r.url)), 'sem anúncios')
  // parser do endpoint LITE também funciona (classes result-link)
  const lite = parseDuckDuckGoLite(fakeLiteHtml, 5)
  assert.equal(lite.length, 1)
  assert.equal(lite[0].url, 'https://lite.example.dev/page')
  assert.equal(lite[0].snippet, 'From the lite endpoint.')
  // limite respeitado
  assert.equal(parseDuckDuckGoLite(fakeHtml, 1).length, 1)
  // HTML sem resultados → vazio
  assert.equal(parseDuckDuckGoLite('<html><body>nope</body></html>', 5).length, 0)
  assert.equal(parseDuckDuckGoLite(fakeBlockedHtml, 5).length, 0, 'página de soft-block → 0')
})

test('W1c — isAdResult filtra patrocinados', () => {
  assert.ok(isAdResult('https://duckduckgo.com/y.js?ad_domain=hk.com&ad_provider=bingv7a'))
  assert.ok(isAdResult('https://www.bing.com/aclick?ld=abc'))
  assert.ok(!isAdResult('https://example.com/cats'))
  assert.ok(!isAdResult('https://docs.example.org/intro'))
})

test('W1b — decodeDuckRedirect e decodeEntities', () => {
  assert.equal(decodeDuckRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.dev%2Fa&rut=1'), 'https://x.dev/a')
  assert.equal(decodeDuckRedirect('https://sem-redirect.dev'), null)
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#x27;d&#39; &nbsp;'), "a & b <c> 'd'  ")
})

test('W2 — rate limit 1 req/s: bloqueia imediata, libera após intervalo', () => {
  const now = 10_000
  // 1ª chamada (nunca chamou) → permitida
  assert.deepEqual(rateLimitDecision(null, now, 1_000), { allowed: true, waitMs: 0 })
  // 200ms depois → bloqueada, faltam 800ms
  assert.deepEqual(rateLimitDecision(now, now + 200, 1_000), { allowed: false, waitMs: 800 })
  // 1000ms depois → permitida
  assert.deepEqual(rateLimitDecision(now, now + 1_000, 1_000), { allowed: true, waitMs: 0 })
})

test('W3 — formatWebResults compacto e vazio honesto', () => {
  const out = formatWebResults([
    { title: 'T1', url: 'https://a.dev', snippet: 'S1' },
    { title: 'T2', url: 'https://b.dev', snippet: '' },
  ])
  assert.match(out, /1\. T1/)
  assert.match(out, /https:\/\/a\.dev/)
  assert.match(out, /S1/)
  assert.equal(formatWebResults([]), 'NENHUM resultado encontrado.')
})

// ---------- TOOL com fetch MOCKADO (sem rede) ----------

const ctx: ToolCtx = {
  projectId: 'test-project',
  workspaceRoot: '/tmp/test-ws',
  runId: 'test-run',
  agentId: 'master',
  permissions: ['web:search'],
}

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>

/** Substitui o global fetch pelo mock durante fn (restaura depois). */
async function withFetchMock(mock: FetchMock, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = mock as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('W4 — tool: query obrigatória validada antes de fetch', async () => {
  const res = await webSearchTool.execute({ query: '' }, ctx)
  assert.equal(res.ok, false)
  assert.match(res.output, /QUERY_INVÁLIDA/)
  const res2 = await webSearchTool.execute({}, ctx)
  assert.equal(res2.ok, false)
})

test('W4b — tool: fetch mockado devolve contrato {title,url,snippet}[]', async () => {
  resetWebSearchRateLimit()
  let called = false
  await withFetchMock(async (url) => {
    called = true
    assert.match(String(url), /html\.duckduckgo\.com\/html\/\?q=/, 'endpoint primário html')
    assert.ok(String(url).includes(encodeURIComponent('landing page design')), 'query URL-encoded')
    return new Response(fakeHtml, { status: 200, headers: { 'content-type': 'text/html' } })
  }, async () => {
    const res = await webSearchTool.execute({ query: 'landing page design' }, ctx)
    assert.equal(res.ok, true)
    assert.ok(called, 'fetch foi chamado')
    const results = (res.data?.results as Array<{ title: string; url: string; snippet: string }>) ?? []
    assert.equal(results.length, 2)
    assert.equal(results[0].url, 'https://example.com/cats')
    assert.match(res.output, /Cats & Design Guide/)
  })
})

test('W5 — tool: HTTP 503 nos DOIS endpoints → BUSCA_FALHOU honesto (sem crash)', async () => {
  resetWebSearchRateLimit()
  await withFetchMock(async () => new Response('busy', { status: 503 }), async () => {
    const res = await webSearchTool.execute({ query: 'anything' }, ctx)
    assert.equal(res.ok, false)
    assert.match(res.output, /BUSCA_FALHOU/)
  })
})

test('W5c — tool: endpoint primário vazio (soft-block 202) → FALLBACK lite devolve resultados', async () => {
  resetWebSearchRateLimit()
  const urls: string[] = []
  await withFetchMock(async (url) => {
    urls.push(String(url))
    // 1ª chamada: endpoint html com página bloqueada (sem resultados)
    if (String(url).includes('html.duckduckgo.com')) {
      return new Response(fakeBlockedHtml, { status: 202, headers: { 'content-type': 'text/html' } })
    }
    // 2ª chamada: fallback lite com resultados reais
    return new Response(fakeLiteHtml, { status: 200, headers: { 'content-type': 'text/html' } })
  }, async () => {
    const res = await webSearchTool.execute({ query: 'cat design' }, ctx)
    assert.equal(res.ok, true, 'fallback recuperou a busca')
    assert.equal(urls.length, 2, '2 endpoints consultados')
    assert.match(urls[0], /html\.duckduckgo\.com/)
    assert.match(urls[1], /lite\.duckduckgo\.com/)
    const results = (res.data?.results as Array<{ url: string }>) ?? []
    assert.equal(results[0]?.url, 'https://lite.example.dev/page')
  })
})

test('W5b — tool: timeout (abort) → BUSCA_TIMEOUT com dica', async () => {
  resetWebSearchRateLimit()
  await withFetchMock(async (_url, init) => {
    // simula o AbortSignal.timeout(5s) disparando imediatamente
    const signal = init?.signal
    if (signal) {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    }
    return new Response(fakeHtml, { status: 200 })
  }, async () => {
    const res = await webSearchTool.execute({ query: 'slow query' }, ctx)
    assert.equal(res.ok, false)
    assert.match(res.output, /BUSCA_TIMEOUT/)
  })
})

test('W6 — tool: rate limit global entre chamadas consecutivas (espera ≤ ~1s)', async () => {
  resetWebSearchRateLimit()
  const calls: number[] = []
  await withFetchMock(async () => {
    calls.push(Date.now())
    return new Response(fakeHtml, { status: 200 })
  }, async () => {
    const t0 = Date.now()
    await webSearchTool.execute({ query: 'first' }, ctx)
    await webSearchTool.execute({ query: 'second' }, ctx)
    const spread = calls.length === 2 ? calls[1] - calls[0] : 0
    // a 2ª chamada ESPERA o intervalo de 1 req/s (tolerância de execução)
    assert.ok(spread >= 900, `segunda chamada esperou o rate limit (spread=${spread}ms, total=${Date.now() - t0}ms)`)
    assert.equal(calls.length, 2)
  })
})

test('W7 — tool: max_results default 5 e cap 10', async () => {
  resetWebSearchRateLimit()
  // HTML com 12 resultados distintos (endpoint html, ads incluídos p/ filtrar)
  let many = ''
  for (let i = 0; i < 14; i++) {
    const ad = i === 5 ? '%3Fad_domain%3Dx' : ''
    many += `<h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx${i}.dev${ad}&rut=r${i}">R${i}</a></h2><a class="result__snippet" href="#">S${i}</a>`
  }
  const html = `<div class="results">${many}</div>`
  await withFetchMock(async () => new Response(html, { status: 200 }), async () => {
    const res = await webSearchTool.execute({ query: 'many results' }, ctx)
    assert.equal(res.ok, true)
    assert.equal((res.data?.count as number), 5, 'default 5 (ad filtrado não conta)')
    const res2 = await webSearchTool.execute({ query: 'many results 2', max_results: 99 }, ctx)
    assert.equal((res2.data?.count as number), 10, 'cap em 10')
  })
})
