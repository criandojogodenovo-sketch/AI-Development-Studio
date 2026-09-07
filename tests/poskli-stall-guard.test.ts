// ============================================================
// STALL GUARD + LABORATÓRIO — TESTES (node:test, PURO)
// Executar: node --test tests/poskli-stall-guard.test.ts
// FIX do travamento "A pensar durante 45s…":
//   S1. análise sem NENHUMA tool por >30s → aviso honesto
//   S2. análise com atividade recente → sem aviso
//   S3. estado não-pensante (IMPLEMENTING…) → nunca stalled
//   S4. limite personalizável (warnAfterMs)
//   L1. LABORATÓRIO oculto no estado inativo (interface limpa)
//   L2. visível durante run ativo; e quando aberto (p/ fechar)
//   E1. evento thinking aceita nota opcional (contrato do stream)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  thinkingStallDecision,
  techAccessVisible,
  THINKING_STALL_WARN_MS,
  isThinkingState,
  encodeSseEvent,
} from '../src/lib/poskli-chat.ts'

test('S1 — análise sem tool por >30s → stalled com nota honesta', () => {
  const started = 100_000
  const d = thinkingStallDecision({
    state: 'ANALYZING',
    startedAtMs: started,
    lastToolAtMs: null,
    nowMs: started + 31_000,
  })
  assert.equal(d.stalled, true)
  assert.match(d.note ?? '', /Aguardando o modelo/i)
  assert.match(d.note ?? '', /não travou/i, 'nota tranquiliza: não é travamento')
})

test('S2 — análise com atividade recente → sem aviso (trabalho normal)', () => {
  const started = 100_000
  const d = thinkingStallDecision({
    state: 'PLANNING',
    startedAtMs: started,
    lastToolAtMs: started + 50_000,
    nowMs: started + 60_000, // 10s após a última tool
  })
  assert.equal(d.stalled, false)
  assert.equal(d.note, undefined)
})

test('S3 — estado não-pensante nunca stalled (implementação/testes)', () => {
  for (const state of ['IMPLEMENTING', 'TESTING', 'VERIFYING', 'COMPLETED']) {
    const d = thinkingStallDecision({
      state,
      startedAtMs: 0,
      lastToolAtMs: null,
      nowMs: 999_999,
    })
    assert.equal(d.stalled, false, `${state} não é pensamento`)
  }
  assert.equal(isThinkingState('ANALYZING'), true)
  assert.equal(isThinkingState('PLANNING'), true)
  assert.equal(isThinkingState('IMPLEMENTING'), false)
})

test('S4 — limite personalizável (warnAfterMs) e default documentado', () => {
  assert.equal(THINKING_STALL_WARN_MS, 30_000)
  const d = thinkingStallDecision({
    state: 'ANALYZING',
    startedAtMs: 0,
    lastToolAtMs: null,
    nowMs: 6_000,
    warnAfterMs: 5_000,
  })
  assert.equal(d.stalled, true, 'custom 5s dispara antes')
})

test('L1 — LABORATÓRIO: oculto quando inativo E fechado (interface 100% limpa)', () => {
  assert.equal(techAccessVisible({ runActive: false, techOpen: false }), false)
})

test('L2 — LABORATÓRIO: visível durante run ativo (ícone discreto) ou aberto p/ fechar', () => {
  assert.equal(techAccessVisible({ runActive: true, techOpen: false }), true, 'run ativo → visível')
  assert.equal(techAccessVisible({ runActive: true, techOpen: true }), true)
  // run terminou mas painel aberto → mantém VISÍVEL para o utilizador
  // fechar (auto-close da UI cuida de limpar depois)
  assert.equal(techAccessVisible({ runActive: false, techOpen: true }), true)
})

test('E1 — evento thinking transporta nota opcional no SSE (contrato)', () => {
  const withNote = encodeSseEvent({ type: 'thinking', seconds: 45, note: 'Aguardando o modelo responder…' })
  assert.match(withNote, /event: thinking/)
  assert.match(withNote, /"note":"Aguardando/)
  const plain = encodeSseEvent({ type: 'thinking', seconds: 3 })
  assert.ok(!plain.includes('"note"'), 'sem nota quando não stalled')
})
