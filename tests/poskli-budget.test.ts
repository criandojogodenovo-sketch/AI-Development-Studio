// ============================================================
// BUDGET POR NÍVEL — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-budget.test.ts
// FASE 2/5 da auditoria — limites por versão do Poskli:
//   B1. cada nível (0.1, 0.2, 0.3.1, 1.0-flash, superagent) tem
//       orçamento completo (tool calls, steps, timeout, contexto)
//   B2. nível BARATO (0.1) tem orçamento MENOR que superagent
//   B3. versão inválida/ausente → default 0.2
//   B4. clampSteps/clampToolCalls: menor vence (nunca excede)
//   B5. orçamento nunca mutável pelo caller (cópia defensiva)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUDGETS, budgetFor, budgetLevelOf, clampSteps, clampToolCalls,
  type BudgetLevel,
} from '../src/lib/studio/poskli/budget.ts'

const LEVELS: BudgetLevel[] = ['0.1', '0.2', '0.3.1', '1.0-flash', 'superagent']

test('B1 — todos os níveis têm orçamento completo e positivo', () => {
  for (const level of LEVELS) {
    const b = BUDGETS[level]
    assert.ok(b.maxToolCalls >= 10, `${level}: tool calls >= 10`)
    assert.ok(b.maxSteps >= 8, `${level}: steps >= 8`)
    assert.ok(b.agentTimeoutMs >= 120_000, `${level}: timeout >= 120s`)
    assert.ok(b.contextFileChars >= 8_000, `${level}: contexto >= 8k chars`)
  }
})

test('B2 — 0.1 é mais apertado que 0.2, que é mais apertado que superagent', () => {
  const cheap = BUDGETS['0.1']
  const def = BUDGETS['0.2']
  const max = BUDGETS.superagent
  assert.ok(cheap.maxToolCalls < def.maxToolCalls, '0.1 < 0.2 em tool calls')
  assert.ok(cheap.maxSteps < def.maxSteps, '0.1 < 0.2 em steps')
  assert.ok(def.maxToolCalls < max.maxToolCalls, '0.2 < superagent em tool calls')
  assert.ok(cheap.contextFileChars < max.contextFileChars, '0.1 < superagent em contexto')
})

test('B3 — versão inválida/ausente → default 0.2', () => {
  assert.equal(budgetLevelOf(undefined), '0.2')
  assert.equal(budgetLevelOf(''), '0.2')
  assert.equal(budgetLevelOf('9.9'), '0.2')
  assert.equal(budgetLevelOf('superagent'), 'superagent')
  assert.equal(budgetLevelOf('0.3.1'), '0.3.1')
  // com espaços (entrada do seletor da UI)
  assert.equal(budgetLevelOf(' 1.0-flash '), '1.0-flash')
})

test('B4 — clamps: o MENOR limite vence (agente vs nível)', () => {
  const budget = budgetFor('0.1') // maxSteps 10, maxToolCalls 12
  assert.equal(clampSteps(22, budget), 10, 'agente 22 + nível 10 → 10')
  assert.equal(clampSteps(8, budget), 8, 'agente 8 + nível 10 → 8')
  assert.equal(clampToolCalls(40, budget), 12, 'pedido 40 + nível 12 → 12')
  assert.equal(clampToolCalls(5, budget), 5, 'pedido 5 + nível 12 → 5')
  // nunca 0/negativo
  assert.ok(clampSteps(1, budget) >= 1)
})

test('B5 — budgetFor devolve cópia defensiva (mutar não afeta o registro)', () => {
  const b = budgetFor('0.2')
  b.maxToolCalls = 999
  assert.equal(BUDGETS['0.2'].maxToolCalls, 24, 'registro original intacto')
})
