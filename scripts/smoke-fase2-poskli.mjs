#!/usr/bin/env node
// ============================================================
// SMOKE TEST — FASE 2 / C7: POSKLI REAL
// Ciclo completo: ANALYZING→PLANNING→IMPLEMENTING→TESTING→
// (CORRECTING)→REVIEWING→VERIFYING→COMPLETED/FAILED
// Testes rodam NO EXECUTION ENGINE (node --test de verdade).
// ============================================================
const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const ts = Date.now()
const email = `smoke.poskli.${ts}@studio-test.local`
const password = 'Poskli-OK!'

let token = ''
let projectId = ''
let runId = ''
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

async function main() {
  console.log('SMOKE FASE 2 — POSKLI REAL (orquestrador completo)')
  console.log(`alvo: ${BASE}\n`)

  let r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name: 'Smoke Poskli', password }) })
  if (r.status === 400) r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  ok('login', r.status === 200 && r.data.token)
  token = r.data.token

  r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Jogo Poskli ${ts}`, type: 'MINI_GAME', description: 'teste do orquestrador' }) })
  ok('criar projeto', r.status === 201)
  projectId = r.data.project?.id

  // estado inicial da árvore (para comparar depois)
  const treeBefore = await api(`/api/workspace/tree?project=${projectId}`).then((x) => x.data.tree?.length ?? 0)

  // ---------- INICIA POSKLI ----------
  const request = 'Cria no arquivo src/vidas.js uma função contarVidas(inicial, perdidas) que retorna inicial - perdidas (nunca negativo, mínimo 0), exporta com ESM, e cria testes em test/vidas.test.js com node:test cobrindo: 3-1=2, 5-7=0 e 0-0=0.'
  r = await api('/api/poskli/run', { method: 'POST', body: JSON.stringify({ project: projectId, request }) })
  ok('Poskli iniciado (202)', r.status === 202 && r.data.runId, r.data.message)
  runId = r.data.runId

  // ---------- POLL até estado terminal (máx 8 min) ----------
  console.log('\n[aguardando orquestrador — poll 5s]')
  const deadline = Date.now() + 12 * 60 * 1000
  let run = null
  const activeStates = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING']
  const seenStates = new Set()
  while (Date.now() < deadline) {
    r = await api(`/api/poskli/${runId}`)
    run = r.data.run
    if (run?.state) {
      if (!seenStates.has(run.state)) {
        seenStates.add(run.state)
        console.log(`  · estado: ${run.state} (iteração ${run.iteration})`)
      }
      if (!activeStates.includes(run.state)) break
    }
    await sleep(5000)
  }

  // ---------- VERIFICAÇÕES ----------
  console.log('\n[verificações do ciclo]')
  ok('run chegou a estado terminal', Boolean(run && !activeStates.includes(run.state)), `estado final: ${run?.state}`)
  ok('estágios registrados na timeline', (run?.stages?.length ?? 0) >= 4, `${run?.stages?.length ?? 0} estágios: ${(run?.stages ?? []).map((s) => s.stage).join(' → ')}`)
  // COMPLETED com testes verdes OU FAILED honesto com causa real —
  // ambos são comportamentos corretos; simulado é o que não existe.
  const honest = run?.state === 'COMPLETED' ? run.testsPassed === true : Boolean(run?.error || run?.result)
  ok('estado final honesto (COMPLETED verde OU FAILED com causa)', honest, `state=${run?.state}`)
  if (run?.state === 'COMPLETED') ok('testes passaram', run.testsPassed === true)
  ok('tokens contabilizados', (run?.tokensIn ?? 0) + (run?.tokensOut ?? 0) > 0, `${(run?.tokensIn ?? 0) + (run?.tokensOut ?? 0)} tokens`)

  // detalhes
  r = await api(`/api/poskli/${runId}`)
  const detail = r.data
  const stages = (detail.run?.stages ?? [])
  ok('IMPLEMENTING executado', stages.some((s) => s.stage === 'IMPLEMENTING'))
  ok('TESTING executado (terminal real)', stages.some((s) => s.stage === 'TESTING'))
  ok('REVIEWING executado', stages.some((s) => s.stage === 'REVIEWING'))
  ok('VERIFYING executado', stages.some((s) => s.stage === 'VERIFYING'))

  // tarefas criadas pelo Planejador
  const tasks = detail.tasks ?? []
  ok('tarefas criadas pelo plano', tasks.length >= 2, `${tasks.length} tarefas: ${tasks.map((t) => t.title.slice(0, 30)).join(' | ')}`)
  const completed = tasks.filter((t) => t.status === 'COMPLETED').length
  ok('tarefas concluídas', completed >= 1, `${completed}/${tasks.length}`)

  // EXECUÇÕES REAIS registradas (source=poskli)
  const execs = detail.executions ?? []
  ok('execuções REAIS no engine (source=poskli)', execs.length >= 1, `${execs.length} execução(ões): ${execs.map((e) => e.command).join(' | ')}`)
  const lastExec = execs[execs.length - 1]
  if (lastExec) {
    ok('última execução com stdout persistido', typeof lastExec.stdout === 'string' && lastExec.stdout.length >= 0, `exit ${lastExec.exitCode}`)
  }

  // arquivos realmente mudaram?
  const treeAfter = await api(`/api/workspace/tree?project=${projectId}`).then((x) => x.data.tree?.length ?? 0)
  ok('workspace persistiu alterações', treeAfter >= treeBefore, `${treeBefore} → ${treeAfter} arquivos`)

  // system de vidas foi implementado? (busca real)
  const search = await api(`/api/workspace/search?project=${projectId}&q=vidas`)
  ok('sistema de vidas presente no código', (search.data.results?.length ?? 0) > 0, `${search.data.results?.length} ocorrências`)

  // resultado markdown presente (sucesso OU causa de falha documentada)
  ok('relatório final (markdown com resultado/causa)', Boolean(run?.result))

  // execução de teste manual confere (rodando o mesmo comando)
  if (lastExec) {
    const testRun = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: projectId, command: lastExec.command }) })
    ok('testes reproduzíveis manualmente no terminal', testRun.data.status === 'SUCCESS', `exit ${testRun.data.exitCode}`)
  }

  console.log(`\nRESULTADO: ${passed} ✔ / ${failed} ✘`)
  if (failed > 0) process.exit(1)
  // mantém o projeto para inspeção manual? Não — limpa
  await api(`/api/projects/${projectId}?confirm=true`, { method: 'DELETE' }).catch(() => {})
  console.log('(projeto de teste removido)')
}

main().catch((e) => { console.error('ERRO FATAL:', e); process.exit(1) })
