// ============================================================
// QUESTION FORMAT — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-question-format.test.ts
// Valida o parse/normalização da tool ask_user_question:
//   Q1. String JSON array bem-formada
//   Q2. Objeto {questions: [...]} e pergunta única {question, options}
//   Q3. Fallback textual "pergunta | opção | opção"
//   Q4. Limites: máx 4 perguntas / 4 opções, textos cortados
//   Q5. Erros instrutivos: vazio, sem JSON, opções insuficientes
//   Q6. formatUserAnswers: resumo da resposta p/ observação
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseQuestionsInput,
  formatUserAnswers,
  MAX_QUESTIONS,
} from '../src/lib/studio/tools/question-format.ts'

test('Q1 — string JSON array bem-formada parseia com header/opções/descrições', () => {
  const raw = JSON.stringify([
    {
      header: 'Controles',
      question: 'O jogo deve ter controles por toque ou teclado?',
      options: [
        { label: 'Toque', description: 'mobile-first' },
        { label: 'Teclado', description: 'setas + espaço' },
      ],
    },
  ])
  const r = parseQuestionsInput(raw)
  assert.ok(r.ok, 'deve parsear')
  if (!r.ok) return
  assert.equal(r.questions.length, 1)
  assert.equal(r.questions[0].header, 'Controles')
  assert.equal(r.questions[0].options.length, 2)
  assert.equal(r.questions[0].options[0].description, 'mobile-first')
})

test('Q2 — aceita {questions:[...]} e pergunta única {question, options}', () => {
  const a = parseQuestionsInput(JSON.stringify({ questions: [{ question: 'Estilo?', options: [{ label: 'Retro' }, { label: 'Moderno' }] }] }))
  assert.ok(a.ok)
  if (a.ok) assert.equal(a.questions.length, 1)

  const b = parseQuestionsInput(JSON.stringify({ question: 'Idioma?', options: ['PT', 'EN'] }))
  assert.ok(b.ok)
  if (b.ok) {
    assert.equal(b.questions[0].options[0].label, 'PT')
    assert.equal(b.questions[0].options[1].label, 'EN')
  }
})

test('Q3 — fallback textual com separador | vira pergunta única com opções', () => {
  const r = parseQuestionsInput('Tema do jogo | Espaço | Medieval')
  assert.ok(r.ok, 'fallback textual deve parsear')
  if (!r.ok) return
  assert.equal(r.questions.length, 1)
  assert.equal(r.questions[0].options.length, 2)
  assert.equal(r.questions[0].options[0].label, 'Espaço')
})

test('Q4 — limites: corta em 4 perguntas e 4 opções; textos longos são cortados', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    question: `Pergunta ${i}?`,
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }],
  }))
  const r = parseQuestionsInput(JSON.stringify(many))
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.questions.length, MAX_QUESTIONS, 'máximo 4 perguntas')
  assert.equal(r.questions[0].options.length, 4, 'máximo 4 opções por pergunta')

  const long = parseQuestionsInput(
    JSON.stringify([{ question: 'x'.repeat(900), options: [{ label: 'y'.repeat(200) }, { label: 'B' }] }])
  )
  assert.ok(long.ok)
  if (long.ok) {
    assert.ok(long.questions[0].question.length <= 300, 'pergunta cortada em 300')
    assert.ok(long.questions[0].options[0].label.length <= 60, 'label cortado em 60')
  }
})

test('Q5 — erros instrutivos: vazio, sem formato, opções insuficientes', () => {
  const empty = parseQuestionsInput('')
  assert.ok(!empty.ok)
  if (!empty.ok) assert.match(empty.error, /vazio/i)

  const garbage = parseQuestionsInput('lorem ipsum sem barras')
  assert.ok(!garbage.ok, 'texto sem opções é rejeitado com erro instrutivo')
  if (!garbage.ok) assert.match(garbage.error, /formato inválido|opção/i)

  const noOptions = parseQuestionsInput(JSON.stringify([{ question: 'Sem opções?' }]))
  assert.ok(!noOptions.ok, 'pergunta sem opções é rejeitada (mín 2)')
  if (!noOptions.ok) assert.match(noOptions.error, /mínimo 2/i)

  const malformed = parseQuestionsInput('[{broken json')
  assert.ok(!malformed.ok)
})

test('Q6 — formatUserAnswers resume as respostas para a observação', () => {
  const out = formatUserAnswers([
    { header: 'Controles', answer: 'Toque' },
    { answer: 'PT-BR' },
  ])
  assert.match(out, /Controles: Toque/)
  assert.match(out, /- PT-BR/)
  assert.equal(formatUserAnswers([]), '(sem conteúdo)')
})
