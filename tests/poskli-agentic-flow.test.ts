// ============================================================
// AGENTIC FLOW — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-agentic-flow.test.ts
// Substituição do pipeline fixo por LOOP AGÊNTICO:
//   A1. orçamento de correções: teto 2 edições
//   A2. agenticFixDecision — para após 2 tentativas de edição
//   A3. loop-guard integrado: mesma falha 2x → parar
//   A4. edição sem mudança no repo → parar
//   A5. falhas DISTINTAS + repo mudando → continua (até o teto)
//   A6. derivação com reviewRequired=false → não bloqueia por
//       revisão (modo agêntico — verificação por testes)
//   A7. derivação agêntica completa: tasks+testes+verificação OK
//       → SUCCESS sem etapa de revisão
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agenticFixBudget, agenticFixDecision, MAX_FIX_ATTEMPTS,
  failureSignature,
} from '../src/lib/studio/poskli/loop-guard.ts'
import {
  deriveFinalStatus, buildVerificationChecks,
  type DeriveFinalStatusInput, type TaskSnapshot, type TestRecordSnapshot,
} from '../src/lib/studio/poskli/state-machine.ts'

function task(id: string, status: TaskSnapshot['status']): TaskSnapshot {
  return { id, title: `Tarefa ${id}`, status, required: true }
}
function testRec(status: 'PASS' | 'FAIL'): TestRecordSnapshot {
  return { id: 'x', status, command: 'npm test', trigger: 'INITIAL', exitCode: status === 'PASS' ? 0 : 1 }
}
function baseInput(overrides: Partial<DeriveFinalStatusInput> = {}): DeriveFinalStatusInput {
  return {
    cancelled: false,
    interrupted: false,
    tasks: [task('t1', 'COMPLETED'), task('t2', 'COMPLETED')],
    tests: [testRec('PASS')],
    review: { status: 'NOT_RUN', attempts: 0 },
    corrections: [],
    verification: { ran: true, checks: buildVerificationChecks({ previewRequired: false, previewOk: null, buildRequired: false, buildOk: null, artifactsProduced: true }) },
    ...overrides,
  }
}

// ---------- A1: orçamento ----------

test('A1 — teto de rodadas de edição = 2 (spec do loop agêntico)', () => {
  assert.equal(MAX_FIX_ATTEMPTS, 2)
  assert.equal(agenticFixBudget(3), 2, 'run com 3 iterações → teto 2')
  assert.equal(agenticFixBudget(5), 2)
  assert.equal(agenticFixBudget(1), 1, 'run limitado a 1 iteração → 1')
  assert.equal(agenticFixBudget(2), 2)
})

// ---------- A2: decisão de continuar ----------

test('A2 — para honestamente após 2 tentativas de edição', () => {
  const d0 = agenticFixDecision({ fixAttempts: 0, fixBudget: 2, sameSignatures: ['e1'], repoChangedAfterFix: null })
  assert.equal(d0.continueFix, true, 'primeira edição permitida')

  const d1 = agenticFixDecision({ fixAttempts: 1, fixBudget: 2, sameSignatures: ['e1', 'e2'], repoChangedAfterFix: true })
  assert.equal(d1.continueFix, true, 'segunda edição permitida (falhas distintas, repo mudou)')

  const d2 = agenticFixDecision({ fixAttempts: 2, fixBudget: 2, sameSignatures: ['e1', 'e2', 'e3'], repoChangedAfterFix: true })
  assert.equal(d2.continueFix, false, 'teto de 2 edições esgotado')
  assert.equal(d2.reason, 'FIX_BUDGET_EXHAUSTED')
  assert.ok(d2.message.includes('TETO_DE_EDICOES'))
})

// ---------- A3: mesma assinatura → loop guard ----------

test('A3 — MESMA falha persistindo após edição → LOOP_GUARD para', () => {
  const failOut = (msg: string) => `npm test\n✖ ${msg} (1200ms)\nAssertionError: ${msg}`
  const sig = failureSignature(failOut('colisão falhou'), '')
  const d = agenticFixDecision({
    fixAttempts: 1,
    fixBudget: 2,
    sameSignatures: [sig, sig],
    repoChangedAfterFix: true,
  })
  assert.equal(d.continueFix, false, 'mesma assinatura 2x → parar (economia de tokens)')
  assert.equal(d.reason, 'LOOP_GUARD')
})

// ---------- A4: repo sem mudanças ----------

test('A4 — edição sem alterar o repositório → parar (agente girando)', () => {
  const d = agenticFixDecision({ fixAttempts: 1, fixBudget: 2, sameSignatures: ['e1', 'e2'], repoChangedAfterFix: false })
  assert.equal(d.continueFix, false)
  assert.equal(d.reason, 'LOOP_GUARD')
})

// ---------- A5: falhas distintas + repo mudando ----------

test('A5 — falhas DISTINTAS com repo mudando → continua o loop agêntico', () => {
  const d = agenticFixDecision({
    fixAttempts: 1,
    fixBudget: 2,
    sameSignatures: ['AssertionError: colisão', 'TypeError: cannot read x'],
    repoChangedAfterFix: true,
  })
  assert.equal(d.continueFix, true)
})

// ---------- A6/A7: derivação agêntica ----------

test('A6 — reviewRequired=false → critério revisão NÃO bloqueia (modo agêntico)', () => {
  const r = deriveFinalStatus(baseInput({ reviewRequired: false }))
  const reviewCrit = r.criteria.find((c) => c.id === 'review')!
  assert.equal(reviewCrit.status, 'PASS')
  assert.ok(reviewCrit.evidence.includes('testes reais'))
  assert.equal(r.state, 'SUCCESS', 'sem revisão dedicada — sucesso vem dos testes reais')
})

test('A7 — fluxo agêntico completo (sem revisão) → SUCCESS quando testes passam', () => {
  const r = deriveFinalStatus(baseInput({
    tests: [testRec('FAIL'), testRec('PASS')], // 1ª falhou, edição corrigiu, 2ª passou
    corrections: [{ id: 'c1', state: 'COMPLETED', trigger: 'TEST_FAILURE', attempt: 1 }],
    reviewRequired: false,
  }))
  assert.equal(r.state, 'SUCCESS')
  const correctionsCrit = r.criteria.find((c) => c.id === 'corrections')!
  assert.equal(correctionsCrit.status, 'PASS')
})

test('A8 — fluxo agêntico: 2 edições esgotadas E testes ainda falham → FAILED (honesto)', () => {
  const r = deriveFinalStatus(baseInput({
    tests: [testRec('FAIL'), testRec('FAIL'), testRec('FAIL')],
    corrections: [
      { id: 'c1', state: 'COMPLETED', trigger: 'TEST_FAILURE', attempt: 1 },
      { id: 'c2', state: 'COMPLETED', trigger: 'TEST_FAILURE', attempt: 2 },
    ],
    reviewRequired: false,
  }))
  assert.notEqual(r.state, 'SUCCESS')
  assert.equal(r.state, 'FAILED', 'teto de edições esgotado + testes falhando → FAILED')
})

test('A9 — sequência de decisão simula o loop completo do orquestrador', () => {
  // giro 1: falha → edita → falha distinta → edita → ainda falha → PARA (teto)
  const signatures = ['erro-A', 'erro-B', 'erro-C']
  let attempts = 0
  const fixBudget = agenticFixBudget(3)
  const decisions: boolean[] = []
  for (let i = 0; i < 5; i++) {
    const d = agenticFixDecision({
      fixAttempts: attempts,
      fixBudget,
      sameSignatures: signatures.slice(0, i + 1),
      repoChangedAfterFix: i > 0 ? true : null,
    })
    decisions.push(d.continueFix)
    if (d.continueFix) attempts++
  }
  // [edita, edita, para, para, para] — exatamente 2 tentativas de edição
  assert.deepEqual(decisions, [true, true, false, false, false])
  assert.equal(attempts, 2)
})
