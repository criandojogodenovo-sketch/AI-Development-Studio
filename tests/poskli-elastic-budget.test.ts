// ============================================================
// ORÇAMENTO ELÁSTICO — TESTES (node:test, PURO)
// Executar: node --test tests/poskli-elastic-budget.test.ts
// Delegação com orçamento que escala com a dificuldade (TOON):
//   B1. getBudgetForTask: 150k/200k/250k/300k no coding
//   B2. subagentBudgetFor COM dificuldade → elástico
//   B3. subagentBudgetFor SEM dificuldade → fixo (compat 30k/10k/10k)
//   B4. clamp: o menor vence (nível × subagente)
//   B5. mensagens de delegação/orçamento honestas
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getBudgetForTask,
  subagentBudgetFor,
  clampSubagentBudgets,
  tokenBudgetDecision,
  toolBudgetDecision,
  canDelegate,
  ELASTIC_BUDGETS,
  type SubagentBudget,
} from '../src/lib/studio/poskli/delegation.ts'

test('B1 — getBudgetForTask devolve os tetos elásticos por dificuldade', () => {
  assert.deepEqual(getBudgetForTask('simple'), { coding: 150_000, testing: 20_000, review: 15_000, master: 30_000 })
  assert.deepEqual(getBudgetForTask('medium'), { coding: 200_000, testing: 25_000, review: 18_000, master: 35_000 })
  assert.deepEqual(getBudgetForTask('hard'), { coding: 250_000, testing: 30_000, review: 20_000, master: 40_000 })
  assert.deepEqual(getBudgetForTask('complex'), { coding: 300_000, testing: 35_000, review: 25_000, master: 45_000 })
})

test('B1b — monotonicidade: dificuldade maior NUNCA reduz o orçamento', () => {
  const levels = ['simple', 'medium', 'hard', 'complex'] as const
  for (let i = 1; i < levels.length; i++) {
    const prev = getBudgetForTask(levels[i - 1])
    const curr = getBudgetForTask(levels[i])
    assert.ok(curr.coding >= prev.coding, `coding ${levels[i]} < ${levels[i - 1]}`)
    assert.ok(curr.testing >= prev.testing, `testing ${levels[i]} < ${levels[i - 1]}`)
    assert.ok(curr.review >= prev.review, `review ${levels[i]} < ${levels[i - 1]}`)
    assert.ok(curr.master >= prev.master, `master ${levels[i]} < ${levels[i - 1]}`)
  }
})

test('B2 — subagentBudgetFor COM dificuldade → orçamento elástico', () => {
  // causa raiz do MAX_LIMITS_REACHED: coding simples tinha 30k fixo
  const simple = subagentBudgetFor('coding', 'simple')
  assert.equal(simple?.maxTokens, 150_000, 'coding simple deve ter 150k (era 30k fixo)')
  const complex = subagentBudgetFor('coding', 'complex')
  assert.equal(complex?.maxTokens, 300_000)
  assert.equal(complex?.maxToolCalls, 30)
  const testingSimple = subagentBudgetFor('testing', 'simple')
  assert.equal(testingSimple?.maxTokens, 20_000)
  const reviewComplex = subagentBudgetFor('review', 'complex')
  assert.equal(reviewComplex?.maxTokens, 25_000)
  // label de produto preservado
  assert.equal(complex?.label, 'agente de programação')
})

test('B3 — subagentBudgetFor SEM dificuldade → fixo (retrocompatibilidade)', () => {
  assert.equal(subagentBudgetFor('coding')?.maxTokens, 30_000)
  assert.equal(subagentBudgetFor('testing')?.maxTokens, 10_000)
  assert.equal(subagentBudgetFor('review')?.maxTokens, 10_000)
  assert.equal(subagentBudgetFor('master'), null)
  assert.equal(subagentBudgetFor(''), null)
  // dificuldade inválida → também fixo (defensivo)
  assert.equal(subagentBudgetFor('coding', 'extreme' as never)?.maxTokens, 30_000)
})

test('B4 — clampSubagentBudgets: o MENOR vence (nível × subagente)', () => {
  const sub: SubagentBudget = {
    role: 'coding',
    label: 'agente de programação',
    maxToolCalls: 30,
    maxTokens: 300_000,
  }
  // nível 0.1 tem 12 tool calls → clamp para 12
  const clamped = clampSubagentBudgets({ maxToolCalls: 12 }, sub)
  assert.equal(clamped.maxToolCalls, 12)
  assert.equal(clamped.tokenBudget, 300_000)
  // nível superagent tem 40 → clamp mantém 30 do subagente
  const clamped2 = clampSubagentBudgets({ maxToolCalls: 40 }, sub)
  assert.equal(clamped2.maxToolCalls, 30)
})

test('B5 — decisões de orçamento continuam honestas (com teto explícito)', () => {
  // SEM dificuldade (fixo 30k): 300k excede
  const exceeded = tokenBudgetDecision('coding', 300_000)
  assert.equal(exceeded.exceeded, true)
  assert.match(exceeded.message ?? '', /Orçamento atingido, a terminar/)
  // pt-PT: separador de milhares é espaço (U+00A0) — aceitar ambos
  assert.match(exceeded.message ?? '', /300[ .\u00a0]?000/)
  assert.match(exceeded.message ?? '', /teto/)
  // COM dificuldade (elástico): 149.999k cabe em simple (150k)…
  assert.equal(tokenBudgetDecision('coding', 149_999, 'simple').exceeded, false)
  // …150.001 já excede; e complex aguenta 299.999k mas 300k ATINGE o teto
  assert.equal(tokenBudgetDecision('coding', 150_001, 'simple').exceeded, true)
  assert.equal(tokenBudgetDecision('coding', 299_999, 'complex').exceeded, false)
  assert.equal(tokenBudgetDecision('coding', 300_000, 'complex').exceeded, true)
  // tool calls (elástico: complex tem 30)
  assert.equal(toolBudgetDecision('coding', 30, 'complex').exceeded, true)
  assert.equal(toolBudgetDecision('coding', 29, 'complex').exceeded, false)
})

test('B6 — canDelegate: só o master delega; subagentes nunca falam entre si', () => {
  assert.equal(canDelegate('master', 'coding'), true)
  assert.equal(canDelegate('master', 'testing'), true)
  assert.equal(canDelegate('master', 'review'), true)
  assert.equal(canDelegate('coding', 'testing'), false)
  assert.equal(canDelegate('testing', 'coding'), false)
  assert.equal(canDelegate('review', 'coding'), false)
  assert.equal(canDelegate('master', 'master'), false)
})

test('B7 — ELASTIC_BUDGETS declarado cobre as 4 dificuldades', () => {
  assert.deepEqual(Object.keys(ELASTIC_BUDGETS).sort(), ['complex', 'hard', 'medium', 'simple'])
})
