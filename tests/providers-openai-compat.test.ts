// ============================================================
// PROVIDERS OPENAI-COMPATIBLE — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/providers-openai-compat.test.ts
// HTTP 100% mockado (globalThis.fetch) — sem rede, sem créditos.
// Valida:
//   P1.  Configuração/ausência de chave (erro controlado)
//   P2.  Sucesso: parsing de content/tokens/finish_reason
//   P3.  Classificação: 429/500/401/403/404/rede/timeout
//   P4.  200-com-erro e resposta vazia → erros controlados
//   P5.  Modelos de raciocínio: content null + finish=length → ''
//        content null + reasoning_content → uso defensivo
//   P6.  SEGURANÇA: chave nunca aparece em mensagens de erro
//   P7.  Experiential: retry regional do master (403 → fallback)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAICompatProvider } from '../src/lib/studio/models/providers/openai-compat.ts'
import { ExperientialProvider, EXPLABS_MODEL_CATALOG } from '../src/lib/studio/models/providers/experiential.ts'
import type { ChatMessage } from '../src/lib/studio/models/types.ts'

const MSGS: ChatMessage[] = [{ role: 'user', content: 'ping' }]
const KEY = 'FAKE-PROVIDER-KEY-do-not-log-0123456789'
const realFetch = globalThis.fetch

type Handler = (url: string, init?: RequestInit) => Promise<Response>

function mockFetch(handler: Handler) {
  globalThis.fetch = ((url: string | URL, init?: RequestInit) =>
    handler(String(url), init)) as typeof fetch
}

function restoreFetch() {
  globalThis.fetch = realFetch
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function okBody(content: string, finish = 'stop') {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
  }
}

function makeProvider(timeoutMs = 5_000): OpenAICompatProvider {
  process.env.TESTPROV_KEY = KEY
  const p = new OpenAICompatProvider({
    name: 'testprov',
    apiKeyEnv: 'TESTPROV_KEY',
    defaultBaseUrl: 'https://unit.test/v1',
    requestTimeoutMs: timeoutMs,
  })
  delete process.env.TESTPROV_KEY
  return p
}

test.after(() => restoreFetch())

// ---------- P1: configuração ----------

test('P1.1 — isConfigured true com chave; false sem chave', () => {
  process.env.TESTPROV_KEY = KEY
  const withKey = new OpenAICompatProvider({
    name: 'testprov', apiKeyEnv: 'TESTPROV_KEY', defaultBaseUrl: 'https://unit.test/v1', requestTimeoutMs: 1000,
  })
  delete process.env.TESTPROV_KEY
  const noKey = new OpenAICompatProvider({
    name: 'testprov', apiKeyEnv: 'TESTPROV_KEY', defaultBaseUrl: 'https://unit.test/v1', requestTimeoutMs: 1000,
  })
  assert.equal(withKey.isConfigured(), true)
  assert.equal(noKey.isConfigured(), false)
})

test('P1.2 — sem chave: erro controlado AUTH/NO_KEY sem chamada HTTP', async () => {
  const noKey = new OpenAICompatProvider({
    name: 'testprov', apiKeyEnv: 'TESTPROV_KEY_MISSING', defaultBaseUrl: 'https://unit.test/v1', requestTimeoutMs: 1000,
  })
  let called = 0
  mockFetch(async () => { called++; return jsonRes(okBody('x')) })
  await assert.rejects(
    noKey.complete({ model: 'm', messages: MSGS }),
    (e: Error & { errorClass?: string; code?: string }) => e.errorClass === 'AUTH' && e.code === 'NO_KEY'
  )
  assert.equal(called, 0, 'fetch não pode ser chamado sem chave')
})

// ---------- P2: sucesso ----------

test('P2.1 — sucesso: content, tokens, finishReason e model corretos', async () => {
  const p = makeProvider()
  let seenUrl = ''
  let seenAuth = ''
  let seenBody = ''
  mockFetch(async (url, init) => {
    seenUrl = url
    seenAuth = (init?.headers as Record<string, string>)['authorization'] ?? ''
    seenBody = String(init?.body ?? '')
    return jsonRes(okBody('resposta-do-modelo'))
  })
  const r = await p.complete({ model: 'modelo-x', messages: MSGS, temperature: 0.2, maxTokens: 64 })
  assert.equal(seenUrl, 'https://unit.test/v1/chat/completions')
  assert.equal(seenAuth, `Bearer ${KEY}`)
  assert.ok(seenBody.includes('"model":"modelo-x"'))
  assert.ok(seenBody.includes('"max_tokens":64'))
  assert.equal(r.content, 'resposta-do-modelo')
  assert.equal(r.promptTokens, 7)
  assert.equal(r.completionTokens, 11)
  assert.equal(r.finishReason, 'stop')
  assert.equal(r.model, 'modelo-x')
  assert.equal(typeof r.durationMs, 'number')
})

// ---------- P3: classificação de erros HTTP ----------

for (const [status, cls] of [[429, 'RATE_LIMIT'], [500, 'SERVER_ERROR'], [503, 'SERVER_ERROR'], [401, 'AUTH'], [403, 'AUTH'], [404, 'CLIENT_ERROR'], [400, 'CLIENT_ERROR']] as const) {
  test(`P3 — HTTP ${status} → errorClass ${cls}`, async () => {
    const p = makeProvider()
    mockFetch(async () => jsonRes({ error: { message: `erro ${status}` } }, status))
    await assert.rejects(
      p.complete({ model: 'm', messages: MSGS }),
      (e: Error & { errorClass?: string; httpStatus?: number }) =>
        e.errorClass === cls && e.httpStatus === status
    )
  })
}

test('P3.8 — falha de rede (TypeError fetch failed) → NETWORK', async () => {
  const p = makeProvider()
  mockFetch(async () => { throw new TypeError('fetch failed') })
  await assert.rejects(
    p.complete({ model: 'm', messages: MSGS }),
    (e: Error & { errorClass?: string }) => e.errorClass === 'NETWORK'
  )
})

test('P3.9 — timeout (AbortController) → TIMEOUT com timedOut', async () => {
  const p = makeProvider(60)
  mockFetch((_url, init) => new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () =>
      rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    )
  }))
  await assert.rejects(
    p.complete({ model: 'm', messages: MSGS }),
    (e: Error & { errorClass?: string; timedOut?: boolean }) => e.errorClass === 'TIMEOUT' && e.timedOut === true
  )
})

// ---------- P4: 200-com-erro e resposta vazia ----------

test('P4.1 — HTTP 200 com corpo de erro → erro controlado (não silenciado)', async () => {
  const p = makeProvider()
  mockFetch(async () => jsonRes({ error: { message: 'quota interna excedida', type: 'provider_error' } }))
  await assert.rejects(
    p.complete({ model: 'm', messages: MSGS }),
    (e: Error) => /ERRO_PROVEDOR_200/.test(e.message)
  )
})

test('P4.2 — resposta vazia sem truncamento → RESPOSTA_VAZIA (UNKNOWN)', async () => {
  const p = makeProvider()
  mockFetch(async () => jsonRes({ choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'stop' }] }))
  await assert.rejects(
    p.complete({ model: 'm', messages: MSGS }),
    (e: Error & { errorClass?: string }) => /RESPOSTA_VAZIA/.test(e.message) && e.errorClass === 'UNKNOWN'
  )
})

// ---------- P5: modelos de raciocínio (NIM) ----------

test('P5.1 — content null + finish=length (truncamento) → content vazio, SEM erro', async () => {
  const p = makeProvider()
  mockFetch(async () => jsonRes({
    choices: [{ message: { role: 'assistant', content: null, reasoning_content: 'raciocinio parcial' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 5, completion_tokens: 24 },
  }))
  const r = await p.complete({ model: 'm', messages: MSGS })
  assert.equal(r.content, '')
  assert.equal(r.finishReason, 'length')
})

test('P5.2 — content null + reasoning_content sem truncamento → uso defensivo do reasoning', async () => {
  const p = makeProvider()
  mockFetch(async () => jsonRes({
    choices: [{ message: { role: 'assistant', content: null, reasoning_content: 'saída-em-reasoning' }, finish_reason: 'stop' }],
  }))
  const r = await p.complete({ model: 'm', messages: MSGS })
  assert.equal(r.content, 'saída-em-reasoning')
})

// ---------- P6: segurança ----------

test('P6.1 — a chave NUNCA aparece em mensagens de erro', async () => {
  const p = makeProvider()
  mockFetch(async () => jsonRes({ error: { message: 'erro interno do provedor' } }, 500))
  try {
    await p.complete({ model: 'm', messages: MSGS })
    assert.fail('deveria ter falhado')
  } catch (e) {
    const msg = (e as Error).message
    assert.ok(!msg.includes(KEY), 'mensagem de erro não pode conter a chave')
    assert.ok(!String((e as { cause?: unknown }).cause ?? '').includes(KEY))
  }
})

// ---------- P7: Experiential — retry regional do master ----------

test('P7.1 — master gpt-6-astra com 403 (bloqueio regional) → retry com fallback e sucesso', async () => {
  process.env.EXPLABS_API_KEY = KEY
  const prov = new ExperientialProvider()
  delete process.env.EXPLABS_API_KEY
  const calls: string[] = []
  mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string }
    calls.push(body.model)
    if (calls.length === 1) {
      return jsonRes({ error: { message: 'model unavailable from location', code: 'model_location_not_supported' } }, 403)
    }
    return jsonRes(okBody('resposta-do-fallback'))
  })
  const r = await prov.complete({ model: EXPLABS_MODEL_CATALOG.master, messages: MSGS })
  assert.deepEqual(calls, [EXPLABS_MODEL_CATALOG.master, EXPLABS_MODEL_CATALOG.masterFallback])
  assert.equal(r.content, 'resposta-do-fallback')
  assert.equal(r.model, EXPLABS_MODEL_CATALOG.masterFallback)
})

test('P7.2 — modelo NÃO-master com 403: sem retry interno (chain decide)', async () => {
  process.env.EXPLABS_API_KEY = KEY
  const prov = new ExperientialProvider()
  delete process.env.EXPLABS_API_KEY
  let calls = 0
  mockFetch(async () => {
    calls++
    return jsonRes({ error: { message: 'unavailable from location' } }, 403)
  })
  await assert.rejects(
    prov.complete({ model: EXPLABS_MODEL_CATALOG.coding, messages: MSGS }),
    (e: Error & { errorClass?: string }) => e.errorClass === 'AUTH'
  )
  assert.equal(calls, 1, 'coding não tem retry regional')
})

test('P7.3 — master 403 e fallback TAMBÉM falha → erro propagado (2 chamadas)', async () => {
  process.env.EXPLABS_API_KEY = KEY
  const prov = new ExperientialProvider()
  delete process.env.EXPLABS_API_KEY
  let calls = 0
  mockFetch(async () => {
    calls++
    return jsonRes({ error: { message: 'unavailable from location' } }, 403)
  })
  await assert.rejects(
    prov.complete({ model: EXPLABS_MODEL_CATALOG.master, messages: MSGS }),
    (e: Error & { errorClass?: string }) => e.errorClass === 'AUTH'
  )
  assert.equal(calls, 2)
})

test('P7.4 — master com falha de REDE: sem retry de modelo (não é bloqueio regional)', async () => {
  process.env.EXPLABS_API_KEY = KEY
  const prov = new ExperientialProvider()
  delete process.env.EXPLABS_API_KEY
  let calls = 0
  mockFetch(async () => {
    calls++
    throw new TypeError('fetch failed')
  })
  await assert.rejects(
    prov.complete({ model: EXPLABS_MODEL_CATALOG.master, messages: MSGS }),
    (e: Error & { errorClass?: string }) => e.errorClass === 'NETWORK'
  )
  assert.equal(calls, 1, 'falha de rede não dispara retry de modelo')
})

// ---------- P8: modelFallback EXPLÍCITO (versões expposkli-1.0/1.1) ----------
// Caminho (A): o ModelRouter injeta req.modelFallback — retry interno
// Experiential→Experiential para classes elegíveis; 429 NUNCA.

test('P8.1 — modelFallback explícito + 403 (bloqueio regional): retry com o modelo alternativo e sucesso', async () => {
  process.env.EXPLABS_API_KEY = KEY
  const prov = new ExperientialProvider()
  delete process.env.EXPLABS_API_KEY
  const calls: string[] = []
  mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string }
    calls.push(body.model)
    if (calls.length === 1) {
      return jsonRes({ error: { message: 'model unavailable from location' } }, 403)
    }
    return jsonRes(okBody('resposta-do-alternativo'))
  })
  const r = await prov.complete({ model: 'gpt-6-astra', messages: MSGS, modelFallback: 'aion-2.0' })
  assert.deepEqual(calls, ['gpt-6-astra', 'aion-2.0'])
  assert.equal(r.content, 'resposta-do-alternativo')
  assert.equal(r.model, 'aion-2.0')
})

test('P8.2 — modelFallback explícito + 500 (elegível): retry (diferente do legado, que não re-tenta)', async () => {
  process.env.EXPLABS_API_KEY = KEY
  const prov = new ExperientialProvider()
  delete process.env.EXPLABS_API_KEY
  const calls: string[] = []
  mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model: string }
    calls.push(body.model)
    if (calls.length === 1) return jsonRes({ error: { message: 'internal' } }, 500)
    return jsonRes(okBody('ok-apos-500'))
  })
  const r = await prov.complete({ model: 'claude-fable-5.1', messages: MSGS, modelFallback: 'aion-2.0' })
  assert.deepEqual(calls, ['claude-fable-5.1', 'aion-2.0'])
  assert.equal(r.content, 'ok-apos-500')
})

test('P8.3 — modelFallback explícito + 429: NUNCA retry (política inviolável)', async () => {
  process.env.EXPLABS_API_KEY = KEY
  const prov = new ExperientialProvider()
  delete process.env.EXPLABS_API_KEY
  let calls = 0
  mockFetch(async () => {
    calls++
    return jsonRes({ error: { message: 'rate limit exceeded' } }, 429)
  })
  await assert.rejects(
    prov.complete({ model: 'aion-2.0', messages: MSGS, modelFallback: 'claude-fable-5.1' }),
    (e: Error & { errorClass?: string }) => e.errorClass === 'RATE_LIMIT'
  )
  assert.equal(calls, 1, '429 nunca dispara retry de modelo (nem explícito)')
})

test('P8.4 — modelFallback explícito e o fallback TAMBÉM falha: erro propagado (2 chamadas, honesto)', async () => {
  process.env.EXPLABS_API_KEY = KEY
  const prov = new ExperientialProvider()
  delete process.env.EXPLABS_API_KEY
  let calls = 0
  mockFetch(async () => {
    calls++
    return jsonRes({ error: { message: 'unavailable' } }, 503)
  })
  await assert.rejects(
    prov.complete({ model: 'gpt-6-astra', messages: MSGS, modelFallback: 'aion-2.0' }),
    (e: Error & { errorClass?: string }) => e.errorClass === 'SERVER_ERROR'
  )
  assert.equal(calls, 2)
})

test('P8.5 — sem modelFallback explícito, 500 no master: SEM retry (legado preservado)', async () => {
  process.env.EXPLABS_API_KEY = KEY
  const prov = new ExperientialProvider()
  delete process.env.EXPLABS_API_KEY
  let calls = 0
  mockFetch(async () => {
    calls++
    return jsonRes({ error: { message: 'internal' } }, 500)
  })
  await assert.rejects(
    prov.complete({ model: EXPLABS_MODEL_CATALOG.master, messages: MSGS }),
    (e: Error & { errorClass?: string }) => e.errorClass === 'SERVER_ERROR'
  )
  assert.equal(calls, 1, 'legado: 500 não é bloqueio regional — sem retry')
})
