// ============================================================
// TIMEOUT GLOBAL POR CHAMADA DE MODELO — TESTES (node:test)
// Executar: node --test tests/providers-call-timeout.test.ts
// FIX do congelamento em IMPLEMENTING:
//   CT1. modelo pendente (nunca responde) → MODEL_CALL_TIMEOUT
//        estoura → chain AVANÇA para a próxima parada → sucesso
//   CT2. erro do timeout: errorClass TIMEOUT + callTimeout true
//        (elegível para failover — nunca CLIENT_ERROR)
//   CT3. chain com ÚNICA parada pendente → ALL_PROVIDERS_FAILED
//        (não QUOTA_EXHAUSTED — timeout não é rate limit)
//   CT4. chamadas rápidas com timeout grande → sem interferência
//   CT5. timeout em TODAS as paradas → tentativas registradas
//        (rastreabilidade do failover)
//   CT6. promessa abandonada não gera unhandled rejection
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  executeWithChain,
  callTimeoutError,
  MODEL_CALL_TIMEOUT_DEFAULT_MS,
  type ChainEntry,
} from '../src/lib/studio/models/chain.ts'
import type { CompletionResult, LLMProvider, ProviderName } from '../src/lib/studio/models/types.ts'

// ---------- FÁBRICAS ----------

function fakeResult(model: string): CompletionResult {
  return { content: `ok:${model}`, promptTokens: 1, completionTokens: 1, model, durationMs: 1, finishReason: 'stop' }
}

/** Provider que NUNCA responde (promessa que não settle — inert). */
function hangingProvider(name: string): LLMProvider & { started: number } {
  let started = 0
  return {
    name,
    get started() {
      return started
    },
    isAvailable: async () => true,
    complete: async () => {
      started++
      return new Promise<CompletionResult>(() => {}) // nunca settle
    },
  }
}

function okProvider(name: string): LLMProvider {
  return {
    name,
    isAvailable: async () => true,
    complete: async (req: { model: string }) => fakeResult(req.model),
  }
}

function entry(provider: ProviderName, llm: LLMProvider, model = 'm'): ChainEntry {
  return { provider, llm, model }
}

const RL_FAST = { sleep: async () => {}, backoffMs: [0, 0, 0] } as const

// ---------- CT1: pendência → failover para a próxima parada ----------

test('CT1 — modelo pendente estoura timeout → próxima parada do pool assume', async () => {
  const hang = hangingProvider('bai')
  const ok = okProvider('nvidia')
  const out = await executeWithChain(
    [entry('bai', hang), entry('nvidia', ok)],
    { messages: [{ role: 'user', content: 'oi' }] },
    { ...RL_FAST, callTimeoutMs: 20 }
  )
  assert.equal(out.provider, 'nvidia', 'failover para a segunda parada')
  assert.match(out.result.content, /^ok:/)
  assert.equal(hang.started, 1, 'a parada pendente foi chamada uma vez')
})

// ---------- CT2: classe do erro ----------

test('CT2 — erro do timeout global: TIMEOUT + elegível p/ failover', () => {
  const e = callTimeoutError('bai' as ProviderName, 'glm-5.3-flash', 30_000)
  assert.equal((e as { errorClass?: string }).errorClass, 'TIMEOUT')
  assert.equal((e as { timedOut?: boolean }).timedOut, true)
  assert.equal((e as { callTimeout?: boolean }).callTimeout, true)
  assert.equal((e as { code?: string }).code, 'MODEL_CALL_TIMEOUT')
  assert.match(e.message, /glm-5\.3-flash/)
  assert.match(e.message, /30s|30000/, 'mensagem inclui o prazo')
})

// ---------- CT3: parada única pendente → chain exaurido ----------

test('CT3 — única parada pendente → ALL_PROVIDERS_FAILED (não QUOTA)', async () => {
  await assert.rejects(
    executeWithChain(
      [entry('bai', hangingProvider('bai'))],
      { messages: [{ role: 'user', content: 'oi' }] },
      { ...RL_FAST, callTimeoutMs: 15 }
    ),
    (err: { code?: string; errorClass?: string }) => {
      assert.equal(err.code, 'ALL_PROVIDERS_FAILED')
      assert.notEqual(err.code, 'QUOTA_EXHAUSTED', 'timeout ≠ rate limit')
      return true
    }
  )
})

// ---------- CT4: sem interferência em chamadas rápidas ----------

test('CT4 — timeout grande (600s) não interfere em chamadas rápidas', async () => {
  const out = await executeWithChain(
    [entry('bai', okProvider('bai'))],
    { messages: [{ role: 'user', content: 'oi' }] },
    { ...RL_FAST, callTimeoutMs: 600_000 }
  )
  assert.equal(out.provider, 'bai')
  assert.match(out.result.content, /^ok:/)
})

// ---------- CT5: rastreabilidade das tentativas ----------

test('CT5 — timeout em TODAS as paradas → tentativas registradas no erro', async () => {
  await assert.rejects(
    executeWithChain(
      [entry('bai', hangingProvider('bai')), entry('nvidia', hangingProvider('nvidia'))],
      { messages: [{ role: 'user', content: 'oi' }] },
      { ...RL_FAST, callTimeoutMs: 10 }
    ),
    (err: { code?: string; attempts?: Array<{ provider: string; errorClass: string }> }) => {
      assert.equal(err.code, 'ALL_PROVIDERS_FAILED')
      assert.equal(err.attempts?.length, 2, 'cada parada registrou a tentativa')
      assert.deepEqual(
        err.attempts?.map((a) => a.errorClass),
        ['TIMEOUT', 'TIMEOUT']
      )
      return true
    }
  )
})

// ---------- CT6: promessa abandonada não derruba o processo ----------

test('CT6 — promessa abandonada é inerte (sem unhandled rejection)', async () => {
  // a promessa nunca settle — o handlers do race já está anexado;
  // o processo de teste termina limpo se nada "explode"
  const rejector = {
    name: 'bai',
    isAvailable: async () => true,
    complete: () =>
      new Promise<CompletionResult>((_, reject) => {
        // rejeita TARDE (depois do timeout do chain já ter avançado)
        setTimeout(() => reject(new Error('tardio')), 40)
      }),
  } as unknown as LLMProvider
  const out = await executeWithChain(
    [entry('bai', rejector), entry('nvidia', okProvider('nvidia'))],
    { messages: [{ role: 'user', content: 'oi' }] },
    { ...RL_FAST, callTimeoutMs: 5 }
  )
  assert.equal(out.provider, 'nvidia')
  // aguarda a rejeição tardia chegar — handlers anexados = inerte
  await new Promise((r) => setTimeout(r, 80))
})

// ---------- Default documentado ----------

test('CT7 — default do timeout global é 30s (spec do fix)', () => {
  assert.equal(MODEL_CALL_TIMEOUT_DEFAULT_MS, 30_000)
})

// ---------- CT8: atividade por tentativa de parada (watchdog) ----------

test('CT8 — onStopAttempt dispara a cada tentativa de parada (failover = atividade)', async () => {
  const seen: string[] = []
  const hang = hangingProvider('bai')
  const ok = okProvider('nvidia')
  await executeWithChain(
    [entry('bai', hang), entry('nvidia', ok)],
    { messages: [{ role: 'user', content: 'oi' }] },
    {
      ...RL_FAST,
      callTimeoutMs: 15,
      onStopAttempt: (provider, model) => seen.push(`${provider}/${model}`),
    }
  )
  // uma tentativa na parada pendente + uma na parada que assume
  assert.equal(seen.length, 2)
  assert.equal(seen[0], 'bai/m')
  assert.equal(seen[1], 'nvidia/m')
})

test('CT9 — onStopAttempt com erro no callback nunca derruba o chain', async () => {
  const out = await executeWithChain(
    [entry('bai', okProvider('bai'))],
    { messages: [{ role: 'user', content: 'oi' }] },
    {
      ...RL_FAST,
      callTimeoutMs: 600_000,
      onStopAttempt: () => {
        throw new Error('callback explodiu')
      },
    }
  )
  assert.match(out.result.content, /^ok:/, 'chain segue apesar do callback com erro')
})
