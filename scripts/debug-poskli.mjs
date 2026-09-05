#!/usr/bin/env node
// Debug Poskli: executa run e inspeciona tarefas/agentRuns/erros ANTES do cleanup
const BASE = 'http://localhost:3000'
const ts = Date.now()
const email = `dbg.poskli.${ts}@studio-test.local`

async function api(path, init = {}, token) {
  const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, { ...init, headers })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name: 'Dbg', password: 'Dbg-OK-123!' }) })
  if (r.status === 400) r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'Dbg-OK-123!' }) })
  const token = r.data.token
  console.log('token ok')

  r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Dbg ${ts}`, type: 'MINI_GAME', description: 'debug' }), }, token)
  const projectId = r.data.project.id
  console.log('projectId', projectId)

  r = await api('/api/poskli/run', { method: 'POST', body: JSON.stringify({ project: projectId, request: 'Cria no arquivo src/vidas.js uma função contarVidas(inicial, perdidas) que retorna inicial - perdidas nunca negativo, e testes em test/vidas.test.js cobrindo 3-1=2, 5-7=0.' }) }, token)
  console.log('runId', r.data.runId, r.status)
  const runId = r.data.runId

  // espera terminal
  const active = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING']
  let run = null
  for (let i = 0; i < 90; i++) {
    await sleep(5000)
    r = await api(`/api/poskli/${runId}`, {}, token)
    run = r.data.run
    if (!active.includes(run?.state)) break
  }
  console.log('estado final:', run?.state)

  // inspeciona TAREFAS
  const d = await api(`/api/poskli/${runId}`, {}, token)
  console.log('\n===== TAREFAS =====')
  for (const t of d.data.tasks ?? []) {
    console.log(`- [${t.status}] #${t.order} ${t.title} (attempts ${t.attempts})`)
    if (t.error) console.log('  erro:', String(t.error).slice(0, 400))
    if (t.result) console.log('  result:', JSON.stringify(t.result).slice(0, 300))
  }

  // inspeciona EXECUÇÕES
  console.log('\n===== EXECUÇÕES (poskli) =====')
  for (const e of d.data.executions ?? []) {
    console.log(`- [${e.status}] ${e.command} exit=${e.exitCode}`)
    if (e.exitCode !== 0) console.log('  stderr:', String(e.stderr ?? '').slice(0, 400))
  }

  // inspeciona STAGES
  console.log('\n===== STAGES =====')
  for (const s of run?.stages ?? []) {
    console.log(`- ${s.stage} [${s.state}] ${(s.durationMs ?? 0) / 1000}s :: ${String(s.summary ?? '').slice(0, 300)}`)
  }

  // agentRuns do projeto
  const pr = await api(`/api/projects/${projectId}`, {}, token)
  console.log('\n===== AGENT RUNS =====')
  for (const ar of (pr.data.runs ?? []).slice(0, 12)) {
    console.log(`- [${ar.status}] ${ar.agentId}/${ar.runType} steps=${ar.steps} tokens=${ar.tokensIn + ar.tokensOut}`)
  }

  console.log('\n(Projeto mantido para inspeção:', projectId, ')')
  console.log('DELETE depois com: curl -X DELETE "' + BASE + '/api/projects/' + projectId + '?confirm=true" -H "authorization: Bearer ' + token + '"')
}
main().catch((e) => console.error('FATAL', e))
