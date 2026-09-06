#!/usr/bin/env node
// ============================================================
// SMOKE TEST — POSKLI 0.2 (MÁQUINA DE ESTADOS EM PRODUÇÃO)
//
// Valida o INVARIANTE CENTRAL do Poskli 0.2:
//   CONCLUÍDO ⇔ deriveFinalStatus()=SUCCESS ⇔ todos os critérios PASS
//   testes vermelhos/tarefas falhas NUNCA produzem CONCLUÍDO.
//
// Cenários:
//   A) caso de sucesso real (implementação verificável)
//   B) caso de falha controlada (assertion impossível) — valida que
//      o resultado NUNCA é CONCLUÍDO sem evidência (anti-falso-positivo)
//   C) cancelamento mid-run → CANCELLED (nunca COMPLETED)
// ============================================================
const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const ts = Date.now()
const password = 'Poskli-OK!'

let token = ''
let passed = 0
let failed = 0

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`) }
  else { failed++; console.error(`  ✘ ${name}${extra ? ' — ' + extra : ''}`) }
}

async function api(path, init = {}) {
  const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, { ...init, headers })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ACTIVE = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING']
const TERMINAL = ['COMPLETED', 'FAILED', 'BLOCKED', 'PARTIAL', 'CANCELLED']

/** Mapeamento displayFromGlobal (espelha state-machine.ts — consistência backend↔UI). */
function displayOf(global) {
  return global === 'SUCCESS' ? 'COMPLETED' : global
}

async function login(email) {
  let r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name: 'Smoke 0.2', password }) })
  if (r.status === 400) r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  return r.status === 200 && r.data.token
}

async function pollTerminal(runId, maxMs) {
  const deadline = Date.now() + maxMs
  const seen = new Set()
  while (Date.now() < deadline) {
    const r = await api(`/api/poskli/${runId}`)
    const run = r.data.run
    if (run?.state && !seen.has(run.state)) {
      seen.add(run.state)
      console.log(`    · ${run.state}${run.iteration ? ` (iteração ${run.iteration}/${run.maxIterations})` : ''}`)
    }
    if (run?.state && !ACTIVE.includes(run.state)) return r.data
    await sleep(5000)
  }
  return null
}

/** Valida o INVARIANTE da máquina (independente do comportamento do agente). */
function validateMachine(detail, label) {
  const run = detail.run
  const derived = run?.derived
  console.log(`\n  [máquina — ${label}]`)

  ok(`${label}: run em estado terminal`, Boolean(run && TERMINAL.includes(run.state)), `state=${run?.state}`)
  ok(`${label}: derivação persistida (fonte da verdade)`, Boolean(derived && derived.state), `derived.state=${derived?.state}`)
  if (!derived) return

  // 1) consistência estado exibido = derivação persistida (spec §19/§20)
  ok(`${label}: estado exibido = derivação (backend=frontend)`, run.state === displayOf(derived.state), `run.state=${run.state} vs displayOf(${derived.state})=${displayOf(derived.state)}`)
  ok(`${label}: derivação conservadora marcada`, derived.conservative === true)
  ok(`${label}: motivo de máquina registrado`, typeof derived.reason === 'string' && derived.reason.length > 0, derived.reason)

  // 2) critérios coerentes com o estado (nunca falso positivo)
  const criteria = derived.criteria ?? []
  ok(`${label}: 6 critérios avaliados`, criteria.length === 6, criteria.map((c) => `${c.id}:${c.status}`).join(' '))
  const allPass = criteria.every((c) => c.status === 'PASS')
  const anyFail = criteria.some((c) => c.status === 'FAIL')
  if (derived.state === 'SUCCESS') {
    ok(`${label}: SUCCESS exige TODOS os critérios PASS`, allPass, 'anti-falso-positivo')
  }
  if (derived.state === 'FAILED') {
    ok(`${label}: FAILED tem pelo menos um critério FAIL`, anyFail, 'falha justificada por evidência')
  }
  if (derived.state === 'BLOCKED' || derived.state === 'PARTIAL') {
    ok(`${label}: BLOCKED/PARTIAL sem critério PASS-total (evidência insuficiente)`, !allPass)
  }

  // 3) INVARIANTE ABSOLUTO: run COMPLETED ⇔ derived SUCCESS (nunca só "npm test passou")
  if (run.state === 'COMPLETED') {
    ok(`${label}: COMPLETED somente com SUCCESS derivado`, derived.state === 'SUCCESS')
    ok(`${label}: COMPLETED com testes verdes`, run.testsPassed === true)
  } else {
    ok(`${label}: não-COMPLETED coerente (sem falso positivo)`, derived.state !== 'SUCCESS' || run.state === 'COMPLETED')
  }

  // 4) contadores reais
  const c = derived.counters
  if (c) {
    ok(`${label}: contadores de tarefas coerentes`, c.tasks.completed <= c.tasks.total, `${c.tasks.completed}/${c.tasks.total} concluídas, ${c.tasks.failed} falharam`)
    ok(`${label}: 0/N concluídas JAMAIS gera SUCCESS`, !(c.tasks.completed < c.tasks.total && derived.state === 'SUCCESS'), `${c.tasks.completed}/${c.tasks.total} → ${derived.state}`)
  }

  // 5) registros com identidade (sem duplicação)
  const testRecords = run.testRecords ?? []
  const ids = new Set(testRecords.map((t) => t.id))
  ok(`${label}: registros de teste com identidade única`, ids.size === testRecords.length, `${testRecords.length} registros, ${ids.size} ids únicos`)
  const corrections = run.corrections ?? []
  ok(`${label}: correções com estado individual`, corrections.every((c) => ['PLANNED', 'STARTED', 'COMPLETED', 'FAILED', 'BLOCKED'].includes(c.state)), `${corrections.length} correções`)
  ok(`${label}: revisão com snapshot persistido`, Boolean(run.reviewResult && run.reviewResult.status), `status=${run.reviewResult?.status}`)

  // 6) relatório markdown derivado da MESMA fonte
  ok(`${label}: relatório markdown presente`, Boolean(run.result && run.result.includes('Resultado do Poskli')))
  if (derived.state !== 'SUCCESS') {
    const stateLabel = { FAILED: 'Falhou', BLOCKED: 'Bloqueado', PARTIAL: 'Parcial', CANCELLED: 'Cancelado' }[derived.state] ?? derived.state
    ok(`${label}: markdown reflete o estado real (não Concluído)`, run.result.includes(`**Estado:** ${stateLabel}`) || run.result.includes('**Estado:** Falhou'))
  }
}

async function main() {
  console.log('SMOKE POSKLI 0.2 — MÁQUINA DE ESTADOS DETERMINÍSTICA')
  console.log(`alvo: ${BASE}\n`)

  const email = `smoke.poskli02.${ts}@studio-test.local`
  ok('login', await login(email))
  token = (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).data.token
    || (await api('/api/auth/me')).data.token
    || token

  // ==========================================================
  // CENÁRIO A — SUCESSO REAL (implementação verificável)
  // ==========================================================
  console.log('\n[CENÁRIO A — caso de sucesso real]')
  let r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Vidas 0.2 ${ts}`, type: 'MINI_GAME', description: 'smoke poskli 0.2' }) })
  ok('A: criar projeto', r.status === 201)
  const projectA = r.data.project?.id

  const requestA = 'Cria no arquivo src/vidas.js uma função contarVidas(inicial, perdidas) que retorna inicial - perdidas (nunca negativo, mínimo 0), exporta com ESM, e cria testes em test/vidas.test.js com node:test cobrindo: 3-1=2, 5-7=0 e 0-0=0.'
  r = await api('/api/poskli/run', { method: 'POST', body: JSON.stringify({ project: projectA, request: requestA }) })
  ok('A: Poskli iniciado (202)', r.status === 202 && r.data.runId, r.data.error ?? r.data.message)
  const runA = r.data.runId

  const detailA = await pollTerminal(runA, 12 * 60 * 1000)
  if (detailA) {
    validateMachine(detailA, 'A')
    const run = detailA.run
    ok('A: execuções reais no engine', (detailA.executions ?? []).length >= 1, `${(detailA.executions ?? []).length} execução(ões)`)
    ok('A: tokens contabilizados', (run.tokensIn ?? 0) + (run.tokensOut ?? 0) > 0, `${(run.tokensIn ?? 0) + (run.tokensOut ?? 0)} tokens`)
    ok('A: estágios registrados', (run.stages ?? []).length >= 4, `${(run.stages ?? []).map((s) => s.stage).join(' → ')}`)
    // verificação de conteúdo real
    const search = await api(`/api/workspace/search?project=${projectA}&q=vidas`)
    ok('A: implementação real presente no workspace', (search.data.results?.length ?? 0) > 0, `${search.data.results?.length} ocorrências`)
  } else {
    ok('A: run chegou a terminal (timeout)', false, '12 min sem estado terminal')
  }

  // ==========================================================
  // CENÁRIO B — FALHA CONTROLADA (assertion impossível)
  // O agente pode tentar de tudo; a MÁQUINA nunca pode declarar
  // CONCLUÍDO sem evidência (testes vermelhos → FAILED/BLOCKED).
  // ==========================================================
  console.log('\n[CENÁRIO B — falha controlada: teste impossível]')
  r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Impossível 0.2 ${ts}`, type: 'EMPTY_PROJECT', description: 'smoke falha controlada' }) })
  ok('B: criar projeto', r.status === 201)
  const projectB = r.data.project?.id

  // pré-escreve o teste IMPOSSÍVEL (agente não deve tocá-lo — instrução explícita)
  r = await api('/api/files', { method: 'POST', body: JSON.stringify({
    project: projectB, path: 'test/fixo.test.js',
    content: "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fixo e inalterável: 1+1 deve ser 3', () => {\n  assert.equal(1 + 1, 3, 'este teste falha POR CONSTRUÇÃO e não deve ser alterado')\n})\n",
  }) })
  ok('B: teste impossível pré-criado', r.status === 200 || r.status === 201, `status=${r.status}`)

  const requestB = 'Implemente src/calculo.js com função dobro(n) retornando n*2 (ESM). IMPORTANTE: o arquivo test/fixo.test.js é um teste de regressão FIXO e INALTERÁVEL — nunca modifique, apague ou reescreva test/fixo.test.js; ele deve continuar falhando exatamente como está se a matemática não mudar.'
  r = await api('/api/poskli/run', { method: 'POST', body: JSON.stringify({ project: projectB, request: requestB, maxIterations: 1 }) })
  ok('B: Poskli iniciado (202)', r.status === 202 && r.data.runId, r.data.error ?? r.data.message)
  const runB = r.data.runId

  const detailB = await pollTerminal(runB, 12 * 60 * 1000)
  if (detailB) {
    validateMachine(detailB, 'B')
    const run = detailB.run
    // INVARIANTE CENTRAL: se os testes ficaram vermelhos, NUNCA CONCLUÍDO
    const testRecords = run.testRecords ?? []
    const lastTest = testRecords[testRecords.length - 1]
    if (lastTest && lastTest.status === 'FAIL') {
      ok('B: testes vermelhos → JAMAIS CONCLUÍDO (§10)', run.state !== 'COMPLETED', `state=${run.state} com último teste ${lastTest.status}`)
      ok('B: derivado FAILED/BLOCKED/PARTIAL (nunca SUCCESS)', ['FAILED', 'BLOCKED', 'PARTIAL'].includes(run.derived?.state), `derived=${run.derived?.state}`)
    } else {
      // agente pode ter "resolvido" (alterando o teste — contra a instrução):
      // ainda assim a MÁQUINA deve ser coerente; logamos para auditoria manual
      console.log(`    (nota: último teste = ${lastTest?.status ?? 'nenhum'} — agente pode ter alterado o teste fixo; validando apenas invariantes da máquina)`)
    }
    ok('B: correção registrada com estado individual', (run.corrections ?? []).every((c) => ['PLANNED', 'STARTED', 'COMPLETED', 'FAILED', 'BLOCKED'].includes(c.state)), `${(run.corrections ?? []).length} correção(ões)`)
  } else {
    ok('B: run chegou a terminal (timeout)', false, '12 min sem estado terminal')
  }

  // ==========================================================
  // CENÁRIO C — CANCELAMENTO mid-run (interrompido ≠ concluído)
  // ==========================================================
  console.log('\n[CENÁRIO C — cancelamento mid-run]')
  r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Cancel 0.2 ${ts}`, type: 'MINI_GAME', description: 'smoke cancelamento' }) })
  ok('C: criar projeto', r.status === 201)
  const projectC = r.data.project?.id

  r = await api('/api/poskli/run', { method: 'POST', body: JSON.stringify({ project: projectC, request: 'Cria um jogo de esquivar obstáculos com pontuação e testes automatizados.' }) })
  ok('C: Poskli iniciado (202)', r.status === 202 && r.data.runId, r.data.error ?? r.data.message)
  const runC = r.data.runId

  // espera entrar em execução (qualquer fase ativa) e cancela
  let cancelledAt = null
  for (let i = 0; i < 24; i++) {
    const d = await api(`/api/poskli/${runC}`)
    if (d.data.run?.state && ACTIVE.includes(d.data.run.state)) { cancelledAt = d.data.run.state; break }
    await sleep(5000)
  }
  ok('C: run ativo detectado para cancelar', Boolean(cancelledAt), `cancelado durante ${cancelledAt ?? '—'}`)

  if (cancelledAt) {
    r = await api(`/api/poskli/${runC}`, { method: 'DELETE' })
    ok('C: cancelamento aceito', r.status === 200 || r.status === 409, `status=${r.status}`)
    await sleep(6000)
    const d = await api(`/api/poskli/${runC}`)
    const run = d.data.run
    ok('C: estado final CANCELLED', run?.state === 'CANCELLED', `state=${run?.state}`)
    ok('C: cancelado NUNCA é CONCLUÍDO', run?.state !== 'COMPLETED')
    ok('C: sem derivação de sucesso pós-cancelamento', !run?.derived || run.derived.state !== 'SUCCESS', `derived=${run?.derived?.state ?? 'null'}`)
  }

  // ---------- limpeza ----------
  for (const p of [projectA, projectB, projectC]) {
    await api(`/api/projects/${p}?confirm=true`, { method: 'DELETE' }).catch(() => {})
  }
  console.log('(projetos de teste removidos)')

  console.log(`\nRESULTADO: ${passed} ✔ / ${failed} ✘`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error('ERRO FATAL:', e); process.exit(1) })
