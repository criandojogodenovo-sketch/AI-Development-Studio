// ============================================================
// AGENT POOL — TESTES (node:test, PURO)
// Executar: node --test tests/poskli-agent-pool.test.ts
// POOL de agentes dinâmico: seleção de modelos por dificuldade
//   P1. selectAgentsForTask: simple/medium/hard/complex → trio certo
//   P2. complex: alternância hy3 (pesquisa) / glm-5.3 (lógica)
//   P3. routesForTaskProfile: paradas provider+modelo por perfil
//   P4. MODEL_ALIASES: nomes de produto → modelos lógicos válidos
//   P5. instructions.json: pool declarado = POOL do código
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  selectAgentsForTask,
  selectCodingForComplex,
  resolveAgent,
  routesForTaskProfile,
  agentsForProfile,
  complexContextOf,
  MODEL_ALIASES,
  POOL,
  DIFFICULTY_MAP,
  isDifficulty,
  type TaskProfile,
} from '../src/lib/studio/poskli/agent-pool.ts'
import instructions from '../src/lib/studio/poskli/instructions.json' with { type: 'json' }

// Modelos lógicos válidos no registry do router (chain.ts)
const VALID_LOGICAL = new Set(['glm', 'qwen', 'hy3', 'deepseek', 'luna', 'gpt-oss', 'nemotron'])

test('P1 — selectAgentsForTask devolve o trio correto por dificuldade', () => {
  assert.deepEqual(selectAgentsForTask('simple'), {
    master: 'mimo-v2.5',
    coding: 'gpt-oss-20b',
    review: 'mimo-v2.5',
  })
  assert.deepEqual(selectAgentsForTask('medium'), {
    master: 'meta/llama-3.3-70b-instruct',
    coding: 'deepseek-v4-flash-0731',
    review: 'qwen',
  })
  assert.deepEqual(selectAgentsForTask('hard'), {
    master: 'mimo-v2.5',
    coding: 'glm-5.3',
    review: 'mimo-v2.5',
  })
  assert.deepEqual(selectAgentsForTask('complex'), {
    master: 'meta/llama-3.3-70b-instruct',
    coding: 'hy3',
    review: 'qwen',
  })
})

test('P1b — o trio de cada dificuldade usa SÓ modelos do POOL declarado', () => {
  for (const [difficulty, trio] of Object.entries(DIFFICULTY_MAP)) {
    assert.equal(POOL.master.includes(trio.master), true, `master ${trio.master} fora do pool (${difficulty})`)
    assert.equal(POOL.coding.includes(trio.coding), true, `coding ${trio.coding} fora do pool (${difficulty})`)
    assert.equal(POOL.review.includes(trio.review), true, `review ${trio.review} fora do pool (${difficulty})`)
  }
})

test('P2 — complex alterna o coding: pesquisa → hy3 · lógica pura → glm-5.3', () => {
  assert.equal(selectCodingForComplex('research'), 'hy3')
  assert.equal(selectCodingForComplex('logic'), 'glm-5.3')
  assert.equal(selectCodingForComplex('default'), 'hy3')
  // via perfil (kind do TOON)
  assert.equal(complexContextOf('research'), 'research')
  assert.equal(complexContextOf('logic'), 'logic')
  assert.equal(complexContextOf('web'), 'default')
  // via agentsForProfile
  const researchProfile: TaskProfile = { difficulty: 'complex', kind: 'research' }
  const logicProfile: TaskProfile = { difficulty: 'complex', kind: 'logic' }
  assert.equal(agentsForProfile(researchProfile).coding, 'hy3')
  assert.equal(agentsForProfile(logicProfile).coding, 'glm-5.3')
  // resolveAgent segue a mesma alternância
  assert.equal(resolveAgent('coding', 'complex', 'logic'), 'glm-5.3')
  assert.equal(resolveAgent('coding', 'complex', 'research'), 'hy3')
  assert.equal(resolveAgent('review', 'simple'), 'mimo-v2.5')
})

test('P3 — routesForTaskProfile: paradas válidas (provider + modelo lógico do registry)', () => {
  const profiles: TaskProfile[] = [
    { difficulty: 'simple', kind: 'web' },
    { difficulty: 'medium', kind: 'web' },
    { difficulty: 'hard', kind: 'logic' },
    { difficulty: 'complex', kind: 'research' },
    { difficulty: 'complex', kind: 'logic' },
  ]
  for (const profile of profiles) {
    const routes = routesForTaskProfile(profile)
    for (const role of ['master', 'coding', 'review'] as const) {
      const stops = routes[role]
      assert.ok(stops.length >= 1, `${role} vazio para ${profile.difficulty}/${profile.kind}`)
      for (const stop of stops) {
        assert.ok(['bai', 'nvidia'].includes(stop.provider), `provider inválido: ${stop.provider}`)
        assert.ok(VALID_LOGICAL.has(stop.model), `modelo lógico desconhecido: ${stop.model}`)
      }
    }
  }
})

test('P3b — complex/logic encabeça com glm; complex/research encabeça com hy3', () => {
  const logic = routesForTaskProfile({ difficulty: 'complex', kind: 'logic' })
  const research = routesForTaskProfile({ difficulty: 'complex', kind: 'research' })
  assert.equal(logic.coding[0].model, 'glm')
  assert.equal(research.coding[0].model, 'hy3')
  // rotas de coding têm reserva (≥2 paradas — resiliência a 429)
  assert.ok(logic.coding.length >= 2, 'coding complex/logic deve ter reserva')
  assert.ok(research.coding.length >= 2, 'coding complex/research deve ter reserva')
})

test('P3c — paradas de rotas longas declaram política anti-rate-limit (última usa default)', () => {
  const routes = routesForTaskProfile({ difficulty: 'complex', kind: 'research' })
  for (const role of ['master', 'coding', 'review'] as const) {
    const stops = routes[role]
    // todas exceto a última (que usa o default retry-backoff)
    for (const stop of stops.slice(0, -1)) {
      assert.ok(stop.onRateLimit !== undefined, `${role}: parada ${stop.provider}/${stop.model} deve declarar onRateLimit`)
    }
  }
})

test('P4 — MODEL_ALIASES mapeia nomes de produto para modelos lógicos válidos', () => {
  for (const [product, logical] of Object.entries(MODEL_ALIASES)) {
    assert.ok(VALID_LOGICAL.has(logical), `alias ${product} → ${logical} inválido`)
  }
  // todos os nomes de produto do POOL têm alias
  for (const role of ['master', 'coding', 'review'] as const) {
    for (const name of POOL[role]) {
      assert.ok(MODEL_ALIASES[name] !== undefined, `modelo do pool sem alias: ${name}`)
    }
  }
})

test('P5 — instructions.json declara o MESMO pool do código (fonte única)', () => {
  const declared = (instructions as { agents: { master: string[]; coding: string[]; review: string[] } }).agents
  assert.deepEqual(declared.master, POOL.master)
  assert.deepEqual(declared.coding, POOL.coding)
  assert.deepEqual(declared.review, POOL.review)
  // regras sempre/nunca presentes (usadas no prompt do master)
  const rules = (instructions as { agentRules: { always: string[]; never: string[] } }).agentRules
  assert.ok(rules.always.length >= 3)
  assert.ok(rules.never.length >= 3)
})

test('P6 — isDifficulty valida e rejeita valores inválidos', () => {
  assert.equal(isDifficulty('simple'), true)
  assert.equal(isDifficulty('complex'), true)
  assert.equal(isDifficulty('extreme'), false)
  assert.equal(isDifficulty(''), false)
})
