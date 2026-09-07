// ============================================================
// SLIM CONTEXT — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-slim-context.test.ts
// FASE 2/5 da auditoria — corte do desperdício de tokens:
//   S1. objectivePortion extrai o OBJETIVO (para antes dos
//       blocos de contexto/tools)
//   S2. slimContextMessage substitui os blocões de arquivos por
//       OBJETIVO + estado (arquivos tocados, testes)
//   S3. o objetivo NUNCA é perdido no emagrecimento
//   S4. economia REAL: mensagem com 30k chars de contexto vira
//       <10k após o slim (a média medida era 4.271 tokens IN/passo)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  slimContextMessage, objectivePortion, agentProgressFromSteps,
  type AgentStepLike,
} from '../src/lib/studio/context/compaction.ts'

const originalMessage = [
  '## OBJETIVO',
  'TAREFA: implementar o sistema de pontuação',
  '',
  '## CONTEXTO DO PROJETO',
  '### src/game.js',
  '```',
  'function score() { /* 6000 chars */ }',
  '```',
  '## FERRAMENTAS DISPONÍVEIS (use exatamente estes nomes)',
  '{"name":"create_file"}',
].join('\n')

const steps: AgentStepLike[] = [
  { tool: 'read_file', args: { path: 'src/game.js' }, observation: '...', ok: true },
  { tool: 'create_file', args: { path: 'src/score.js' }, observation: 'ARQUIVO_CRIADO', ok: true },
  { tool: 'modify_file', args: { path: 'src/game.js' }, observation: 'ARQUIVO_MODIFICADO', ok: true },
  { tool: 'run_tests', args: {}, observation: 'TESTES_FALHARAM 1 de 3', ok: false },
]

test('S1 — objectivePortion para ANTES dos blocos de contexto', () => {
  const objective = objectivePortion(originalMessage)
  assert.match(objective, /## OBJETIVO/)
  assert.match(objective, /TAREFA: implementar o sistema de pontuação/)
  assert.ok(!objective.includes('## CONTEXTO DO PROJETO'), 'sem bloco de arquivos')
  assert.ok(!objective.includes('## FERRAMENTAS'), 'sem schemas de tools')
})

test('S2 — slimContextMessage: objetivo + arquivos trabalhados + estado', () => {
  const progress = agentProgressFromSteps(steps)
  const slim = slimContextMessage(originalMessage, progress, { keepFileList: true })
  // objetivo preservado
  assert.match(slim, /TAREFA: implementar o sistema de pontuação/)
  // blocões removidos
  assert.ok(!slim.includes('### src/game.js'), 'conteúdo integral do arquivo removido')
  assert.ok(!slim.includes('## FERRAMENTAS DISPONÍVEIS'), 'schemas de tools removidos')
  // estado real presente
  assert.match(slim, /ARQUIVOS RELEVANTES JÁ TRABALHADOS: src\/score\.js, src\/game\.js/)
  assert.match(slim, /COMPACTAÇÃO|CONTEXTO COMPACTADO/)
  assert.match(slim, /última FAIL/, 'estado de testes preservado')
})

test('S3 — objetivo nunca perdido (mensagem sem marcadores de seção)', () => {
  const bare = 'TAREFA: fix the bug in main.js'
  const slim = slimContextMessage(bare, agentProgressFromSteps([]))
  assert.match(slim, /TAREFA: fix the bug in main\.js/)
})

test('S4 — economia real: 30k de contexto → slim bem menor', () => {
  const bigContext = originalMessage.replace('/* 6000 chars */', 'x'.repeat(30_000))
  const progress = agentProgressFromSteps(steps)
  const slim = slimContextMessage(bigContext, progress, { keepFileList: true })
  assert.ok(slim.length < bigContext.length / 10, `slim <10% do original (${slim.length} vs ${bigContext.length})`)
  assert.ok(slim.length < 10_000, 'slim abaixo de 10k chars')
})
