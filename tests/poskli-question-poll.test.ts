// ============================================================
// QUESTION POLL — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-question-poll.test.ts
// Interatividade (AskUserQuestion): a tool BLOQUEIA o loop do
// agente até a resposta do usuário.
//   Q1. PENDING + dentro do prazo → WAIT (continua bloqueado)
//   Q2. ANSWERED → ANSWER (resposta devolvida ao LLM)
//   Q3. prazo esgotado sem resposta → TIMEOUT (prossegue
//       conservador — nunca fica preso)
//   Q4. run CANCELLED durante a espera → CANCELLED (aborta)
//   Q5. sequência real: WAIT → WAIT → ANSWER
//   Q6. precedência: cancelado vence mesmo com resposta
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { nextQuestionPollAction } from '../src/lib/studio/tools/question-format.ts'

const now = 1_000_000
const window = 120_000
const deadline = now + window

test('Q1 — PENDING dentro do prazo → WAIT (o agente permanece BLOQUEADO à espera)', () => {
  const a = nextQuestionPollAction({ toolCallStatus: 'PENDING', runState: 'RUNNING', now: now + 2_000, deadline })
  assert.equal(a, 'WAIT')
})

test('Q2 — status ANSWERED → ANSWER (a resposta chega ao LLM e o loop retoma)', () => {
  const a = nextQuestionPollAction({ toolCallStatus: 'ANSWERED', runState: 'RUNNING', now: now + 4_000, deadline })
  assert.equal(a, 'ANSWER')
})

test('Q3 — prazo esgotado SEM resposta → TIMEOUT (nunca fica preso infinitamente)', () => {
  const a = nextQuestionPollAction({ toolCallStatus: 'PENDING', runState: 'RUNNING', now: deadline + 1, deadline })
  assert.equal(a, 'TIMEOUT')
  // ToolCall marcada como TIMEOUT/CANCELLED também resolve
  assert.equal(nextQuestionPollAction({ toolCallStatus: 'TIMEOUT', runState: 'RUNNING', now, deadline }), 'TIMEOUT')
  assert.equal(nextQuestionPollAction({ toolCallStatus: 'CANCELLED', runState: 'RUNNING', now, deadline }), 'TIMEOUT')
})

test('Q4 — run CANCELLED durante a espera → CANCELLED (aborta imediatamente)', () => {
  const a = nextQuestionPollAction({ toolCallStatus: 'PENDING', runState: 'CANCELLED', now: now + 2_000, deadline })
  assert.equal(a, 'CANCELLED')
})

test('Q5 — sequência real de polling: 3 voltas esperando, resposta na 4ª', () => {
  const states = ['PENDING', 'PENDING', 'PENDING', 'ANSWERED']
  const actions = states.map((s, i) =>
    nextQuestionPollAction({ toolCallStatus: s, runState: 'IMPLEMENTING', now: now + (i + 1) * 2_000, deadline })
  )
  assert.deepEqual(actions, ['WAIT', 'WAIT', 'WAIT', 'ANSWER'])
  // o agente ficou BLOQUEADO (WAIT×3) até a resposta — comportamento exigido
})

test('Q6 — precedência: cancelamento vence mesmo se houve resposta', () => {
  const a = nextQuestionPollAction({ toolCallStatus: 'ANSWERED', runState: 'CANCELLED', now, deadline })
  assert.equal(a, 'CANCELLED')
})

test('Q7 — linha do tempo simulada: 60s sem resposta até o limite → sempre WAIT, depois TIMEOUT', () => {
  let ticks = 0
  let action: string = 'WAIT'
  while (action === 'WAIT' && ticks < 200) {
    ticks++
    action = nextQuestionPollAction({
      toolCallStatus: 'PENDING',
      runState: 'RUNNING',
      now: now + ticks * 2_000, // polling de 2s
      deadline,
    })
  }
  // esgotou a janela de 120s em 60 voltas de 2s — nunca ANSWER sem usuário
  assert.equal(action, 'TIMEOUT')
  assert.equal(ticks, Math.floor(window / 2_000))
})
