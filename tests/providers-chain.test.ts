// ============================================================
// PROVIDER CHAIN — TESTES UNITÁRIOS (node:test + type stripping)
// Executar: node --test tests/providers-chain.test.ts
// Valida as REGRAS do roteamento por versão do Poskli + a política
// ANTI-RATE-LIMIT (Tarefa C):
//   C1.  Chains/rotas por versão (0.1/0.2/0.3.1/1.0-flash/superagent)
//   C2.  Providers não configurados ficam FORA do chain
//   C3.  Sem BAI → SDK sandbox (zai) substitui
//   C4.  normalizeVersion: 5 versões válidas; inválidas → default
//   C5.  ANTI-RATE-LIMIT:
//          - default: 429 3x (backoff) → QUOTA_EXHAUSTED, sem failover
//          - switch-now: 429 → troca IMEDIATA (mesma conta B.AI)
//          - retry-then-switch: 429 → 1 retry → troca
//          - QUOTA_EXHAUSTED: code + errorClass RATE_LIMIT + terminal
//   C6.  Falhas elegíveis (rede/5xx/timeout/401) avançam
//   C7.  CLIENT_ERROR/UNKNOWN não avançam (conservador)
//   C8.  Chain vazio → erro controlado; exaurido → tentativas
//   C9.  EXPERIENTIAL ELIMINADA: nenhuma versão/rota referencia
//        'explabs'; ProviderNames válidos ∈ {bai, zai, nvidia}
//   C10. Modelo físico correto por provider + rotas por papel
//   C11. superagent: Hy3 e Qwen disponíveis para coding (dupla)
//   C12. TRUNCAGEM: clipToolOutput corta >2k com marcador
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveChain,
  normalizeVersion,
  executeWithChain,
  errorClassOf,
  eligibleForChainFailover,
  isRateLimitError,
  POSKLI_VERSIONS,
  DEFAULT_POSKLI_VERSION,
  VERSION_ROUTES,
  RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_MAX_ATTEMPTS,
  type ChainContext,
  type ChainEntry,
} from '../src/lib/studio/models/chain.ts'
import { clipToolOutput, TOOL_OUTPUT_MARKER } from '../src/lib/studio/context/clip.ts'
import type { BAIErrorClass } from '../src/lib/studio/models/error-classes.ts'
import type { CompletionResult, LLMProvider, ProviderName } from '../src/lib/studio/models/types.ts'

// ---------- FÁBRICAS ----------

const ALL: ChainContext = { baiConfigured: true, nvidiaConfigured: true }

function ctx(over: Partial<ChainContext>): ChainContext {
  return { ...ALL, ...over }
}

function fakeResult(model: string): CompletionResult {
  return { content: `ok:${model}`, promptTokens: 1, completionTokens: 1, model, durationMs: 1, finishReason: 'stop' }
}

/** Provider fake que registra chamadas e falha/sucede conforme o script. */
function makeProvider(
  name: string,
  script: Array<'ok' | Error>
): LLMProvider & { calls: string[] } {
  const calls: string[] = []
  let i = 0
  return {
    name,
    calls,
    isAvailable: async () => true,
    complete: async (req: { model: string }) => {
      calls.push(req.model)
      const step = script[Math.min(i++, script.length - 1)]
      if (step === 'ok') return fakeResult(req.model)
      throw step
    },
  }
}

function err(cls: BAIErrorClass, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`erro-teste-${cls}`), { errorClass: cls, ...extra })
}

function entries(...list: Array<{ provider: ProviderName; llm: LLMProvider; model: string; onRateLimit?: 'retry-backoff' | 'switch-now' | 'retry-then-switch' }>): ChainEntry[] {
  return list
}

/** Opções de rate-limit p/ testes: sleep instantâneo + backoff zero. */
const RL_FAST = { sleep: async () => {}, backoffMs: [0, 0, 0] } as const

// ---------- C1: chains por versão ----------

test('C1.1 — versão 0.1 com tudo configurado: apenas BAI', () => {
  assert.deepEqual(resolveChain('0.1', ALL), ['bai'])
})

test('C1.2 — versão 0.2: BAI → NVIDIA', () => {
  assert.deepEqual(resolveChain('0.2', ALL), ['bai', 'nvidia'])
})

test('C1.3 — versão 0.3.1: BAI → NVIDIA (review via GPT-OSS)', () => {
  assert.deepEqual(resolveChain('0.3.1', ALL), ['bai', 'nvidia'])
})

test('C1.4 — versão 1.0-flash: NVIDIA → BAI (reserva)', () => {
  assert.deepEqual(resolveChain('1.0-flash', ALL), ['nvidia', 'bai'])
})

test('C1.5 — versão superagent: BAI → NVIDIA', () => {
  assert.deepEqual(resolveChain('superagent', ALL), ['bai', 'nvidia'])
})

test('C1.6 — rotas por papel da 0.1: master Qwen · coding Hy3 · review Qwen (só BAI)', () => {
  const r = VERSION_ROUTES['0.1']
  assert.deepEqual(r.master.map((s) => [s.provider, s.model]), [['bai', 'qwen']])
  assert.deepEqual(r.coding.map((s) => [s.provider, s.model]), [['bai', 'hy3']])
  assert.deepEqual(r.review.map((s) => [s.provider, s.model]), [['bai', 'qwen']])
})

test('C1.7 — rotas 0.3.1: coding Qwen→GLM (switch-now) e review GPT-OSS(NVIDIA)→Luna', () => {
  const r = VERSION_ROUTES['0.3.1']
  assert.deepEqual(r.master.map((s) => [s.provider, s.model]), [['bai', 'hy3']])
  assert.deepEqual(r.coding.map((s) => [s.provider, s.model, s.onRateLimit]), [
    ['bai', 'qwen', 'switch-now'],
    ['bai', 'glm', undefined],
  ])
  assert.deepEqual(r.review.map((s) => [s.provider, s.model, s.onRateLimit]), [
    ['nvidia', 'gpt-oss', 'retry-then-switch'],
    ['bai', 'luna', undefined],
  ])
})

test('C1.8 — rotas 1.0-flash: NVIDIA prioritário em TODOS os papéis (retry-then-switch) com BAI reserva', () => {
  const r = VERSION_ROUTES['1.0-flash']
  assert.deepEqual(r.master.map((s) => [s.provider, s.model, s.onRateLimit]), [
    ['nvidia', 'nemotron', 'retry-then-switch'],
    ['bai', 'glm', undefined],
  ])
  assert.deepEqual(r.coding.map((s) => [s.provider, s.model, s.onRateLimit]), [
    ['nvidia', 'deepseek', 'retry-then-switch'],
    ['bai', 'qwen', undefined],
  ])
  assert.deepEqual(r.review.map((s) => [s.provider, s.model, s.onRateLimit]), [
    ['nvidia', 'gpt-oss', 'retry-then-switch'],
    ['bai', 'luna', undefined],
  ])
})

// ---------- C2: providers ausentes ficam fora ----------

test('C2.1 — 0.2 sem chave NVIDIA: apenas BAI', () => {
  assert.deepEqual(resolveChain('0.2', ctx({ nvidiaConfigured: false })), ['bai'])
})

test('C2.2 — 1.0-flash sem NVIDIA: apenas BAI (reserva assume)', () => {
  assert.deepEqual(resolveChain('1.0-flash', ctx({ nvidiaConfigured: false })), ['bai'])
})

test('C2.3 — superagent sem NVIDIA: apenas BAI', () => {
  assert.deepEqual(resolveChain('superagent', ctx({ nvidiaConfigured: false })), ['bai'])
})

// ---------- C3: sandbox zai substitui BAI ----------

test('C3.1 — sem chaves BAI (sandbox): zai entra no lugar do BAI', () => {
  assert.deepEqual(resolveChain('0.2', ctx({ baiConfigured: false })), ['zai', 'nvidia'])
})

test('C3.2 — 0.1 sem BAI: apenas zai (comportamento histórico preservado)', () => {
  assert.deepEqual(resolveChain('0.1', ctx({ baiConfigured: false })), ['zai'])
})

test('C3.3 — 1.0-flash sem BAI: NVIDIA → zai', () => {
  assert.deepEqual(resolveChain('1.0-flash', ctx({ baiConfigured: false })), ['nvidia', 'zai'])
})

// ---------- C4: normalizeVersion ----------

test('C4.1 — normalizeVersion: inválido/ausente → default 0.2', () => {
  assert.equal(normalizeVersion('9.9'), DEFAULT_POSKLI_VERSION)
  assert.equal(normalizeVersion(undefined), DEFAULT_POSKLI_VERSION)
  assert.equal(normalizeVersion(''), DEFAULT_POSKLI_VERSION)
  assert.equal(normalizeVersion('1.0-flash'), '1.0-flash')
  assert.equal(normalizeVersion(' 0.3.1 '), '0.3.1')
  assert.equal(normalizeVersion('superagent'), 'superagent')
})

test('C4.2 — POSKLI_VERSIONS tem EXATAMENTE as 5 versões (expposkli removidas)', () => {
  assert.deepEqual(POSKLI_VERSIONS, ['0.1', '0.2', '0.3.1', '1.0-flash', 'superagent'])
  assert.equal(normalizeVersion('expposkli-1.0'), DEFAULT_POSKLI_VERSION, 'expposkli-1.0 não é mais válido')
  assert.equal(normalizeVersion('expposkli-1.1'), DEFAULT_POSKLI_VERSION, 'expposkli-1.1 não é mais válido')
})

// ---------- C5: ANTI-RATE-LIMIT (Tarefa C) ----------

test('C5.1 — 429 no default: 3 tentativas com backoff → QUOTA_EXHAUSTED (run para honestamente)', async () => {
  const sleeps: number[] = []
  const p1 = makeProvider('bai', [err('RATE_LIMIT')])
  const p2 = makeProvider('nvidia', ['ok'])
  await assert.rejects(
    executeWithChain(
      entries({ provider: 'bai', llm: p1, model: 'qwen' }, { provider: 'nvidia', llm: p2, model: 'nemo' }),
      { messages: [] },
      { ...RL_FAST, sleep: async (ms) => { sleeps.push(ms) } }
    ),
    (e: Error & { code?: string; errorClass?: string; quotaExhausted?: boolean }) => {
      assert.equal(e.code, 'QUOTA_EXHAUSTED')
      assert.equal(e.errorClass, 'RATE_LIMIT')
      assert.equal(e.quotaExhausted, true)
      assert.match(e.message, /QUOTA_EXHAUSTED/)
      return true
    }
  )
  assert.equal(p1.calls.length, 3, 'exatamente 3 tentativas no mesmo modelo (anti-loop)')
  assert.equal(p2.calls.length, 0, 'run para — segundo provider NÃO é chamado')
  assert.deepEqual(sleeps, [0, 0], 'backoff entre as 3 tentativas (2 esperas)')
})

test('C5.2 — anti-loop: 429 3x consecutivos SEM fallback → exatamente 3 chamadas + QUOTA_EXHAUSTED', async () => {
  const p1 = makeProvider('bai', [err('RATE_LIMIT'), err('RATE_LIMIT'), err('RATE_LIMIT')])
  await assert.rejects(
    executeWithChain(entries({ provider: 'bai', llm: p1, model: 'glm' }), { messages: [] }, RL_FAST),
    (e: Error & { code?: string }) => e.code === 'QUOTA_EXHAUSTED'
  )
  assert.equal(p1.calls.length, 3, 'máximo 3 tentativas — nunca loop infinito')
})

test('C5.3 — switch-now (0.3.1 Qwen): 429 → GLM chamado IMEDIATAMENTE como fallback', async () => {
  const qwen = makeProvider('bai', [err('RATE_LIMIT')])
  const glm = makeProvider('bai', ['ok'])
  const r = await executeWithChain(
    entries(
      { provider: 'bai', llm: qwen, model: 'qwen3.8-flash', onRateLimit: 'switch-now' },
      { provider: 'bai', llm: glm, model: 'glm-5.3-flash' }
    ),
    { messages: [] },
    RL_FAST
  )
  assert.equal(r.provider, 'bai')
  assert.equal(r.result.content, 'ok:glm-5.3-flash')
  assert.equal(qwen.calls.length, 1, 'Qwen tentado UMA vez (troca imediata — mesma conta)')
  assert.deepEqual(glm.calls, ['glm-5.3-flash'])
})

test('C5.4 — retry-then-switch (1.0-flash NVIDIA): 429 → 1 retry (backoff 5s) → BAI reserva', async () => {
  const waits: number[] = []
  const nvidia = makeProvider('nvidia', [err('RATE_LIMIT'), err('RATE_LIMIT')])
  const bai = makeProvider('bai', ['ok'])
  const r = await executeWithChain(
    entries(
      { provider: 'nvidia', llm: nvidia, model: 'nemotron', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', llm: bai, model: 'glm-5.3-flash' }
    ),
    { messages: [] },
    { sleep: async (ms) => { waits.push(ms) }, backoffMs: [5000, 10000, 20000] }
  )
  assert.equal(r.provider, 'bai')
  assert.equal(nvidia.calls.length, 2, 'NVIDIA: 1 tentativa + 1 retry (não 3)')
  assert.deepEqual(waits, [5000], 'espera o backoff 5s ANTES do retry único')
  assert.deepEqual(bai.calls, ['glm-5.3-flash'])
})

test('C5.5 — retry-then-switch com sucesso no retry: NÃO troca de provider', async () => {
  const nvidia = makeProvider('nvidia', [err('RATE_LIMIT'), 'ok'])
  const bai = makeProvider('bai', ['ok'])
  const r = await executeWithChain(
    entries(
      { provider: 'nvidia', llm: nvidia, model: 'nemotron', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', llm: bai, model: 'glm-5.3-flash' }
    ),
    { messages: [] },
    RL_FAST
  )
  assert.equal(r.provider, 'nvidia', 'retry resolveu — NVIDIA prioritário mantido')
  assert.equal(nvidia.calls.length, 2)
  assert.equal(bai.calls.length, 0)
})

test('C5.6 — BAIKeyError RATE_LIMITED (código): reconhecido como rate limit → política anti-loop aplica', async () => {
  const rl = Object.assign(new Error('BAI_RATE_LIMIT'), { code: 'RATE_LIMITED' })
  const p1 = makeProvider('bai', [rl, rl, rl])
  await assert.rejects(
    executeWithChain(entries({ provider: 'bai', llm: p1, model: 'm' }), { messages: [] }, RL_FAST),
    (e: Error & { code?: string }) => e.code === 'QUOTA_EXHAUSTED'
  )
  assert.equal(p1.calls.length, 3)
  assert.equal(isRateLimitError(rl), true)
})

test('C5.7 — erro bruto com "429 too many requests" na mensagem: reconhecido como RATE_LIMIT', () => {
  const raw = Object.assign(new Error('ZAI_PROVIDER_ERROR: 429 too many requests'), { code: 'PROVIDER_ERROR' })
  assert.equal(errorClassOf(raw), 'RATE_LIMIT')
  assert.equal(isRateLimitError(raw), true)
  assert.equal(eligibleForChainFailover(raw), false)
})

test('C5.8 — backoff padrão é 5s → 10s → 20s com máximo 3 tentativas', () => {
  assert.deepEqual([...RATE_LIMIT_BACKOFF_MS], [5_000, 10_000, 20_000])
  assert.equal(RATE_LIMIT_MAX_ATTEMPTS, 3)
})

test('C5.9 — rota exaurida por 429s (switch-now em todas) → QUOTA_EXHAUSTED no fim do chain', async () => {
  const p1 = makeProvider('bai', [err('RATE_LIMIT')])
  const p2 = makeProvider('bai', [err('RATE_LIMIT')])
  await assert.rejects(
    executeWithChain(
      entries(
        { provider: 'bai', llm: p1, model: 'hy3', onRateLimit: 'switch-now' },
        { provider: 'bai', llm: p2, model: 'qwen3.8-flash', onRateLimit: 'switch-now' }
      ),
      { messages: [] },
      RL_FAST
    ),
    (e: Error & { code?: string; errorClass?: string }) => {
      assert.equal(e.code, 'QUOTA_EXHAUSTED', 'caiu por rate limit → honesto, não ALL_PROVIDERS_FAILED')
      assert.equal(e.errorClass, 'RATE_LIMIT')
      return true
    }
  )
  assert.equal(p1.calls.length, 1)
  assert.equal(p2.calls.length, 1)
})

// ---------- C6: falhas elegíveis avançam (não-429) ----------

for (const cls of ['SERVER_ERROR', 'NETWORK', 'TIMEOUT', 'AUTH'] as const) {
  test(`C6 — falha elegível ${cls} no primário → failover para o segundo`, async () => {
    const p1 = makeProvider('bai', [err(cls)])
    const p2 = makeProvider('nvidia', ['ok'])
    const r = await executeWithChain(
      entries({ provider: 'bai', llm: p1, model: 'glm' }, { provider: 'nvidia', llm: p2, model: 'nemo' }),
      { messages: [] },
      RL_FAST
    )
    assert.equal(r.provider, 'nvidia')
    assert.equal(r.result.content, 'ok:nemo')
    assert.equal(p2.calls.length, 1)
  })
}

test('C6.5 — BAIKeyError ALL_KEYS_FAILED (2 chaves exauridas, sem errorClass) → failover', async () => {
  const exhausted = Object.assign(new Error('BAI_TODAS_CHAVES_FALHARAM'), { code: 'ALL_KEYS_FAILED' })
  const p1 = makeProvider('bai', [exhausted])
  const p2 = makeProvider('nvidia', ['ok'])
  const r = await executeWithChain(
    entries({ provider: 'bai', llm: p1, model: 'm' }, { provider: 'nvidia', llm: p2, model: 'm2' }),
    { messages: [] },
    RL_FAST
  )
  assert.equal(r.provider, 'nvidia')
})

// ---------- C7: não-elegíveis não avançam (conservador) ----------

test('C7.1 — CLIENT_ERROR (400/404): SEM failover', async () => {
  const p1 = makeProvider('bai', [err('CLIENT_ERROR')])
  const p2 = makeProvider('nvidia', ['ok'])
  await assert.rejects(
    executeWithChain(entries({ provider: 'bai', llm: p1, model: 'm' }, { provider: 'nvidia', llm: p2, model: 'm2' }), { messages: [] }, RL_FAST)
  )
  assert.equal(p2.calls.length, 0, 'CLIENT_ERROR não deve avançar no chain')
})

test('C7.2 — UNKNOWN: SEM failover', async () => {
  const p1 = makeProvider('bai', [err('UNKNOWN')])
  const p2 = makeProvider('nvidia', ['ok'])
  await assert.rejects(
    executeWithChain(entries({ provider: 'bai', llm: p1, model: 'm' }, { provider: 'nvidia', llm: p2, model: 'm2' }), { messages: [] }, RL_FAST)
  )
  assert.equal(p2.calls.length, 0)
})

test('C7.3 — BAIKeyError ALL_KEYS_FAILED com CLIENT_ERROR: SEM failover', async () => {
  const clientFail = Object.assign(new Error('BAI_FALHA'), { code: 'ALL_KEYS_FAILED', errorClass: 'CLIENT_ERROR' })
  const p1 = makeProvider('bai', [clientFail])
  const p2 = makeProvider('nvidia', ['ok'])
  await assert.rejects(
    executeWithChain(entries({ provider: 'bai', llm: p1, model: 'm' }, { provider: 'nvidia', llm: p2, model: 'm2' }), { messages: [] }, RL_FAST)
  )
  assert.equal(p2.calls.length, 0)
})

// ---------- C8: sucesso e erro controlado do chain ----------

test('C8.1 — primário bem-sucedido: nenhum failover', async () => {
  const p1 = makeProvider('bai', ['ok'])
  const p2 = makeProvider('nvidia', ['ok'])
  const r = await executeWithChain(
    entries({ provider: 'bai', llm: p1, model: 'glm' }, { provider: 'nvidia', llm: p2, model: 'nemo' }),
    { messages: [] },
    RL_FAST
  )
  assert.equal(r.provider, 'bai')
  assert.equal(p1.calls.length, 1)
  assert.equal(p2.calls.length, 0)
})

test('C8.2 — todos elegíveis falham → CHAIN_EXAURIDO com tentativas', async () => {
  const p1 = makeProvider('bai', [err('SERVER_ERROR')])
  const p2 = makeProvider('nvidia', [err('NETWORK')])
  await assert.rejects(
    executeWithChain(
      entries(
        { provider: 'bai', llm: p1, model: 'a' },
        { provider: 'nvidia', llm: p2, model: 'b' }
      ),
      { messages: [] },
      RL_FAST
    ),
    (e: Error & { code?: string; attempts?: unknown[] }) => {
      assert.equal(e.code, 'ALL_PROVIDERS_FAILED')
      assert.match(e.message, /CHAIN_EXAURIDO/)
      assert.equal((e.attempts ?? []).length, 2)
      return true
    }
  )
})

test('C8.3 — chain vazio → erro controlado CHAIN_VAZIA', async () => {
  await assert.rejects(
    executeWithChain([], { messages: [] }),
    (e: Error & { code?: string }) => e.code === 'UNAVAILABLE' && /CHAIN_VAZIA/.test(e.message)
  )
})

// ---------- C9: EXPERIENTIAL ELIMINADA (Tarefa C §2) ----------

test('C9.1 — NENHUMA versão/rota referencia o provider "explabs"', () => {
  const allStops = Object.values(VERSION_ROUTES)
    .flatMap((roles) => Object.values(roles))
    .flat()
  assert.ok(allStops.length >= 15, 'sanidade: rotas populadas')
  for (const stop of allStops) {
    assert.notEqual(stop.provider, 'explabs', `parada ${stop.model} referencia explabs!`)
    assert.ok(['bai', 'zai', 'nvidia'].includes(stop.provider), `provider inválido: ${stop.provider}`)
  }
})

test('C9.2 — nenhum chain de versão contém "explabs"', () => {
  for (const v of POSKLI_VERSIONS) {
    const chain = resolveChain(v, ALL) as string[]
    assert.ok(!chain.includes('explabs'), `chain da versão ${v} contém explabs!`)
  }
  // mesmo sem config, nunca aparece
  for (const v of POSKLI_VERSIONS) {
    const chain = resolveChain(v, ctx({ nvidiaConfigured: false })) as string[]
    assert.ok(!chain.includes('explabs'))
  }
})

// ---------- C10: modelo físico correto por provider ----------

test('C10.1 — cada entrada usa o modelo físico do próprio provider', async () => {
  const p1 = makeProvider('bai', [err('NETWORK'), 'ok'])
  const p2 = makeProvider('nvidia', ['ok'])
  const r = await executeWithChain(
    entries({ provider: 'bai', llm: p1, model: 'glm-5.3-flash' }, { provider: 'nvidia', llm: p2, model: 'nvidia/nemotron-3-super-120b-a12b' }),
    { messages: [] },
    RL_FAST
  )
  assert.deepEqual(p1.calls, ['glm-5.3-flash'])
  assert.deepEqual(p2.calls, ['nvidia/nemotron-3-super-120b-a12b'])
  assert.equal(r.provider, 'nvidia')
})

test('C10.2 — opts (temperature/maxTokens) repassados ao provider', async () => {
  let seenTemp: number | undefined
  let seenMax: number | undefined
  let seenModel: string | undefined
  const p: LLMProvider = {
    name: 'nvidia',
    isAvailable: async () => true,
    complete: async (req) => {
      seenTemp = req.temperature
      seenMax = req.maxTokens
      seenModel = req.model
      return fakeResult(req.model)
    },
  }
  await executeWithChain(entries({ provider: 'nvidia', llm: p, model: 'x' }), {
    messages: [],
    temperature: 0.3,
    maxTokens: 128,
  }, RL_FAST)
  assert.equal(seenTemp, 0.3)
  assert.equal(seenMax, 128)
  assert.equal(seenModel, 'x')
})

// ---------- C11: superagent — dupla de coding (Tarefa C) ----------

test('C11.1 — superagent coding: Hy3 E Qwen disponíveis (dupla) + DeepSeek NVIDIA', () => {
  const coding = VERSION_ROUTES.superagent.coding
  const models = coding.map((s) => s.model)
  assert.deepEqual(models, ['hy3', 'qwen', 'deepseek'])
  assert.equal(coding[0].provider, 'bai')
  assert.equal(coding[0].onRateLimit, 'switch-now', 'Hy3 429 → Qwen imediato (mesma conta)')
})

test('C11.2 — superagent: master GLM→Nemotron e review GPT-OSS→Luna', () => {
  const r = VERSION_ROUTES.superagent
  assert.deepEqual(r.master.map((s) => [s.provider, s.model]), [['bai', 'glm'], ['nvidia', 'nemotron']])
  assert.deepEqual(r.review.map((s) => [s.provider, s.model]), [['nvidia', 'gpt-oss'], ['bai', 'luna']])
})

test('C11.3 — 0.3.1 review usa GPT-OSS-20B (NVIDIA) como PRINCIPAL', () => {
  const review = VERSION_ROUTES['0.3.1'].review
  assert.equal(review[0].provider, 'nvidia')
  assert.equal(review[0].model, 'gpt-oss')
  assert.equal(review[1].model, 'luna', 'fallback GPT-5.6 Luna (B.AI) se NVIDIA falhar por quota')
})

// ---------- C12: TRUNCAGEM de outputs (Tarefa C §3d) ----------

test('C12.1 — output >2k chars é cortado com marcador no início', () => {
  const big = 'x'.repeat(5000)
  const clipped = clipToolOutput(big)
  assert.ok(clipped.startsWith(TOOL_OUTPUT_MARKER), 'prefixo "[Output truncado - 2k chars]" no início')
  assert.equal(clipped.length, TOOL_OUTPUT_MARKER.length + 1 + 2000)
})

test('C12.2 — output <=2k chars passa intacto (sem marcador)', () => {
  const small = 'y'.repeat(2000)
  assert.equal(clipToolOutput(small), small)
  assert.equal(clipToolOutput('ok curto'), 'ok curto')
})
