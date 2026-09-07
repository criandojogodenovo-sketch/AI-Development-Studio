// ============================================================
// COMPACTION — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-compaction.test.ts
// Compactação automática de contexto a 75% da janela:
//   C1. estimateTokens/conversationTokens determinísticos
//   C2. shouldAutoCompact dispara em 75% e NÃO abaixo
//   C3. agentProgressFromSteps extrai estado REAL (arquivos,
//       testes, última tool) — sem inventar
//   C4. compactConversation preserva system + objetivo + ESTADO
//       + últimos turnos (e remove o miolo antigo)
//   C5. estado preservado inclui "NÃO refazer" (anti-repetição
//       do bug do Codex: planos concluídos virando pendentes)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateTokens,
  conversationTokens,
  shouldAutoCompact,
  agentProgressFromSteps,
  compactConversation,
  type CompactionMessage,
} from '../src/lib/studio/context/compaction.ts'

const msg = (role: 'system' | 'user' | 'assistant', content: string): CompactionMessage => ({ role, content })

test('C1 — estimativas de token são determinísticas (~4 chars/token)', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(conversationTokens([]), 0)
  assert.equal(conversationTokens([{ role: 'system', content: 'a'.repeat(400) }]), 100)
})

test('C2 — shouldAutoCompact dispara em 75% da janela (não antes)', () => {
  const window = 10_000
  // 4 chars = 1 token
  const small: CompactionMessage[] = [msg('user', 'a'.repeat(10_000))] // 2.5k tokens = 25%
  assert.ok(!shouldAutoCompact(small, window, 0.75), '25% não compacta')
  const half: CompactionMessage[] = [msg('user', 'a'.repeat(20_000))] // 5k tokens = 50%
  assert.ok(!shouldAutoCompact(half, window, 0.75), '50% não compacta')
  const at75: CompactionMessage[] = [msg('user', 'a'.repeat(30_000))] // 7.5k tokens = 75%
  assert.ok(shouldAutoCompact(at75, window, 0.75), '75% compacta')
  const over: CompactionMessage[] = [msg('user', 'a'.repeat(40_000))] // 10k tokens = 100%
  assert.ok(shouldAutoCompact(over, window, 0.75), '100% compacta')
  assert.ok(!shouldAutoCompact([], window), 'vazio nunca compacta')
  assert.ok(!shouldAutoCompact(over, 0), 'janela 0 → nunca')
})

test('C3 — agentProgressFromSteps extrai estado real dos passos', () => {
  const steps = [
    { tool: 'list_files', ok: true, observation: '3 arquivos' },
    { tool: 'create_file', args: { path: 'src/main.js' }, ok: true, observation: 'ok' },
    { tool: 'create_file', args: { path: 'src/enemy.js' }, ok: true, observation: 'ok' },
    { tool: 'create_file', args: { path: 'src/main.js' }, ok: true, observation: 'ok' }, // duplicado
    { tool: 'modify_file', args: { path: 'src/enemy.js' }, ok: true, observation: 'ok' },
    { tool: 'read_file', args: { path: 'src/main.js' }, ok: true, observation: 'conteúdo' },
    { tool: 'run_tests', ok: true, observation: 'TESTES_PASSARAM (node --test) 5/5' },
  ]
  const p = agentProgressFromSteps(steps)
  assert.deepEqual(p.filesTouched, ['src/main.js', 'src/enemy.js'], 'arquivos únicos em ordem')
  assert.equal(p.testRuns, 1)
  assert.equal(p.lastTestPassed, true)
  assert.equal(p.lastTool, 'run_tests')
  assert.equal(p.steps, 7)

  const p2 = agentProgressFromSteps([
    { tool: 'run_tests', ok: false, observation: 'TESTES_FALHARAM ... fail 2' },
  ])
  assert.equal(p2.lastTestPassed, false)
  assert.equal(p2.testRuns, 1)

  const p3 = agentProgressFromSteps([])
  assert.deepEqual(p3.filesTouched, [])
  assert.equal(p3.lastTestPassed, null)
  assert.equal(p3.lastTool, null)
})

test('C4 — compactConversation preserva system+objetivo+estado+últimos turnos', () => {
  const msgs: CompactionMessage[] = [
    msg('system', 'SYSTEM PROMPT'),
    msg('user', 'OBJETIVO ORIGINAL'),
    msg('assistant', 'antiga 1'),
    msg('user', 'obs antiga 1'),
    msg('assistant', 'antiga 2'),
    msg('user', 'obs antiga 2'),
    msg('assistant', 'recente 1'),
    msg('user', 'obs recente 1'),
    msg('assistant', 'recente 2'),
    msg('user', 'obs recente 2'),
  ]
  const progress = agentProgressFromSteps([
    { tool: 'create_file', args: { path: 'src/a.js' }, ok: true },
    { tool: 'run_tests', ok: true, observation: 'TESTES_PASSARAM' },
  ])
  const out = compactConversation(msgs, { keepLastTurns: 4, progress })
  assert.equal(out[0].content, 'SYSTEM PROMPT')
  assert.equal(out[1].content, 'OBJETIVO ORIGINAL')
  assert.match(out[2].content, /COMPACTAÇÃO AUTOMÁTICA/)
  assert.match(out[2].content, /src\/a\.js/)
  assert.match(out[2].content, /NÃO refazer/i)
  // últimos 4 turnos preservados; miolo antigo removido
  const contents = out.map((m) => m.content)
  assert.ok(!contents.includes('antiga 1'))
  assert.ok(contents.includes('obs recente 2'))
  assert.equal(out.length, 3 + 4)
  // com keepLastTurns 0 → só system+objetivo+estado
  const out0 = compactConversation(msgs, { keepLastTurns: 0, progress })
  assert.equal(out0.length, 3)
})

test('C5 — o estado preservado é o ANTÍDOTO ao bug de repetição do Codex', () => {
  const progress = agentProgressFromSteps([
    { tool: 'create_file', args: { path: 'projeto.godot' }, ok: true },
    { tool: 'create_file', args: { path: 'main.gd' }, ok: true },
    { tool: 'run_tests', ok: true, observation: 'TESTES_PASSARAM 4/4' },
  ])
  const out = compactConversation(
    [
      msg('system', 'sys'),
      msg('user', 'objetivo'),
      msg('assistant', 'passo antigo'),
    ],
    { keepLastTurns: 2, progress }
  )
  const state = out[2].content
  // quem foi compactado deve conseguir retomar sem refazer:
  assert.match(state, /projeto\.godot/)
  assert.match(state, /main\.gd/)
  assert.match(state, /última PASS/)
  assert.match(state, /Retome EXATAMENTE/)
})
