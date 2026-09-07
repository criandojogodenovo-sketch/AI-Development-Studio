// ============================================================
// TASK TEXT — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-task-text.test.ts
// Bug de serialização: painel mostrava "[object Object]" na
// descrição da task quando o plano do LLM vinha com objetos.
//   T1. string passa direto
//   T2. objeto {"text": ...} → texto legível
//   T3. objeto aninhado → campo preferido recursivo
//   T4. array → itens unidos
//   T5. objeto desconhecido → JSON legível (nunca [object Object])
//   T6. taskTitle com fallback
//   T7. isObjectCoercionArtifact detecta o artefato
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  taskText, taskTitle, isObjectCoercionArtifact,
} from '../src/lib/studio/orchestrator/task-text.ts'

test('T1 — string passa direto (caso normal)', () => {
  assert.equal(taskText('Implementar lógica do jogo'), 'Implementar lógica do jogo')
  assert.equal(taskText(42), '42')
  assert.equal(taskText(true), 'true')
  assert.equal(taskText(null), '')
  assert.equal(taskText(undefined), '')
})

test('T2 — objeto com campo de texto → descrição legível', () => {
  // formato que o LLM às vezes devolve no plano
  const plan = { description: { text: 'Implementar lógica do jogo com colisões' } }
  assert.equal(taskText(plan.description), 'Implementar lógica do jogo com colisões')

  const desc2 = { summary: 'Criar tela de game over' }
  assert.equal(taskText(desc2), 'Criar tela de game over')

  const desc3 = { instruction: 'Configurar controles por toque' }
  assert.equal(taskText(desc3), 'Configurar controles por toque')
})

test('T3 — objeto aninhado resolve recursivamente', () => {
  const nested = { description: { details: { text: 'Implementar física do pulo' } } }
  assert.equal(taskText(nested), 'Implementar física do pulo')

  const viaObjeto = { value: { summary: 'Adicionar inimigos' } }
  assert.equal(taskText(viaObjeto), 'Adicionar inimigos')
})

test('T4 — array de passos → itens unidos com "; "', () => {
  const steps = ['Criar player', 'Criar inimigo', { text: 'Criar colisão' }]
  const out = taskText(steps)
  assert.equal(out, 'Criar player; Criar inimigo; Criar colisão')
  assert.ok(!out.includes('[object Object]'))
})

test('T5 — objeto desconhecido → JSON legível, NUNCA [object Object]', () => {
  const weird = { xyz: 'conteúdo', n: 7 }
  const out = taskText(weird)
  assert.ok(out.includes('xyz'))
  assert.ok(out.includes('conteúdo'))
  assert.ok(!out.includes('[object Object]'))
  // String() padrão produziria [object Object] — nunca pode acontecer
  assert.notEqual(out, String(weird))
})

test('T6 — taskTitle com fallback numérico quando vazio', () => {
  assert.equal(taskTitle('Título ok', 3), 'Título ok')
  assert.equal(taskTitle('', 3), 'Tarefa 4')
  assert.equal(taskTitle(null, 0), 'Tarefa 1')
  assert.equal(taskTitle({ text: '' }, 1), 'Tarefa 2')
})

test('T7 — detector de artefato de coerção reconhece "[object Object]"', () => {
  assert.equal(isObjectCoercionArtifact('[object Object]'), true)
  assert.equal(isObjectCoercionArtifact(' [object Object] '), true)
  assert.equal(isObjectCoercionArtifact('Descrição legível'), false)
})

test('T8 — simulação do fluxo real: plano do LLM → textos do DB', () => {
  // reprodução do cenário do bug: plano com description como objeto
  const planoLlm = {
    plan: {
      architecture: 'Jogo 2D em canvas',
      stack: ['canvas'],
      tasks: [
        { title: { text: 'Lógica do jogo' }, description: { text: 'Implementar lógica do jogo' }, agentRole: 'coding', priority: 'HIGH', dependsOn: [] },
        { title: 'Testes', description: ['Criar testes', 'Rodar e reportar'], agentRole: 'testing', priority: 'HIGH', dependsOn: [0] },
      ],
    },
  }
  const tasks = planoLlm.plan.tasks.map((t) => ({
    title: taskTitle(t.title, 0).slice(0, 200),
    description: taskText(t.description).trim().slice(0, 4000),
  }))
  assert.equal(tasks[0]!.description, 'Implementar lógica do jogo')
  assert.equal(tasks[0]!.title, 'Lógica do jogo')
  assert.equal(tasks[1]!.description, 'Criar testes; Rodar e reportar')
  // em lugar NENHUM aparece o artefato
  const all = JSON.stringify(tasks)
  assert.ok(!all.includes('[object Object]'))
})
