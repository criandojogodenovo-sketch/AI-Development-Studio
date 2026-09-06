// ============================================================
// PROVIDER CHAIN — TESTES UNITÁRIOS (node:test + type stripping)
// Executar: node --test tests/providers-chain.test.ts
// Valida as REGRAS do roteamento por versão do Poskli:
//   C1.  Chains por versão (0.1/0.2/0.3.1/1.0-flash/expposkli-*)
//   C2.  Providers não configurados ficam FORA do chain
//   C3.  Sem BAI → SDK sandbox (zai) substitui
//   C4.  EXPLABS no 0.3.1 somente para tarefas difíceis
//   C5.  429/rate limit NUNCA faz failover (política inviolável)
//   C6.  Falhas elegíveis (rede/5xx/timeout/401) avançam
//   C7.  CLIENT_ERROR/UNKNOWN não avançam (conservador)
//   C8.  BAI ALL_KEYS_FAILED (2 chaves exauridas) avança
//   C9.  Chain vazio → erro controlado; chain exaurido → tentativas
//   C10. Modelo físico correto por provider
//   C11. expposkli-*: EXCLUSIVO Experiential (nunca NVIDIA/B.AI) +
//         modelFallback repassado ao provider (retry interno)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveChain,
  normalizeVersion,
  executeWithChain,
  errorClassOf,
  eligibleForChainFailover,
  isExpposkliVersion,
  POSKLI_VERSIONS,
  DEFAULT_POSKLI_VERSION,
  type ChainContext,
  type ChainEntry,
} from '../src/lib/studio/models/chain.ts'
import type { BAIErrorClass } from '../src/lib/studio/models/error-classes.ts'
import type { CompletionResult, LLMProvider, ProviderName } from '../src/lib/studio/models/types.ts'

// ---------- FÁBRICAS ----------

const ALL: ChainContext = { baiConfigured: true, nvidiaConfigured: true, explabsConfigured: true }

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

function entries(...list: Array<{ provider: ProviderName; llm: LLMProvider; model: string }>): ChainEntry[] {
  return list
}

// ---------- C1: chains por versão ----------

test('C1.1 — versão 0.1 com tudo configurado: apenas BAI', () => {
  assert.deepEqual(resolveChain('0.1', ALL), ['bai'])
})

test('C1.2 — versão 0.2: BAI → NVIDIA', () => {
  assert.deepEqual(resolveChain('0.2', ALL), ['bai', 'nvidia'])
})

test('C1.3 — versão 0.3.1 (dificuldade hard): BAI → NVIDIA → EXPLABS', () => {
  assert.deepEqual(resolveChain('0.3.1', ctx({ difficulty: 'hard' })), ['bai', 'nvidia', 'explabs'])
})

test('C1.4 — versão 1.0-flash: NVIDIA → EXPLABS → BAI (reserva)', () => {
  assert.deepEqual(resolveChain('1.0-flash', ALL), ['nvidia', 'explabs', 'bai'])
})

test('C1.5 — expposkli-1.0: EXPLABS EXCLUSIVO (nada mais entra, nem com tudo configurado)', () => {
  assert.deepEqual(resolveChain('expposkli-1.0', ALL), ['explabs'])
})

test('C1.6 — expposkli-1.1: EXPLABS EXCLUSIVO (idem)', () => {
  assert.deepEqual(resolveChain('expposkli-1.1', ALL), ['explabs'])
})

// ---------- C2: providers ausentes ficam fora ----------

test('C2.1 — 0.2 sem chave NVIDIA: apenas BAI', () => {
  assert.deepEqual(resolveChain('0.2', ctx({ nvidiaConfigured: false })), ['bai'])
})

test('C2.2 — 1.0-flash sem NVIDIA e sem EXPLABS: apenas BAI', () => {
  assert.deepEqual(resolveChain('1.0-flash', ctx({ nvidiaConfigured: false, explabsConfigured: false })), ['bai'])
})

test('C2.3 — expposkli-1.0 sem chave EXPLABS: chain VAZIO (erro honesto, SEM substituto)', () => {
  assert.deepEqual(resolveChain('expposkli-1.0', ctx({ explabsConfigured: false })), [])
})

test('C2.4 — expposkli-1.1 sem chave EXPLABS: chain VAZIO (idem — nunca cai para BAI/NVIDIA)', () => {
  assert.deepEqual(resolveChain('expposkli-1.1', ctx({ explabsConfigured: false })), [])
})

// ---------- C3: sandbox zai substitui BAI ----------

test('C3.1 — sem chaves BAI (sandbox): zai entra no lugar do BAI', () => {
  assert.deepEqual(resolveChain('0.2', ctx({ baiConfigured: false })), ['zai', 'nvidia'])
})

test('C3.2 — 0.1 sem BAI: apenas zai (comportamento histórico preservado)', () => {
  assert.deepEqual(resolveChain('0.1', ctx({ baiConfigured: false })), ['zai'])
})

test('C3.3 — 1.0-flash sem BAI: NVIDIA → EXPLABS → zai', () => {
  assert.deepEqual(resolveChain('1.0-flash', ctx({ baiConfigured: false })), ['nvidia', 'explabs', 'zai'])
})

// ---------- C4: EXPLABS só em tarefas difíceis (0.3.1) ----------

test('C4.1 — 0.3.1 dificuldade média (default): SEM EXPLABS', () => {
  assert.deepEqual(resolveChain('0.3.1', ALL), ['bai', 'nvidia'])
})

test('C4.2 — 0.3.1 dificuldade easy: SEM EXPLABS', () => {
  assert.deepEqual(resolveChain('0.3.1', ctx({ difficulty: 'easy' })), ['bai', 'nvidia'])
})

test('C4.3 — 0.3.1 hard mas sem chave EXPLABS: BAI → NVIDIA', () => {
  assert.deepEqual(resolveChain('0.3.1', ctx({ difficulty: 'hard', explabsConfigured: false })), ['bai', 'nvidia'])
})

// ---------- normalizeVersion ----------

test('C4.4 — normalizeVersion: inválido/ausente → default 0.2', () => {
  assert.equal(normalizeVersion('9.9'), DEFAULT_POSKLI_VERSION)
  assert.equal(normalizeVersion(undefined), DEFAULT_POSKLI_VERSION)
  assert.equal(normalizeVersion(''), DEFAULT_POSKLI_VERSION)
  assert.equal(normalizeVersion('1.0-flash'), '1.0-flash')
  assert.equal(normalizeVersion(' 0.3.1 '), '0.3.1')
})

test('C4.5 — normalizeVersion: expposkli-1.0/1.1 válidos; POSKLI_VERSIONS inclui as 6 versões', () => {
  assert.equal(normalizeVersion('expposkli-1.0'), 'expposkli-1.0')
  assert.equal(normalizeVersion(' expposkli-1.1 '), 'expposkli-1.1')
  assert.equal(normalizeVersion('expposkli-2.0'), DEFAULT_POSKLI_VERSION)
  assert.deepEqual(POSKLI_VERSIONS, ['0.1', '0.2', '0.3.1', '1.0-flash', 'expposkli-1.0', 'expposkli-1.1'])
  assert.equal(isExpposkliVersion('expposkli-1.0'), true)
  assert.equal(isExpposkliVersion('expposkli-1.1'), true)
  assert.equal(isExpposkliVersion('0.2'), false)
  assert.equal(isExpposkliVersion('1.0-flash'), false)
})

// ---------- C5: 429 NUNCA faz failover ----------

test('C5.1 — errorClass RATE_LIMIT (429): propaga SEM failover', async () => {
  const p1 = makeProvider('bai', [err('RATE_LIMIT')])
  const p2 = makeProvider('nvidia', ['ok'])
  await assert.rejects(
    executeWithChain(entries({ provider: 'bai', llm: p1, model: 'm' }, { provider: 'nvidia', llm: p2, model: 'm2' }), { messages: [] }),
    (e: Error & { errorClass?: string }) => e.errorClass === 'RATE_LIMIT'
  )
  assert.equal(p2.calls.length, 0, 'segundo provider NÃO pode ser chamado em 429')
})

test('C5.2 — BAIKeyError RATE_LIMITED (código): propaga SEM failover', async () => {
  const rl = Object.assign(new Error('BAI_RATE_LIMIT'), { code: 'RATE_LIMITED' })
  const p1 = makeProvider('bai', [rl])
  const p2 = makeProvider('nvidia', ['ok'])
  await assert.rejects(
    executeWithChain(entries({ provider: 'bai', llm: p1, model: 'm' }, { provider: 'nvidia', llm: p2, model: 'm2' }), { messages: [] }),
    (e: Error & { code?: string }) => e.code === 'RATE_LIMITED'
  )
  assert.equal(p2.calls.length, 0)
})

test('C5.3 — erro bruto com "429 too many requests" na mensagem: SEM failover', async () => {
  const raw = Object.assign(new Error('ZAI_PROVIDER_ERROR: 429 too many requests'), { code: 'PROVIDER_ERROR' })
  assert.equal(errorClassOf(raw), 'RATE_LIMIT')
  assert.equal(eligibleForChainFailover(raw), false)
})

// ---------- C6: falhas elegíveis avançam ----------

for (const cls of ['SERVER_ERROR', 'NETWORK', 'TIMEOUT', 'AUTH'] as const) {
  test(`C6 — falha elegível ${cls} no primário → failover para o segundo`, async () => {
    const p1 = makeProvider('bai', [err(cls)])
    const p2 = makeProvider('nvidia', ['ok'])
    const r = await executeWithChain(
      entries({ provider: 'bai', llm: p1, model: 'glm' }, { provider: 'nvidia', llm: p2, model: 'nemo' }),
      { messages: [] }
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
    { messages: [] }
  )
  assert.equal(r.provider, 'nvidia')
})

// ---------- C7: não-elegíveis não avançam (conservador) ----------

test('C7.1 — CLIENT_ERROR (400/404): SEM failover', async () => {
  const p1 = makeProvider('bai', [err('CLIENT_ERROR')])
  const p2 = makeProvider('nvidia', ['ok'])
  await assert.rejects(
    executeWithChain(entries({ provider: 'bai', llm: p1, model: 'm' }, { provider: 'nvidia', llm: p2, model: 'm2' }), { messages: [] })
  )
  assert.equal(p2.calls.length, 0, 'CLIENT_ERROR não deve avançar no chain')
})

test('C7.2 — UNKNOWN: SEM failover', async () => {
  const p1 = makeProvider('bai', [err('UNKNOWN')])
  const p2 = makeProvider('nvidia', ['ok'])
  await assert.rejects(
    executeWithChain(entries({ provider: 'bai', llm: p1, model: 'm' }, { provider: 'nvidia', llm: p2, model: 'm2' }), { messages: [] })
  )
  assert.equal(p2.calls.length, 0)
})

test('C7.3 — BAIKeyError ALL_KEYS_FAILED com CLIENT_ERROR: SEM failover', async () => {
  const clientFail = Object.assign(new Error('BAI_FALHA'), { code: 'ALL_KEYS_FAILED', errorClass: 'CLIENT_ERROR' })
  const p1 = makeProvider('bai', [clientFail])
  const p2 = makeProvider('nvidia', ['ok'])
  await assert.rejects(
    executeWithChain(entries({ provider: 'bai', llm: p1, model: 'm' }, { provider: 'nvidia', llm: p2, model: 'm2' }), { messages: [] })
  )
  assert.equal(p2.calls.length, 0)
})

// ---------- C8: sucesso e erro controlado do chain ----------

test('C8.1 — primário bem-sucedido: nenhum failover', async () => {
  const p1 = makeProvider('bai', ['ok'])
  const p2 = makeProvider('nvidia', ['ok'])
  const r = await executeWithChain(
    entries({ provider: 'bai', llm: p1, model: 'glm' }, { provider: 'nvidia', llm: p2, model: 'nemo' }),
    { messages: [] }
  )
  assert.equal(r.provider, 'bai')
  assert.equal(p1.calls.length, 1)
  assert.equal(p2.calls.length, 0)
})

test('C8.2 — todos elegíveis falham → CHAIN_EXAURIDO com tentativas', async () => {
  const p1 = makeProvider('bai', [err('SERVER_ERROR')])
  const p2 = makeProvider('nvidia', [err('NETWORK')])
  const p3 = makeProvider('explabs', [err('TIMEOUT')])
  await assert.rejects(
    executeWithChain(
      entries(
        { provider: 'bai', llm: p1, model: 'a' },
        { provider: 'nvidia', llm: p2, model: 'b' },
        { provider: 'explabs', llm: p3, model: 'c' }
      ),
      { messages: [] }
    ),
    (e: Error & { code?: string; attempts?: unknown[] }) => {
      assert.equal(e.code, 'ALL_PROVIDERS_FAILED')
      assert.match(e.message, /CHAIN_EXAURIDO/)
      assert.equal((e.attempts ?? []).length, 3)
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

// ---------- C10: modelo físico correto por provider ----------

test('C10.1 — cada entrada usa o modelo físico do próprio provider', async () => {
  const p1 = makeProvider('bai', [err('NETWORK'), 'ok'])
  const p2 = makeProvider('nvidia', ['ok'])
  const r = await executeWithChain(
    entries({ provider: 'bai', llm: p1, model: 'glm-5.3-flash' }, { provider: 'nvidia', llm: p2, model: 'nvidia/nemotron-3-super-120b-a12b' }),
    { messages: [] }
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
  })
  assert.equal(seenTemp, 0.3)
  assert.equal(seenMax, 128)
  assert.equal(seenModel, 'x')
})

// ---------- C11: expposkli-* exclusividade + modelFallback ----------

test('C11.1 — entry com modelFallback: provider recebe model E modelFallback', async () => {
  let seenModel: string | undefined
  let seenFallback: string | undefined
  const p: LLMProvider = {
    name: 'explabs',
    isAvailable: async () => true,
    complete: async (req) => {
      seenModel = req.model
      seenFallback = req.modelFallback
      return fakeResult(req.model)
    },
  }
  await executeWithChain(
    [{ provider: 'explabs', llm: p, model: 'gpt-6-astra', modelFallback: 'aion-2.0' }],
    { messages: [] }
  )
  assert.equal(seenModel, 'gpt-6-astra')
  assert.equal(seenFallback, 'aion-2.0')
})

test('C11.2 — entry SEM modelFallback: req.modelFallback fica undefined (não vaza p/ outros providers)', async () => {
  let seenFallback: string | undefined = 'sentinela'
  const p: LLMProvider = {
    name: 'bai',
    isAvailable: async () => true,
    complete: async (req) => {
      seenFallback = req.modelFallback
      return fakeResult(req.model)
    },
  }
  await executeWithChain([{ provider: 'bai', llm: p, model: 'glm-5.3-flash' }], { messages: [] })
  assert.equal(seenFallback, undefined)
})

test('C11.3 — modelFallback igual ao model: NÃO é repassado (evita retry inútil)', async () => {
  let seenFallback: string | undefined = 'sentinela'
  const p: LLMProvider = {
    name: 'explabs',
    isAvailable: async () => true,
    complete: async (req) => {
      seenFallback = req.modelFallback
      return fakeResult(req.model)
    },
  }
  await executeWithChain(
    [{ provider: 'explabs', llm: p, model: 'aion-2.0', modelFallback: 'aion-2.0' }],
    { messages: [] }
  )
  assert.equal(seenFallback, undefined)
})

test('C11.4 — chain expposkli único provider: falha elegível exaure o chain SEM tocar outros providers', async () => {
  const explabs = makeProvider('explabs', [err('SERVER_ERROR')])
  const nvidia = makeProvider('nvidia', ['ok'])
  await assert.rejects(
    executeWithChain(
      // simula o resultado de resolveChain('expposkli-1.0', ALL): SÓ explabs
      [{ provider: 'explabs', llm: explabs, model: 'gpt-6-astra', modelFallback: 'aion-2.0' }],
      { messages: [] }
    ),
    (e: Error & { code?: string; attempts?: unknown[] }) => {
      assert.equal(e.code, 'ALL_PROVIDERS_FAILED')
      assert.equal((e.attempts ?? []).length, 1)
      return true
    }
  )
  assert.equal(nvidia.calls.length, 0, 'exclusividade: NUNCA failover para fora da Experiential')
})

test('C11.5 — chain expposkli com 429: propaga IMEDIATAMENTE (política inviolável mantida)', async () => {
  const explabs = makeProvider('explabs', [err('RATE_LIMIT')])
  await assert.rejects(
    executeWithChain(
      [{ provider: 'explabs', llm: explabs, model: 'claude-fable-5.1', modelFallback: 'aion-2.0' }],
      { messages: [] }
    ),
    (e: Error & { errorClass?: string }) => e.errorClass === 'RATE_LIMIT'
  )
  assert.equal(explabs.calls.length, 1)
})
