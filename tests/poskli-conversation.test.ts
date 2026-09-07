// ============================================================
// MODO CONVERSA — TESTES (node:test, PURO)
// Executar: node --test tests/poskli-conversation.test.ts
// Pedidos SEM verbos de ação → resposta direta (sem run/projeto):
//   C1. mensagens puramente conversacionais → conversation:true
//   C2. pedidos de trabalho → conversation:false (run normal)
//   C3. fast-plan integra o modo sem quebrar os planos existentes
//   C4. ask_user_question registada (interatividade — obrigatória)
//   C5. hint instrui resposta natural + sugestão de trabalho
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { conversationModeFor, planModeFor, isSimpleBuildRequest } from '../src/lib/studio/poskli/fast-plan.ts'
import { isConversational } from '../src/lib/studio/poskli/toon.ts'
import { parseQuestionsInput, MAX_QUESTIONS } from '../src/lib/studio/tools/question-format.ts'

test('C1 — mensagens conversacionais ativam o Modo Conversa', () => {
  for (const msg of [
    'Olá, como estás hoje?',
    'obrigado, ficou exato como eu queria!',
    'isso é interessante',
    'boa tarde!',
    'quem és tu?',
  ]) {
    const decision = conversationModeFor(msg)
    assert.equal(decision.conversation, true, `"${msg}" deve ser conversa`)
    assert.ok(decision.hint.length > 0, 'hint instrutivo quando conversa')
  }
})

test('C2 — pedidos de trabalho NÃO ativam o Modo Conversa', () => {
  for (const msg of [
    'Faz um site sobre gatos',
    'Cria uma landing page',
    'Corrige o bug do login',
    'Adiciona uma página de contacto ao site',
    'Refatora o módulo de autenticação',
    'Gera um jogo de nave',
    'Mostra o estado do projeto',
  ]) {
    assert.equal(conversationModeFor(msg).conversation, false, `"${msg}" NÃO é conversa`)
    assert.equal(isConversational(msg), false)
  }
})

test('C3 — fast-plan continua a classificar o ritmo de construção', () => {
  // o Modo Conversa NÃO quebra o fast-plan: pedidos de trabalho
  // mantêm o comportamento anterior (fast + pesquisa opcional)
  assert.equal(isSimpleBuildRequest('Cria uma landing page'), true)
  const mode = planModeFor('Cria uma landing page')
  assert.equal(mode.fast, true)
  assert.equal(mode.webSearch, 'optional')
})

test('C4 — ask_user_question registada (interatividade — obrigatória)', () => {
  // NOTA: tools/index.ts importa @/lib/db (Prisma) — não importável em
  // node:test puro; a REGISTRAÇÃO é verificada no FONTE (e garantida pelo
  // tsc/build), o FORMATO é verificado no módulo puro question-format.
  const indexSrc = readFileSync(new URL('../src/lib/studio/tools/index.ts', import.meta.url), 'utf8')
  assert.ok(indexSrc.includes('askUserQuestionTool'), 'ask_user_question deve estar importada no registry')
  const userToolsSrc = readFileSync(new URL('../src/lib/studio/tools/user-tools.ts', import.meta.url), 'utf8')
  assert.ok(userToolsSrc.includes("name: 'ask_user_question'"), 'tool declarada com nome ask_user_question')
  assert.ok(userToolsSrc.includes("'user:ask'"), 'permissão user:ask')
  // formato: JSON com header+question+options é aceite (parse puro)
  const parsed = parseQuestionsInput(
    JSON.stringify([{ header: 'Estilo', question: 'Claro ou escuro?', options: ['claro', 'escuro'] }]),
  )
  assert.equal(parsed.ok, true)
  assert.ok(MAX_QUESTIONS >= 1)
})

test('C5 — o hint de conversa guia uma resposta natural com sugestão', () => {
  const { hint } = conversationModeFor('olá')
  assert.match(hint, /natural/i)
  assert.match(hint, /idioma/i)
  assert.match(hint, /TRABALHO|pedir/i)
})
