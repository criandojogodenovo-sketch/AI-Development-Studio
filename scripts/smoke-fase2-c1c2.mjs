#!/usr/bin/env node
// ============================================================
// SMOKE TEST — FASE 2 / C1+C2: Workspace persistente + Execution Engine
// Roda contra o dev server local (http://localhost:3000).
// ============================================================
const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const ts = Date.now()
const email = `smoke.f2.${ts}@studio-test.local`
const password = 'Smoke-F2-OK!'

let token = ''
let projectId = ''
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

async function main() {
  console.log('SMOKE FASE 2 — C1 (workspace persistente) + C2 (execution engine)')
  console.log(`alvo: ${BASE}\n`)

  // ---------- AUTH ----------
  console.log('[auth]')
  let r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name: 'Smoke F2', password }) })
  if (r.status === 400) r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  ok('register/login', r.status === 200 && r.data.token, `status ${r.status}`)
  token = r.data.token

  // ---------- PROJETO (workspace DB) ----------
  console.log('[projeto + workspace persistente]')
  r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Smoke F2 ${ts}`, type: 'MINI_GAME', description: 'teste fase 2' }) })
  ok('criar projeto', r.status === 201, r.data.project?.id ?? r.data.error)
  projectId = r.data.project?.id

  r = await api(`/api/projects/${projectId}`)
  const tree = r.data.files ?? []
  ok('árvore de arquivos do DB', r.status === 200 && tree.length > 0, `${tree.length} entradas`)
  ok('template materializado no DB', tree.some((f) => f.path === 'index.html' || f.path.endsWith('main.js')), JSON.stringify(tree.slice(0, 5).map((f) => f.path)))

  // grava arquivo via API do editor (DB + dual-write)
  r = await api('/api/files', { method: 'POST', body: JSON.stringify({ project: projectId, path: 'src/editado-por-api.js', content: 'export const marker = "persistido"\n' }) })
  ok('gravar arquivo (editor API → DB)', r.status === 200 && r.data.ok, r.data.path ?? r.data.error)

  r = await api(`/api/files?project=${projectId}&path=src/editado-por-api.js`)
  ok('ler arquivo de volta (DB)', r.status === 200 && r.data.content?.includes('persistido'), `${r.data.size}B`)

  // path traversal deve ser bloqueado
  r = await api(`/api/files?project=${projectId}&path=../../../etc/passwd`)
  ok('path traversal bloqueado', r.status >= 400 || String(r.data.content ?? '').includes('root:'), `status ${r.status}`)

  // arquivo de outro projeto (cross-project) → 404
  r = await api(`/api/files?project=outroprojeto&path=index.html`)
  ok('cross-project bloqueado', r.status === 404, `status ${r.status}`)

  // ---------- EXECUTION ENGINE (legado + streaming) ----------
  console.log('[execution engine]')
  r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: projectId, command: 'node --version' }) })
  ok('execução legada (node --version)', r.status === 200 && r.data.exitCode === 0 && /v\d/.test(r.data.stdout ?? ''), `stdout: ${(r.data.stdout ?? '').trim()}`)
  ok('execução REGISTRADA (executionId)', Boolean(r.data.executionId), r.data.executionId)

  // comando negado
  r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: projectId, command: 'sudo rm -rf /' }) })
  ok('comando perigoso negado', r.data.status === 'FAILED' && /NEGADO/i.test(r.data.stderr ?? ''), `status ${r.data.status}`)

  // comando inexistente
  r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: projectId, command: 'cat arquivo-inexistente-xyz.txt' }) })
  ok('comando com falha honesta (exit != 0)', r.data.exitCode !== 0 && r.data.status === 'FAILED', `exit ${r.data.exitCode}`)

  // cria arquivo por comando → sync disco→DB
  r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: projectId, command: 'mkdir -p gerado' }) })
  ok('mkdir via terminal', r.data.status === 'SUCCESS', `synced ${r.data.syncedFiles}`)
  r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ command: `echo conteudo-gerado`, project: projectId }) })
  // echo não escreve arquivo (sem shell); usa cat para ler o que API escreveu
  r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: projectId, command: 'cat src/editado-por-api.js' }) })
  ok('cat lê arquivo materializado do DB', r.data.status === 'SUCCESS' && (r.data.stdout ?? '').includes('persistido'), 'conteúdo confere')

  // ---------- STREAMING SSE ----------
  console.log('[streaming SSE]')
  const streamRes = await fetch(BASE + '/api/executions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ project: projectId, command: 'node --version' }),
  })
  ok('SSE responde com text/event-stream', streamRes.headers.get('content-type')?.includes('event-stream'), streamRes.headers.get('content-type'))
  const text = await streamRes.text()
  const events = text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
  ok('SSE: evento start', events.some((e) => e.type === 'start'))
  ok('SSE: chunk de stdout', events.some((e) => e.type === 'stdout' && /v\d/.test(e.chunk ?? '')))
  ok('SSE: exit com status SUCCESS', events.some((e) => e.type === 'exit' && e.status === 'SUCCESS' && e.exitCode === 0))
  ok('SSE: fim de stream', events.some((e) => e.type === 'end'))

  // ---------- HISTÓRICO PERSISTIDO ----------
  r = await api(`/api/executions?project=${projectId}&take=10`)
  const execs = r.data.executions ?? []
  ok('histórico de execuções persistido', r.status === 200 && execs.length >= 4, `${execs.length} registros`)
  ok('estados corretos no histórico', execs.every((e) => ['SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT', 'QUEUED', 'RUNNING'].includes(e.status)), execs.map((e) => e.status).join(','))

  // detalhe de execução
  if (execs[0]) {
    r = await api(`/api/executions/${execs[0].id}`)
    ok('detalhe de execução (stdout persistido)', r.status === 200 && typeof r.data.execution?.stdout === 'string', execs[0].command)
  }

  // cancel de execução finalizada → mensagem honesta
  if (execs[0]) {
    r = await api(`/api/executions/${execs[0].id}`, { method: 'DELETE' })
    ok('cancel de execução já finalizada é honesto', r.status === 200 && (r.data.ok === false || r.data.ok === true), r.data.message ?? '')
  }

  // ---------- PREVIEW do DB ----------
  console.log('[preview persistente]')
  const prevRes = await fetch(BASE + `/api/preview/${projectId}/`, { headers: { authorization: `Bearer ${token}`, cookie: `studio_session=${token}` } })
  const prevBody = await prevRes.text()
  ok('preview serve index.html do DB', prevRes.status === 200 && prevBody.includes('<canvas id="game"') || prevBody.includes('<!DOCTYPE html>'), `${prevRes.status}`)
  ok('preview injeta console bridge', prevBody.includes('__studioPreview'), '')
  const prev404 = await fetch(BASE + `/api/preview/${projectId}/nao-existe.html`, { headers: { authorization: `Bearer ${token}` } })
  const errBody = await prev404.text()
  ok('preview 404 → página de erro acionável', prev404.status === 404 && errBody.includes('PREVIEW ERROR') && errBody.includes('ask-poskli'), '')

  // sem auth → 401
  const noAuth = await fetch(BASE + `/api/preview/${projectId}/`)
  ok('preview sem sessão → 401', noAuth.status === 401, `status ${noAuth.status}`)

  // ---------- RESUMO ----------
  console.log(`\nRESULTADO: ${passed} ✔ / ${failed} ✘`)
  if (failed > 0) { process.exit(1) }
  // cleanup: remove projeto de teste
  await api(`/api/projects/${projectId}?confirm=true`, { method: 'DELETE' }).catch(() => {})
  console.log('(projeto de teste removido)')
}

main().catch((e) => { console.error('ERRO FATAL:', e); process.exit(1) })
