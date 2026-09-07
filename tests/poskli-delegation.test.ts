// ============================================================
// DELEGAÇÃO — TESTES (node:test, PURO)
// Executar: node --test tests/poskli-delegation.test.ts
// Refactor do fluxo do agente (fases visíveis + delegação):
//   D1. orçamentos por subagente (coding 20/30k · testing 5/10k ·
//       review 5/10k — exatamente os valores pedidos)
//   D2. decisão de orçamento de TOKENS: excedeu → "Orçamento
//       atingido, a terminar"
//   D3. decisão de orçamento de TOOL CALLS idem
//   D4. clamp contra o nível do Poskli (o MENOR vence)
//   D5. canDelegate: SÓ o orquestrador delega; subagentes JAMAIS
//       comunicam diretamente entre si (sem loops)
//   D6. mensagens/frases de produto para as fases visíveis
//   D7. prompt do master: delegação obrigatória, nunca implementa
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUBAGENT_BUDGETS, subagentBudgetFor, tokenBudgetDecision, toolBudgetDecision,
  canDelegate, clampSubagentBudgets, delegationMessage, delegationLabel,
} from '../src/lib/studio/poskli/delegation.ts'
import { budgetFor } from '../src/lib/studio/poskli/budget.ts'
import { SYSTEM_PROMPTS } from '../src/lib/studio/agents/prompts.ts'
import { getAgent } from '../src/lib/studio/agents/definitions.ts'

test('D1 — orçamentos EXATOS por subagente (pedido do usuário)', () => {
  assert.deepEqual(
    { toolCalls: SUBAGENT_BUDGETS.coding.maxToolCalls, tokens: SUBAGENT_BUDGETS.coding.maxTokens },
    { toolCalls: 20, tokens: 30_000 },
    'coding: 20 tool calls · 30k tokens'
  )
  assert.deepEqual(
    { toolCalls: SUBAGENT_BUDGETS.testing.maxToolCalls, tokens: SUBAGENT_BUDGETS.testing.maxTokens },
    { toolCalls: 5, tokens: 10_000 },
    'testing: 5 tool calls · 10k tokens'
  )
  assert.deepEqual(
    { toolCalls: SUBAGENT_BUDGETS.review.maxToolCalls, tokens: SUBAGENT_BUDGETS.review.maxTokens },
    { toolCalls: 5, tokens: 10_000 },
    'review: 5 tool calls · 10k tokens'
  )
  // lookup por role (case-insensitive) e desconhecido → null
  assert.equal(subagentBudgetFor('coding')?.label, 'agente de programação')
  assert.equal(subagentBudgetFor('Testing')?.maxToolCalls, 5)
  assert.equal(subagentBudgetFor('master'), null, 'master não é subagente')
  assert.equal(subagentBudgetFor('xpto'), null)
})

test('D2 — orçamento de TOKENS: excedeu → para com mensagem exata', () => {
  // abaixo do teto → continua
  assert.deepEqual(tokenBudgetDecision('coding', 29_999), { exceeded: false })
  // no teto → excedeu
  const over = tokenBudgetDecision('coding', 30_000)
  assert.equal(over.exceeded, true)
  assert.match(over.message ?? '', /Orçamento atingido, a terminar/)
  assert.match(over.message ?? '', /30[\s.]000 tokens/)
  // testing/review com orçamento menor
  assert.equal(tokenBudgetDecision('testing', 10_000).exceeded, true)
  assert.equal(tokenBudgetDecision('review', 9_999).exceeded, false)
  // papel sem orçamento (master/github) → nunca excede por subagente
  assert.deepEqual(tokenBudgetDecision('master', 999_999), { exceeded: false })
})

test('D3 — orçamento de TOOL CALLS idem (coding 20 · testing/review 5)', () => {
  assert.equal(toolBudgetDecision('coding', 19).exceeded, false)
  assert.equal(toolBudgetDecision('coding', 20).exceeded, true)
  assert.match(toolBudgetDecision('coding', 20).message ?? '', /Orçamento atingido/)
  assert.equal(toolBudgetDecision('testing', 5).exceeded, true)
  assert.equal(toolBudgetDecision('review', 4).exceeded, false)
  assert.equal(toolBudgetDecision('review', 5).exceeded, true)
})

test('D4 — clamp do subagente contra o NÍVEL do Poskli (menor vence)', () => {
  // nível 0.1 tem maxToolCalls 12 < 20 do coding → clampa para 12
  const level01 = budgetFor('0.1')
  assert.deepEqual(clampSubagentBudgets(level01, SUBAGENT_BUDGETS.coding), {
    maxToolCalls: 12,
    tokenBudget: 30_000,
  })
  // superagent (40) > coding (20) → mantém 20
  const levelSuper = budgetFor('superagent')
  assert.equal(clampSubagentBudgets(levelSuper, SUBAGENT_BUDGETS.coding).maxToolCalls, 20)
  // tokens do subagente NÃO sofrem clamp de nível (orçamento próprio)
  assert.equal(clampSubagentBudgets(level01, SUBAGENT_BUDGETS.testing).tokenBudget, 10_000)
})

test('D5 — canDelegate: SÓ o orquestrador delega (sem comunicação direta entre subagentes)', () => {
  // master → subagentes: permitido
  assert.equal(canDelegate('master', 'coding'), true)
  assert.equal(canDelegate('master', 'testing'), true)
  assert.equal(canDelegate('master', 'review'), true)
  // subagente → subagente: PROIBIDO (evita loops e gastos)
  assert.equal(canDelegate('coding', 'testing'), false, 'coding não delega a testing')
  assert.equal(canDelegate('coding', 'review'), false)
  assert.equal(canDelegate('testing', 'coding'), false)
  assert.equal(canDelegate('review', 'coding'), false)
  // subagente → master: também não (hierarquia única)
  assert.equal(canDelegate('coding', 'master'), false)
  // papel inválido: nunca
  assert.equal(canDelegate('master', 'xpto'), false)
  assert.equal(canDelegate('', 'coding'), false)
})

test('D6 — frases de produto das fases visíveis (sem nomes técnicos)', () => {
  assert.equal(
    delegationMessage('Criar estrutura', 'coding'),
    'A delegar «Criar estrutura» ao agente de programação…'
  )
  assert.match(delegationMessage('Testar tudo', 'testing'), /agente de testes…$/)
  assert.match(delegationMessage('Rever qualidade', 'review'), /agente de revisão…$/)
  assert.equal(delegationLabel('coding'), 'agente de programação')
  assert.equal(delegationLabel('review'), 'agente de revisão')
  assert.equal(delegationLabel('desconhecido'), 'agente especializado')
  // título longo é cortado (60 chars)
  const long = delegationMessage('x'.repeat(100), 'coding')
  assert.ok(long.length < 100, 'título truncado')
})

test('D7 — master NUNCA implementa: allowedTools SEM escrita/execução', () => {
  const master = getAgent('master')
  assert.ok(master, 'master definido')
  for (const forbidden of ['create_file', 'modify_file', 'delete_file', 'run_command', 'run_tests', 'git_commit']) {
    assert.ok(
      !master!.allowedTools.includes(forbidden),
      `master NÃO pode ter ${forbidden} (delega, não executa)`
    )
  }
  // coding/testing/review: subagentes com tools de execução
  const coding = getAgent('coding')
  assert.ok(coding!.allowedTools.includes('create_file'))
  assert.ok(coding!.allowedTools.includes('modify_file'))
  // prompt do master reforça a delegação
  assert.match(SYSTEM_PROMPTS.master, /NUNCA escreve código/i)
  assert.match(SYSTEM_PROMPTS.master, /DELEGADO aos subagentes/i)
  assert.match(SYSTEM_PROMPTS.master, /Subagentes NÃO se comunicam entre si/i)
  assert.match(SYSTEM_PROMPTS.master, /ERRO e o DIFF/i, 'correções voltam com diff (não código completo)')
})
