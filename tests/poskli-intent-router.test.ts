// ============================================================
// POSKLI INTENT ROUTER — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-intent-router.test.ts
// Criação AUTOMÁTICA de projeto (sem seletor de tipo):
//   C1. contexto claro → template detetado com confiança
//   C2. contexto ambíguo → PERGUNTA (AskUserQuestion), nunca
//       adivinha silenciosamente
//   C3. resposta do usuário → tipo resolvido
//   C4. nome do projeto derivado da 1ª mensagem
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyIntent, clarifyQuestion, resolveTypeFromAnswer, projectNameFromMessage, CLARIFY_OPTIONS,
} from '../src/lib/studio/projects/intent-router.ts'

test('C1 — mensagens claras decidem o template sozinhas', () => {
  const cases: Array<[string, string]> = [
    ['Cria uma landing page para a minha loja', 'LANDING_PAGE'],
    ['Faz um site sobre gatos', 'LANDING_PAGE'],
    ['Cria uma página de vendas', 'LANDING_PAGE'],
    ['Cria um jogo na Godot', 'MINI_GAME'],
    ['Cria um mini-game 2D de sobrevivência para celular', 'MINI_GAME'],
    ['Cria um jogo de esquivar obstáculos', 'MINI_GAME'],
    ['Cria um jogo de plataforma estilo metroidvania', 'MINI_GAME'],
    ['Cria uma API REST de tarefas', 'API'],
    ['Faz um backend para pedidos', 'API'],
    ['Cria um PWA de notas', 'PWA'],
    ['Cria uma aplicação web instalável', 'PWA'],
    ['Cria uma app web com dashboard', 'WEB_APP'],
    ['Cria uma plataforma web de cursos', 'WEB_APP'],
    ['Cria uma loja online', 'WEB_APP'],
  ]
  for (const [msg, type] of cases) {
    const intent = classifyIntent(msg)
    assert.equal(intent.type, type, `"${msg}" → ${type}`)
    assert.ok(intent.confident, `"${msg}" deve ser confident`)
    assert.ok(intent.matched.length > 0, 'evidência da decisão presente')
  }

  // "landing page" vence "jogo" quando a página É o pedido
  const landingDeJogo = classifyIntent('Cria uma landing page para divulgar meu jogo')
  assert.equal(landingDeJogo.type, 'LANDING_PAGE')
  assert.ok(landingDeJogo.confident)

  // "plataforma web" é app; "jogo de plataforma" é jogo
  assert.equal(classifyIntent('Cria uma plataforma web de cursos').type, 'WEB_APP')
  assert.equal(classifyIntent('Cria um jogo de plataforma').type, 'MINI_GAME')
})

test('C2 — contexto ambíguo PERGUNTA antes de criar', () => {
  const ambiguous = [
    'Cria uma app',
    'Faz-me uma aplicação',
    'Preciso de um aplicativo',
    'faz qualquer coisa gira',
  ]
  for (const msg of ambiguous) {
    const intent = classifyIntent(msg)
    assert.ok(!intent.confident, `"${msg}" deve ser ambíguo (pergunta, não adivinha)`)
  }

  const q = clarifyQuestion()
  assert.ok(q.question.length > 10, 'pergunta legível')
  assert.ok(q.options.length >= 3, 'mín 3 opções')
  const labels = q.options.map((o) => o.label)
  assert.ok(labels.includes('App Web') && labels.includes('Jogo'), 'opções cobrem app/jogo')
  // opções da constante == opções da pergunta (fonte única)
  assert.deepEqual(CLARIFY_OPTIONS.map((o) => o.label), labels)
  // pergunta da spec: "app web, mobile ou um jogo?"
  assert.match(q.question, /app web/i)
  assert.match(q.question, /jogo/i)
})

test('C3 — resposta do usuário resolve o tipo com confiança', () => {
  const cases: Array<[string, string]> = [
    ['Jogo', 'MINI_GAME'],
    ['um jogo mobile', 'MINI_GAME'],
    ['Landing Page', 'LANDING_PAGE'],
    ['uma página simples', 'LANDING_PAGE'],
    ['API', 'API'],
    ['um backend REST', 'API'],
    ['App Web', 'WEB_APP'],
    ['uma aplicação web', 'WEB_APP'],
    ['PWA', 'PWA'],
  ]
  for (const [answer, type] of cases) {
    const resolved = resolveTypeFromAnswer(answer)
    assert.equal(resolved.type, type, `"${answer}" → ${type}`)
    assert.ok(resolved.confident, `"${answer}" resolve com confiança`)
  }
  // resposta sem sinal → segue ambíguo (honesto)
  assert.ok(!resolveTypeFromAnswer('tanto faz').confident)
})

test('C4 — nome do projeto derivado da 1ª mensagem (sem prefixes conversacionais)', () => {
  assert.equal(projectNameFromMessage('Cria um jogo de naves'), 'Jogo de naves')
  assert.equal(projectNameFromMessage('Faz um site sobre gatos'), 'Site sobre gatos')
  assert.equal(projectNameFromMessage('Cria uma landing page para a minha loja'), 'Landing page para a minha')
  // vazio → fallback
  assert.equal(projectNameFromMessage(''), 'Nova conversa')
  assert.equal(projectNameFromMessage('   '), 'Nova conversa')
  // nome nunca excede 40 chars
  const long = projectNameFromMessage('Cria um jogo muito muito muito muito muito muito complexo com naves')
  assert.ok(long.length <= 40, `nome curto: ${long}`)
})
