// ============================================================
// LOOP GUARD — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-loop-guard.test.ts
// Detecção de loops a NÍVEL DE PLANO:
//   L1. failureSignature: estável para o mesmo erro, ignora
//       tempos/contagens; distingue erros diferentes
//   L2. shouldStopCorrectionCycle — SAME_FAILURE (2x seguidas)
//   L3. shouldStopCorrectionCycle — NO_REPO_CHANGE (diff vazio)
//   L4. não para quando: falhas distintas OU repo mudou
//   L5. mensagem honesta "LOOP_DETECTADO" + parar de gastar
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  failureSignature,
  hasFailureSignature,
  shouldStopCorrectionCycle,
} from '../src/lib/studio/poskli/loop-guard.ts'

test('L1 — assinatura de falha é estável e discriminante', () => {
  const failA1 = `node --test test/game.test.js
# fail 1
AssertionError: expected 5 to equal 3
    at Test.run (node:test)
✖ erro em colisão (1200ms)`
  const failA2 = `node --test test/game.test.js
# fail 1
AssertionError: expected 5 to equal 3
    at Test.run (node:test)
✖ erro em colisão (2500ms)` // mesma falha, tempo diferente
  const failB = `node --test test/game.test.js
# fail 1
TypeError: cannot read property 'x' of undefined`

  const sA1 = failureSignature(failA1, '')
  const sA2 = failureSignature(failA2, '')
  const sB = failureSignature(failB, '')

  assert.equal(sA1, sA2, 'mesma falha → mesma assinatura (tempo ignorado)')
  assert.notEqual(sA1, sB, 'falha distinta → assinatura distinta')

  assert.ok(hasFailureSignature(failA1, ''))
  assert.ok(!hasFailureSignature('tudo ok', ''), 'sem erro → sem assinatura')
  assert.equal(failureSignature('', ''), '')
})

test('L2 — SAME_FAILURE: 2 assinaturas iguais seguidas → PARAR', () => {
  const v = shouldStopCorrectionCycle({
    sameSignatures: ['AssertionError: expected 5', 'AssertionError: expected 5'],
    repoChangedAfterCorrection: true,
  })
  assert.ok(v.stop)
  assert.equal(v.reason, 'SAME_FAILURE')
  assert.match(v.message, /LOOP_DETECTADO/)
  assert.match(v.message, /mesmas/i)
})

test('L3 — NO_REPO_CHANGE: correção sem diff → PARAR', () => {
  const v = shouldStopCorrectionCycle({
    sameSignatures: ['erro A', 'erro B'], // falhas DISTINTAS
    repoChangedAfterCorrection: false,
  })
  assert.ok(v.stop)
  assert.equal(v.reason, 'NO_REPO_CHANGE')
  assert.match(v.message, /não alterou NENHUM arquivo/i)
})

test('L4 — não para com falhas distintas e repo mudando (ciclo saudável)', () => {
  const v = shouldStopCorrectionCycle({
    sameSignatures: ['erro A', 'erro B'],
    repoChangedAfterCorrection: true,
  })
  assert.ok(!v.stop)
  assert.equal(v.reason, '')

  // uma falha só (primeira) não é loop
  const single = shouldStopCorrectionCycle({
    sameSignatures: ['erro A'],
    repoChangedAfterCorrection: true,
  })
  assert.ok(!single.stop)

  // assinaturas vazias (sem detalhes) nunca disparam SAME_FAILURE
  const noSig = shouldStopCorrectionCycle({
    sameSignatures: ['', ''],
    repoChangedAfterCorrection: true,
  })
  assert.ok(!noSig.stop)

  // git indisponível (null) não bloqueia
  const noGit = shouldStopCorrectionCycle({
    sameSignatures: ['erro A', 'erro B'],
    repoChangedAfterCorrection: null,
  })
  assert.ok(!noGit.stop)
})

test('L5 — mensagem orienta ação humana (não mascara como sucesso)', () => {
  const v = shouldStopCorrectionCycle({
    sameSignatures: ['x', 'x'],
    repoChangedAfterCorrection: null,
  })
  assert.match(v.message, /intervenção\/decisão humana|desperdício/i)
  // veredito de parada nunca contém "concluído"
  assert.ok(!/conclu[ií]do com sucesso/i.test(v.message))
})
