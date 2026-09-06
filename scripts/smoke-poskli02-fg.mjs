#!/usr/bin/env node
// SMOKE POSKLI 0.2 — cenários em FOREGROUND (um por invocação)
// Uso: node scripts/smoke-poskli02-fg.mjs <A|B|C>
const SCENARIO = (process.argv[2] ?? 'A').toUpperCase()
const BASE = process.env.BASE_URL ?? 'https://ai-development-studio-gamma.vercel.app'
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
const displayOf = (g) => (g === 'SUCCESS' ? 'COMPLETED' : g)

function validateMachine(run, label) {
  const d = run?.derived
  console.log(`\n  [máquina — ${label}] state=${run?.state} · derived=${d?.state ?? 'null'} · errorCode=${run?.errorCode ?? '—'}`)
  ok(`${label}: run terminal`, Boolean(run && TERMINAL.includes(run.state)))
  ok(`${label}: derivação persistida`, Boolean(d && d.state))
  if (!d) return
  ok(`${label}: exibido = derivação`, run.state === displayOf(d.state), `${run.state} vs ${displayOf(d.state)}`)
  ok(`${label}: conservadora`, d.conservative === true)
  const criteria = d.criteria ?? []
  ok(`${label}: 6 critérios`, criteria.length === 6, criteria.map((c) => `${c.id}:${c.status}`).join(' '))
  const allPass = criteria.every((c) => c.status === 'PASS')
  const anyFail = criteria.some((c) => c.status === 'FAIL')
  if (d.state === 'SUCCESS') ok(`${label}: SUCCESS exige todos PASS`, allPass)
  if (d.state === 'FAILED') ok(`${label}: FAILED justificado (≥1 FAIL)`, anyFail)
  if (d.state === 'BLOCKED' || d.state === 'PARTIAL') ok(`${label}: sem todos-PASS`, !allPass)
  ok(`${label}: COMPLETED ⇔ SUCCESS`, (run.state === 'COMPLETED') === (d.state === 'SUCCESS'))
  ok(`${label}: COMPLETED exige testes verdes`, run.state !== 'COMPLETED' || run.testsPassed === true)
  const c = d.counters
  if (c) ok(`${label}: 0/N jamais SUCCESS`, !(c.tasks.completed < c.tasks.total && d.state === 'SUCCESS'), `${c.tasks.completed}/${c.tasks.total}`)
  const tr = run.testRecords ?? []
  ok(`${label}: testes com identidade única`, new Set(tr.map((t) => t.id)).size === tr.length, `${tr.length} registro(s), último=${tr[tr.length - 1]?.status ?? '—'}`)
  const corr = run.corrections ?? []
  ok(`${label}: correções com estado individual`, corr.every((x) => ['PLANNED', 'STARTED', 'COMPLETED', 'FAILED', 'BLOCKED'].includes(x.state)), corr.map((x) => `${x.attempt}:${x.state}`).join(' ') || '0')
  ok(`${label}: snapshot de revisão`, Boolean(run.reviewResult?.status), `status=${run.reviewResult?.status}${run.reviewResult?.blockedReason ? ` motivo=${run.reviewResult.blockedReason}` : ''}`)
  ok(`${label}: markdown da mesma fonte`, Boolean(run.result?.includes('Resultado do Poskli')))
  if (d.state !== 'SUCCESS') {
    const lbl = { FAILED: 'Falhou', BLOCKED: 'Bloqueado', PARTIAL: 'Parcial', CANCELLED: 'Cancelado' }[d.state] ?? d.state
    ok(`${label}: markdown reflete estado real`, run.result?.includes(`**Estado:** ${lbl}`) ?? false, `espera "**Estado:** ${lbl}"`)
  }
}

async function main() {
  console.log(`SMOKE POSKLI 0.2 — CENÁRIO ${SCENARIO} (foreground)`)
  console.log(`alvo: ${BASE}\n`)

  const email = `smoke.p02${SCENARIO}.${ts}@studio-test.local`
  let r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name: 'Smoke 02', password }) })
  if (r.status === 400) r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  token = r.data.token ?? ''
  ok('login', Boolean(token), `status=${r.status}`)
  if (!token) process.exit(1)

  let projectId = ''
  let runId = ''

  if (SCENARIO === 'A' || SCENARIO === 'B') {
    const isA = SCENARIO === 'A'
    r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `C${SCENARIO} 0.2 ${ts}`, type: isA ? 'MINI_GAME' : 'EMPTY_PROJECT', description: `smoke 0.2 cenário ${SCENARIO}` }) })
    ok(`${SCENARIO}: criar projeto`, r.status === 201)
    projectId = r.data.project?.id

    if (!isA) {
      r = await api('/api/files', { method: 'POST', body: JSON.stringify({
        project: projectId, path: 'test/fixo.test.js',
        content: "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fixo e inalterável: 1+1 deve ser 3', () => {\n  assert.equal(1 + 1, 3, 'este teste falha POR CONSTRUÇÃO e não deve ser alterado')\n})\n",
      }) })
      ok('B: teste impossível pré-criado', r.status === 200 || r.status === 201, `status=${r.status}`)
    }

    const request = isA
      ? 'Cria no arquivo src/vidas.js uma função contarVidas(inicial, perdidas) que retorna inicial - perdidas (nunca negativo, mínimo 0), exporta com ESM, e cria testes em test/vidas.test.js com node:test cobrindo: 3-1=2, 5-7=0 e 0-0=0.'
      : 'Implemente src/calculo.js com função dobro(n) retornando n*2 (ESM). IMPORTANTE: o arquivo test/fixo.test.js é um teste de regressão FIXO e INALTERÁVEL — nunca modifique, apague ou reescreva test/fixo.test.js.'
    r = await api('/api/poskli/run', { method: 'POST', body: JSON.stringify({ project: projectId, request, maxIterations: isA ? 3 : 1 }) })
    ok(`${SCENARIO}: Poskli iniciado (202)`, r.status === 202 && r.data.runId, r.data.error ?? r.data.message)
    runId = r.data.runId

    console.log(`\n[aguardando — poll 5s, máx 8 min]`)
    const deadline = Date.now() + 8 * 60 * 1000
    const seen = new Set()
    let run = null
    while (Date.now() < deadline) {
      const d = await api(`/api/poskli/${runId}`)
      run = d.data.run
      if (run?.state && !seen.has(run.state)) { seen.add(run.state); console.log(`    · ${run.state}`) }
      if (run?.state && !ACTIVE.includes(run.state)) break
      await sleep(5000)
    }
    const detail = (await api(`/api/poskli/${runId}`)).data
    run = detail.run
    if (!run || ACTIVE.includes(run.state)) {
      ok(`${SCENARIO}: terminal em 8 min`, false, `state=${run?.state}`)
    } else {
      validateMachine(run, SCENARIO)
      const testRecords = run.testRecords ?? []
      const lastTest = testRecords[testRecords.length - 1]
      if (SCENARIO === 'B' && lastTest?.status === 'FAIL') {
        ok('B: §10 — testes vermelhos JAMAIS CONCLUÍDO', run.state !== 'COMPLETED', `state=${run.state} · último teste ${lastTest.status}`)
      }
      ok(`${SCENARIO}: execuções reais no engine`, (detail.executions ?? []).length >= 1, `${(detail.executions ?? []).map((e) => `${e.command}→${e.exitCode}`).join(' | ')}`)
    }
  }

  if (SCENARIO === 'C') {
    r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `C 0.2 ${ts}`, type: 'MINI_GAME', description: 'smoke cancelamento' }) })
    ok('C: criar projeto', r.status === 201)
    projectId = r.data.project?.id
    r = await api('/api/poskli/run', { method: 'POST', body: JSON.stringify({ project: projectId, request: 'Cria um jogo de esquivar obstáculos com pontuação e testes automatizados.' }) })
    ok('C: Poskli iniciado (202)', r.status === 202 && r.data.runId, r.data.error ?? r.data.message)
    runId = r.data.runId

    let cancelledAt = null
    for (let i = 0; i < 30; i++) {
      const d = await api(`/api/poskli/${runId}`)
      if (d.data.run?.state && ACTIVE.includes(d.data.run.state)) { cancelledAt = d.data.run.state; break }
      await sleep(3000)
    }
    ok('C: run ativo detectado', Boolean(cancelledAt), `durante ${cancelledAt ?? '—'}`)
    if (cancelledAt) {
      r = await api(`/api/poskli/${runId}`, { method: 'DELETE' })
      ok('C: cancelamento aceito', r.status === 200 || r.status === 409, `status=${r.status}`)
      await sleep(8000)
      const run = (await api(`/api/poskli/${runId}`)).data.run
      ok('C: estado final CANCELLED', run?.state === 'CANCELLED', `state=${run?.state}`)
      ok('C: cancelado NUNCA é CONCLUÍDO', run?.state !== 'COMPLETED')
      ok('C: sem derivação de sucesso pós-cancelamento', !run?.derived || run.derived.state !== 'SUCCESS', `derived=${run?.derived?.state ?? 'null'}`)
    }
  }

  // limpeza
  if (projectId) await api(`/api/projects/${projectId}?confirm=true`, { method: 'DELETE' }).catch(() => {})
  console.log(`\nRESULTADO ${SCENARIO}: ${passed} ✔ / ${failed} ✘`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error('ERRO FATAL:', e); process.exit(1) })
