// ============================================================
// POSKLI 0.2 — TESTES OBRIGATÓRIOS DA MÁQUINA DE ESTADOS (spec §33)
// Executar: npm test
// Puro (node:test + type stripping) — valida deriveFinalStatus,
// a FONTE ÚNICA DA VERDADE do resultado global.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveFinalStatus,
  deriveCounters,
  buildVerificationChecks,
  deriveResultMarkdown,
  displayFromGlobal,
  phaseLabel,
  isTerminalState,
  type DeriveFinalStatusInput,
  type TaskSnapshot,
  type TestRecordSnapshot,
  type CorrectionSnapshot,
  type ReviewSnapshot,
  type VerificationResult,
} from '../src/lib/studio/poskli/state-machine.ts'
import { classifyError, rateLimitRecord } from '../src/lib/studio/poskli/errors.ts'

// ---------- FÁBRICAS (cenários determinísticos) ----------

function task(id: string, status: TaskSnapshot['status'], extra: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return { id, title: `Tarefa ${id}`, status, required: true, ...extra }
}

function testRec(id: string, status: 'PASS' | 'FAIL', extra: Partial<TestRecordSnapshot> = {}): TestRecordSnapshot {
  return { id, status, command: 'npm test', trigger: 'INITIAL', exitCode: status === 'PASS' ? 0 : 1, ...extra }
}

function correction(id: string, state: CorrectionSnapshot['state'], extra: Partial<CorrectionSnapshot> = {}): CorrectionSnapshot {
  return { id, state, trigger: 'TEST_FAILURE', attempt: 1, ...extra }
}

function baseInput(overrides: Partial<DeriveFinalStatusInput> = {}): DeriveFinalStatusInput {
  return {
    cancelled: false,
    interrupted: false,
    tasks: [task('t1', 'COMPLETED'), task('t2', 'COMPLETED')],
    tests: [testRec('x1', 'PASS')],
    review: { status: 'PASS', attempts: 1 },
    corrections: [],
    verification: { ran: true, checks: buildVerificationChecks({ previewRequired: false, previewOk: null, buildRequired: false, buildOk: null, artifactsProduced: true }) },
    ...overrides,
  }
}

/** Cenário "tudo certo" — usado como base para os testes de falha. */
function allGood(): DeriveFinalStatusInput {
  return baseInput()
}

// ============================================================
// 1–4: TAREFAS
// ============================================================

test('1. 0/N tarefas concluídas → nunca CONCLUÍDO', () => {
  const r = deriveFinalStatus(baseInput({ tasks: [task('t1', 'PENDING'), task('t2', 'PENDING')] }))
  assert.notEqual(r.state, 'SUCCESS')
  assert.equal(r.state, 'BLOCKED', 'sem nada concluído e sem falha → BLOCKED')
  assert.ok(r.criteria.find((c) => c.id === 'tasks')!.status === 'BLOCKED')
})

test('2. 1/N tarefas concluídas (N obrigatórias) → nunca CONCLUÍDO', () => {
  const r = deriveFinalStatus(baseInput({ tasks: [task('t1', 'COMPLETED'), task('t2', 'PENDING')] }))
  assert.notEqual(r.state, 'SUCCESS')
  assert.equal(r.state, 'PARTIAL', '1 de 2 concluída → PARTIAL')
})

test('3. tarefa obrigatória FAILED → resultado FAILED', () => {
  const r = deriveFinalStatus(baseInput({ tasks: [task('t1', 'COMPLETED'), task('t2', 'FAILED')] }))
  assert.equal(r.state, 'FAILED')
  assert.equal(r.reason, 'CRITÉRIO_TASKS_FALHOU')
})

test('4. tarefa obrigatória BLOCKED → PARTIAL (algo concluído) ou BLOCKED (nada)', () => {
  const partial = deriveFinalStatus(baseInput({ tasks: [task('t1', 'COMPLETED'), task('t2', 'BLOCKED')] }))
  assert.equal(partial.state, 'PARTIAL', 'com 1 concluída → PARTIAL')
  const blocked = deriveFinalStatus(baseInput({ tasks: [task('t1', 'BLOCKED'), task('t2', 'BLOCKED')] }))
  assert.equal(blocked.state, 'BLOCKED', 'nada concluído → BLOCKED')
  assert.notEqual(partial.state, 'SUCCESS')
  assert.notEqual(blocked.state, 'SUCCESS')
})

// ============================================================
// 5–6: TESTES × IMPLEMENTAÇÃO (não mascaram falhas)
// ============================================================

test('5. implementação FAILED + npm test SUCCESS → NÃO CONCLUÍDO (FAILED)', () => {
  // O CASO INVÁLIDO da spec §10: 0/2 implementadas, testes passam
  const r = deriveFinalStatus(baseInput({
    tasks: [task('t1', 'FAILED'), task('t2', 'BLOCKED')],
    tests: [testRec('x1', 'PASS')],
  }))
  assert.equal(r.state, 'FAILED', 'tarefa obrigatória FAILED domina o npm test SUCCESS')
  assert.equal(r.criteria.find((c) => c.id === 'tests')!.status, 'PASS')
  assert.equal(r.criteria.find((c) => c.id === 'tasks')!.status, 'FAIL')
})

test('6. implementação SUCCESS + testes FAILED → NÃO CONCLUÍDO', () => {
  const r = deriveFinalStatus(baseInput({ tests: [testRec('x1', 'FAIL')] }))
  assert.equal(r.state, 'FAILED')
  assert.equal(r.criteria.find((c) => c.id === 'tests')!.status, 'FAIL')
})

// ============================================================
// 7–8: RATE LIMIT DURANTE REVISÃO
// ============================================================

test('7. BAI_RATE_LIMIT durante revisão → estado coerente (nunca CONCLUÍDO sem revisão)', () => {
  const r = deriveFinalStatus(baseInput({
    review: { status: 'BLOCKED', blockedReason: 'PROVIDER_RATE_LIMIT', attempts: 1 },
  }))
  const reviewCrit = r.criteria.find((c) => c.id === 'review')!
  assert.equal(reviewCrit.status, 'BLOCKED')
  assert.ok(reviewCrit.evidence.includes('PROVIDER_RATE_LIMIT'))
  assert.equal(reviewCrit.evidence.includes('failover'), true, 'política registrada na evidência')
  assert.equal(r.state, 'PARTIAL', 'tarefas OK + revisão bloqueada → PARTIAL (coerente e conservador)')
  assert.notEqual(r.state, 'SUCCESS')
})

test('8. rate limit sem failover → revisão NUNCA é declarada concluída', () => {
  const r = deriveFinalStatus(baseInput({
    review: { status: 'BLOCKED', blockedReason: 'PROVIDER_RATE_LIMIT', attempts: 1 },
    tests: [testRec('x1', 'PASS'), testRec('x2', 'PASS')],
    verification: { ran: true, checks: buildVerificationChecks({ previewRequired: true, previewOk: true, buildRequired: false, buildOk: null, artifactsProduced: true }) },
  }))
  const reviewCrit = r.criteria.find((c) => c.id === 'review')!
  assert.notEqual(reviewCrit.status, 'PASS')
  assert.notEqual(r.state, 'SUCCESS')
  // e o rate limit jamais vira sucesso (spec §13)
  const rl = rateLimitRecord('REVIEWING', 1, 'key#1', false, 'bloqueada')
  assert.equal(rl.retried, false)
  assert.equal(rl.errorType, 'PROVIDER_RATE_LIMIT')
  assert.equal(rl.keyLabel, 'key#1', 'sem expor segredo')
})

// ============================================================
// 9–10: CORREÇÕES
// ============================================================

test('9. correção 0/N → não declarar correção concluída', () => {
  const r = deriveFinalStatus(baseInput({
    tests: [testRec('x1', 'FAIL')],
    corrections: [correction('c1', 'FAILED'), correction('c2', 'FAILED'), correction('c3', 'BLOCKED')],
  }))
  const corrCrit = r.criteria.find((c) => c.id === 'corrections')!
  assert.equal(corrCrit.status, 'FAIL')
  assert.ok(corrCrit.evidence.startsWith('0/3'), `evidência mostra 0/3 — recebido: "${corrCrit.evidence}"`)
  assert.equal(r.state, 'FAILED')
})

test('10. correção parcial (aplicada mas problemas persistem) → FAILED conforme política', () => {
  const r = deriveFinalStatus(baseInput({
    tests: [testRec('x1', 'FAIL'), testRec('x2', 'FAIL')],
    corrections: [correction('c1', 'COMPLETED'), correction('c2', 'FAILED'), correction('c3', 'FAILED')],
  }))
  const corrCrit = r.criteria.find((c) => c.id === 'corrections')!
  assert.equal(corrCrit.status, 'FAIL')
  assert.ok(corrCrit.evidence.startsWith('1/3'))
  assert.equal(r.state, 'FAILED')
})

// ============================================================
// 11: CASO BEM-SUCEDIDO
// ============================================================

test('11. N/N tarefas + validações obrigatórias OK → CONCLUÍDO (SUCCESS)', () => {
  const r = deriveFinalStatus(allGood())
  assert.equal(r.state, 'SUCCESS')
  assert.ok(r.criteria.every((c) => c.status === 'PASS'))
  assert.equal(r.reason, 'CRITÉRIOS_SATISFEITOS')
  assert.equal(r.conservative, true)
})

// ============================================================
// 12: INTERRUPÇÃO
// ============================================================

test('12. execução interrompida → nunca CONCLUÍDO (estado recuperável)', () => {
  const r = deriveFinalStatus(baseInput({ interrupted: true, verification: null }))
  assert.notEqual(r.state, 'SUCCESS')
  assert.equal(r.criteria.find((c) => c.id === 'lifecycle')!.status, 'BLOCKED')
  assert.equal(r.state, 'PARTIAL', 'com trabalho concluído → PARTIAL (recuperável, honesto)')
})

// ============================================================
// 13–14: RETRIES SEM DUPLICAÇÃO
// ============================================================

test('13. retry → não duplicar tarefas (tarefa com 2 tentativas conta 1 vez)', () => {
  const r = deriveFinalStatus(baseInput({
    tasks: [task('t1', 'COMPLETED', { attempts: 2 }), task('t2', 'COMPLETED', { attempts: 1 })],
  }))
  assert.equal(r.state, 'SUCCESS')
  assert.equal(r.counters.tasks.total, 2, 'identidade única por tarefa')
  assert.equal(r.counters.tasks.completed, 2)
  const tasksCrit = r.criteria.find((c) => c.id === 'tasks')!
  assert.equal(tasksCrit.evidence, '2/2 tarefas concluídas')
})

test('14. retry → não duplicar execuções (3 execuções de teste, última PASS)', () => {
  const r = deriveFinalStatus(baseInput({
    tests: [testRec('x1', 'FAIL'), testRec('x2', 'FAIL'), testRec('x3', 'PASS', { trigger: 'AFTER_CORRECTION' })],
    corrections: [correction('c1', 'COMPLETED')],
  }))
  assert.equal(r.state, 'SUCCESS', 'convergiu: última execução PASS + correção aplicada')
  assert.equal(r.counters.tests.runs, 3, 'cada execução tem identidade própria')
  assert.equal(r.counters.tests.passed, 1)
  assert.equal(r.counters.tests.failed, 2)
  assert.equal(r.counters.tests.lastStatus, 'PASS')
})

// ============================================================
// 15–17: DETERMINISMO / REFRESH / POLLING
// ============================================================

test('15. execução duplicada → estados consistentes (derivação é função pura)', () => {
  const input = baseInput({
    tasks: [task('t1', 'COMPLETED'), task('t2', 'FAILED')],
    tests: [testRec('x1', 'FAIL')],
  })
  const r1 = deriveFinalStatus(input)
  const r2 = deriveFinalStatus(structuredClone(input))
  // derivedAt (carimbo de tempo) é excluído: conteúdo lógico deve ser idêntico
  const { derivedAt: _d1, ...c1 } = r1
  const { derivedAt: _d2, ...c2 } = r2
  assert.deepEqual(c1, c2, 'mesma entrada → mesma saída (sem estados conflitantes)')
})

test('16. refresh da UI → derivação idempotente (não duplica eventos/estados)', () => {
  const input = baseInput({ tests: [testRec('x1', 'PASS')] })
  const r1 = deriveFinalStatus(input)
  const r2 = deriveFinalStatus(input)
  const { derivedAt: _d1, ...c1 } = r1
  const { derivedAt: _d2, ...c2 } = r2
  assert.deepEqual(c1, c2)
  // critérios têm identidade estável (nenhum novo critério por re-render)
  assert.equal(r1.criteria.length, 6)
  assert.deepEqual(r1.criteria.map((c) => c.id), r2.criteria.map((c) => c.id))
})

test('17. polling → serialização estável (JSON round-trip não muda o resultado)', () => {
  const input = baseInput({ review: { status: 'CHANGES_REQUESTED', attempts: 1 } })
  const r1 = deriveFinalStatus(input)
  const restored = JSON.parse(JSON.stringify(r1))
  const r2 = deriveFinalStatus(input)
  // carimbo derivedAt excluído (tempo, não lógica)
  delete (restored as Record<string, unknown>).derivedAt
  const r2clone = JSON.parse(JSON.stringify(r2))
  delete (r2clone as Record<string, unknown>).derivedAt
  assert.equal(JSON.stringify(restored), JSON.stringify(r2clone))
  assert.equal(r1.state, r2.state)
})

// ============================================================
// 18–20: CONSISTÊNCIA BACKEND ↔ FRONTEND
// ============================================================

test('18. backend FAILED → frontend FAILED (mapeamento de exibição)', () => {
  assert.equal(displayFromGlobal('FAILED'), 'FAILED')
  assert.equal(phaseLabel('FAILED'), 'Falhou')
  assert.ok(isTerminalState('FAILED'))
})

test('19. backend SUCCESS → frontend Concluído (COMPLETED)', () => {
  assert.equal(displayFromGlobal('SUCCESS'), 'COMPLETED')
  assert.equal(phaseLabel('COMPLETED'), 'Concluído')
  assert.ok(isTerminalState('COMPLETED'))
})

test('20. resultado persistido = resultado exibido (estado é agregado exato dos critérios)', () => {
  const cases: Array<[DeriveFinalStatusInput, string]> = [
    [baseInput({ tasks: [task('t1', 'FAILED')] }), 'FAILED'],
    [baseInput({ review: { status: 'NOT_RUN', attempts: 0 }, verification: null }), 'PARTIAL'],
    [baseInput(), 'SUCCESS'],
    [baseInput({ cancelled: true }), 'CANCELLED'],
  ]
  for (const [input, expected] of cases) {
    const r = deriveFinalStatus(input)
    // re-agregando os critérios persistidos → MESMO estado (fonte única)
    const anyFail = r.criteria.some((c) => c.status === 'FAIL')
    const allPass = r.criteria.every((c) => c.status === 'PASS')
    const rederived = r.state === 'CANCELLED' ? 'CANCELLED'
      : anyFail ? 'FAILED'
        : allPass ? 'SUCCESS'
          : r.counters.tasks.completed > 0 ? 'PARTIAL' : 'BLOCKED'
    assert.equal(rederived, r.state, `estado exibido deve ser o agregado dos critérios (${expected})`)
    assert.equal(displayFromGlobal(r.state), expected === 'SUCCESS' ? 'COMPLETED' : expected)
  }
})

// ============================================================
// 21–22: PREVIEW / BUILD
// ============================================================

test('21. preview falhou → NÃO CONCLUÍDO', () => {
  const r = deriveFinalStatus(baseInput({
    verification: { ran: true, checks: buildVerificationChecks({ previewRequired: true, previewOk: false, buildRequired: false, buildOk: null, artifactsProduced: true }) },
  }))
  assert.equal(r.state, 'FAILED')
  assert.equal(r.criteria.find((c) => c.id === 'verification')!.status, 'FAIL')
})

test('22. build falhou (quando build é requisito) → NÃO CONCLUÍDO', () => {
  const r = deriveFinalStatus(baseInput({
    verification: { ran: true, checks: buildVerificationChecks({ previewRequired: false, previewOk: null, buildRequired: true, buildOk: false, artifactsProduced: true }) },
  }))
  assert.equal(r.state, 'FAILED')
  const buildCheck = r.criteria.find((c) => c.id === 'verification')!
  assert.ok(buildCheck.evidence.includes('Build'))
})

// ============================================================
// 23–24: REVISÃO/CORREÇÃO OBRIGATÓRIAS NÃO EXECUTADAS
// ============================================================

test('23. revisão obrigatória não executada → NÃO CONCLUÍDO', () => {
  const r = deriveFinalStatus(baseInput({
    review: { status: 'NOT_RUN', attempts: 0 },
    verification: { ran: true, checks: buildVerificationChecks({ previewRequired: false, previewOk: null, buildRequired: false, buildOk: null, artifactsProduced: true }) },
  }))
  const reviewCrit = r.criteria.find((c) => c.id === 'review')!
  assert.equal(reviewCrit.status, 'BLOCKED')
  assert.notEqual(r.state, 'SUCCESS')
  assert.equal(r.state, 'PARTIAL', 'implementação ok, revisão ausente → PARTIAL (nunca CONCLUÍDO)')
})

test('24. correção necessária não executada → NÃO CONCLUÍDO', () => {
  const r = deriveFinalStatus(baseInput({
    tests: [testRec('x1', 'FAIL')],
    corrections: [], // problema detectado, zero correções
  }))
  const corrCrit = r.criteria.find((c) => c.id === 'corrections')!
  assert.equal(corrCrit.status, 'FAIL')
  assert.ok(corrCrit.evidence.startsWith('0/'))
  assert.equal(r.state, 'FAILED')
})

// ============================================================
// EXTRAS — CONTADORES, CANCELAMENTO, VAZIO, MARKDOWN
// ============================================================

test('EXTRA-1. cancelado → CANCELLED (precedência sobre tudo)', () => {
  const r = deriveFinalStatus(baseInput({ cancelled: true, tasks: [task('t1', 'FAILED')], tests: [testRec('x1', 'FAIL')] }))
  assert.equal(r.state, 'CANCELLED')
})

test('EXTRA-2. contadores derivados dos dados reais (2 tarefas: 1 ok, 1 falhou → 1/2, não 2/2)', () => {
  const input = baseInput({ tasks: [task('t1', 'COMPLETED'), task('t2', 'FAILED')], tests: [testRec('x1', 'FAIL'), testRec('x2', 'FAIL')] })
  const counters = deriveCounters(input)
  assert.equal(counters.tasks.total, 2)
  assert.equal(counters.tasks.completed, 1)
  assert.equal(counters.tasks.failed, 1)
  assert.equal(counters.tests.runs, 2)
  assert.equal(counters.tests.failed, 2)
  assert.equal(counters.corrections.necessary, true)
})

test('EXTRA-3. nenhuma tarefa planejada → BLOCKED (nunca CONCLUÍDO)', () => {
  const r = deriveFinalStatus(baseInput({ tasks: [] }))
  assert.equal(r.state, 'BLOCKED')
})

test('EXTRA-4. sem testes no escopo (testsRequired=false) → não bloqueia', () => {
  const r = deriveFinalStatus(baseInput({ tests: [], testsRequired: false }))
  assert.equal(r.state, 'SUCCESS')
  assert.equal(r.criteria.find((c) => c.id === 'tests')!.status, 'PASS')
})

test('EXTRA-5. testes necessários não executados (BLOCKED) → nunca CONCLUÍDO', () => {
  const r = deriveFinalStatus(baseInput({ tests: [], testsRequired: true }))
  assert.equal(r.criteria.find((c) => c.id === 'tests')!.status, 'BLOCKED')
  assert.equal(r.state, 'PARTIAL', 'com implementação concluída → PARTIAL; nunca SUCCESS')
})

test('EXTRA-6. artefatos não produzidos → verificação FAIL → nunca CONCLUÍDO', () => {
  const r = deriveFinalStatus(baseInput({
    verification: { ran: true, checks: buildVerificationChecks({ previewRequired: false, previewOk: null, buildRequired: false, buildOk: null, artifactsProduced: false }) },
  }))
  assert.equal(r.state, 'FAILED')
})

test('EXTRA-7. markdown do resultado reflete a MESMA derivação (backend=UI)', () => {
  const r = deriveFinalStatus(baseInput({ tasks: [task('t1', 'FAILED'), task('t2', 'COMPLETED')], tests: [testRec('x1', 'FAIL')] }))
  const md = deriveResultMarkdown(r, { request: 'Cria uma landing page', tokens: 1234, iterations: '1/3' })
  assert.ok(md.includes('## Resultado do Poskli'))
  assert.ok(md.includes('**Estado:** Falhou'))
  assert.ok(md.includes('1/2 concluídas'))
  assert.ok(md.includes('### Critérios de conclusão'))
  // o estado no markdown vem da derivação — nunca de boolean isolado
  assert.ok(md.includes('Falhou —'))
})

test('EXTRA-8. verificação não executada → BLOCKED (nunca CONCLUÍDO)', () => {
  const r = deriveFinalStatus(baseInput({ verification: null }))
  assert.equal(r.criteria.find((c) => c.id === 'verification')!.status, 'BLOCKED')
  assert.equal(r.state, 'PARTIAL')
})

// ============================================================
// CLASSIFICAÇÃO DE ERROS (spec §13/§31)
// ============================================================

test('ERRO-1. BAI_RATE_LIMIT → PROVIDER_RATE_LIMIT (não-retryável por política)', () => {
  const c = classifyError(new Error('BAI_RATE_LIMIT: limite do provedor atingido (key#1); failover intencionalmente NÃO aplicado'))
  assert.equal(c.code, 'PROVIDER_RATE_LIMIT')
  assert.equal(c.retryable, false)
  assert.ok(!c.friendly.includes('key#'), 'mensagem amigável sem internals')
})

test('ERRO-2. HTTP 429 / too many requests → PROVIDER_RATE_LIMIT', () => {
  assert.equal(classifyError(new Error('BAI_HTTP_429: too many requests')).code, 'PROVIDER_RATE_LIMIT')
})

test('ERRO-3. BAI_TIMEOUT → PROVIDER_TIMEOUT (retryável)', () => {
  const c = classifyError(new Error('BAI_TIMEOUT'))
  assert.equal(c.code, 'PROVIDER_TIMEOUT')
  assert.equal(c.retryable, true)
})

test('ERRO-4. orçamento esgotado → BUDGET_TIMEOUT', () => {
  const c = classifyError(new Error('TIMEOUT: orçamento de 270s esgotado na implementação'))
  assert.equal(c.code, 'BUDGET_TIMEOUT')
  assert.equal(c.retryable, false)
})

test('ERRO-5. provider 5xx / rede → PROVIDER_ERROR (retryável)', () => {
  assert.equal(classifyError(new Error('BAI_HTTP_503: upstream unavailable')).code, 'PROVIDER_ERROR')
  assert.equal(classifyError(new Error('BAI_FALHA: key#1 UNKNOWN fetch failed')).code, 'PROVIDER_ERROR')
})

test('ERRO-6. workspace ENOENT → WORKSPACE_FAILURE', () => {
  assert.equal(classifyError(new Error('ENOENT: no such file or directory, mkdir workspaces')).code, 'WORKSPACE_FAILURE')
})

test('ERRO-7. segredos são mascarados no detalhe técnico', () => {
  const c = classifyError(new Error('falha com sk-abcdefgh12345678 e ghp_Tok1234567890abcdefghijk'))
  assert.ok(!c.detail.includes('sk-abcdefgh12345678'))
  assert.ok(!c.detail.includes('ghp_Tok1234567890'))
  assert.ok(c.detail.includes('[REDACTED]'))
})

test('ERRO-8. desconhecido → UNKNOWN_FAILURE (nunca vira sucesso)', () => {
  const c = classifyError(new Error('qualquer coisa estranha'))
  assert.equal(c.code, 'UNKNOWN_FAILURE')
  assert.equal(c.retryable, true)
})

// ============================================================
// LIMITE INVIOLÁVEL (spec §10 — o caso que JAMAIS pode ocorrer)
// ============================================================

test('CASO-INVÁLIDO-§10. 0/2 concluídas + impl FAILED + testes SUCCESS + correção 0/3 → JAMAIS CONCLUÍDO', () => {
  // Reprodução EXATA do estado inválido da spec:
  //   Tarefas: 0/2 · Implementação: FAILED · Testes: BLOCKED
  //   npm test: SUCCESS · Correção: 0/3 · (0.1 dizia: CONCLUÍDO)
  const r = deriveFinalStatus({
    cancelled: false,
    interrupted: false,
    tasks: [task('impl', 'FAILED'), task('tests-task', 'BLOCKED')],
    tests: [testRec('x1', 'PASS', { command: 'npm test' })],
    review: { status: 'NOT_RUN', attempts: 0 },
    corrections: [correction('c1', 'FAILED'), correction('c2', 'FAILED'), correction('c3', 'BLOCKED')],
    verification: { ran: true, checks: buildVerificationChecks({ previewRequired: true, previewOk: true, buildRequired: false, buildOk: null, artifactsProduced: true }) },
    testsRequired: true,
    reviewRequired: true,
  })
  assert.equal(r.state, 'FAILED', 'o estado inválido da spec §10 agora é FAILED')
  assert.notEqual(r.state, 'SUCCESS')
  assert.notEqual(r.state, 'COMPLETED')
})
