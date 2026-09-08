// ============================================================
// STALL WATCHDOG (NÚCLEO PURO) — TESTES (node:test)
// Executar: node --test tests/poskli-stall-watchdog.test.ts
// FIX do congelamento em IMPLEMENTING:
//   W1. >30s sem atividade → stalled (kill com TIMEOUT)
//   W2. atividade recente → NÃO stalled (trabalho vivo)
//   W3. exatamente o limite → NÃO stalled (>) — margem do contracto
//   W4. registry: touchPoskliActivity toca o watchdog do run
//   W5. registry: unregister limpa (sem watchdog → silencioso)
//   W6. touchPoskliActivity com id nulo/inexistente → nunca lança
//   W7. stallTimeoutMs configurável (RUN_STALL_TIMEOUT_MS)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  stallWatchdogDecision,
  touchPoskliActivity,
  registerTouch,
  unregisterTouch,
  touchRegistrySize,
} from '../src/lib/studio/poskli/stall-watchdog-core.ts'

const BASE = 100_000

test('W1 — >30s sem atividade real → stalled (kill com TIMEOUT)', () => {
  const d = stallWatchdogDecision({
    lastActivityAtMs: BASE,
    nowMs: BASE + 30_001,
    stallTimeoutMs: 30_000,
  })
  assert.equal(d.stalled, true)
  assert.equal(d.silentMs, 30_001)
})

test('W2 — atividade recente (5s) → NÃO stalled (trabalho vivo)', () => {
  const d = stallWatchdogDecision({
    lastActivityAtMs: BASE,
    nowMs: BASE + 5_000,
    stallTimeoutMs: 30_000,
  })
  assert.equal(d.stalled, false)
})

test('W3 — exatamente no limite (30s) → NÃO stalled (regra é >)', () => {
  const d = stallWatchdogDecision({
    lastActivityAtMs: BASE,
    nowMs: BASE + 30_000,
    stallTimeoutMs: 30_000,
  })
  assert.equal(d.stalled, false, 'limite exato ainda é trabalho vivo (>)')
})

test('W4 — registry: touchPoskliActivity toca o watchdog do run', () => {
  const runId = 'run_test_touch'
  let touched = 0
  registerTouch(runId, () => {
    touched++
  })
  try {
    touchPoskliActivity(runId)
    touchPoskliActivity(runId)
    assert.equal(touched, 2, 'cada chamada registra atividade')
  } finally {
    unregisterTouch(runId)
  }
})

test('W5 — unregister limpa o registry do run', () => {
  const runId = 'run_test_cleanup'
  const before = touchRegistrySize()
  registerTouch(runId, () => {})
  assert.equal(touchRegistrySize(), before + 1)
  unregisterTouch(runId)
  assert.equal(touchRegistrySize(), before, 'registry volta ao tamanho inicial')
})

test('W6 — id nulo/inexistente → silencioso (nunca lança)', () => {
  assert.doesNotThrow(() => touchPoskliActivity(undefined))
  assert.doesNotThrow(() => touchPoskliActivity(null))
  assert.doesNotThrow(() => touchPoskliActivity('run_nunca_registrado'))
})

test('W7 — stallTimeoutMs configurável (ex.: 60s p/ runs pesados)', () => {
  const d = stallWatchdogDecision({
    lastActivityAtMs: BASE,
    nowMs: BASE + 45_000,
    stallTimeoutMs: 60_000,
  })
  assert.equal(d.stalled, false, '45s ainda é trabalho vivo com limite 60s')
  const d2 = stallWatchdogDecision({
    lastActivityAtMs: BASE,
    nowMs: BASE + 61_000,
    stallTimeoutMs: 60_000,
  })
  assert.equal(d2.stalled, true)
})
