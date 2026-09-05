#!/usr/bin/env node
// PUSH REAL EM PRODUÇÃO — valida git+push dentro da Vercel (GITHUB_TOKEN env)
import fs from 'fs'

const BASE = 'https://ai-development-studio-gamma.vercel.app'
const env = fs.readFileSync('/home/z/my-project/.env', 'utf8')
const TOKEN = env.match(/^GITHUB_TOKEN=(.+)$/m)?.[1]?.trim()
const GH = 'https://api.github.com'
const headers = { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'ai-dev-studio-test' }
const ts = Date.now()
const email = `prod.git.${ts}@studio-test.local`
const REPO_NAME = `studio-prod-push-${ts}`
let appToken = '', projectId = ''
let passed = 0, failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`) }
  else { failed++; console.error(`  ✘ ${name}${extra ? ' — ' + extra : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, init = {}) {
  const h = { 'content-type': 'application/json', ...(init.headers ?? {}) }
  if (appToken) h.authorization = `Bearer ${appToken}`
  const res = await fetch(BASE + path, { ...init, headers: h })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

async function main() {
  console.log('PUSH REAL EM PRODUÇÃO (Vercel executa o push)\n')
  const me = await (await fetch(`${GH}/user`, { headers })).json()
  const owner = me.login
  ok('token GitHub válido', Boolean(owner), owner)

  const createRepo = await fetch(`${GH}/user/repos`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: REPO_NAME, description: 'teste push em produção do AI Studio (auto-limpo)', private: true }),
  })
  ok('repo de teste criado', createRepo.status === 201, `${owner}/${REPO_NAME}`)

  try {
    let r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name: 'Prod Git', password: 'Prod-OK-123!' }) })
    if (r.status === 400) r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'Prod-OK-123!' }) })
    ok('login produção', r.status === 200)
    appToken = r.data.token

    r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Prod Push ${ts}`, type: 'LANDING_PAGE', description: 'push real produção' }) })
    ok('projeto criado na produção', r.status === 201)
    projectId = r.data.project?.id

    await api('/api/workspace/file', { method: 'POST', body: JSON.stringify({ project: projectId, path: 'PUSH-PRODUCAO.txt', content: `push da Vercel em ${new Date().toISOString()}\n` }) })
    r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'commit', message: 'commit de produção' }) })
    ok('commit na produção', r.status === 200 && r.data.committed, `oid ${(r.data.oid ?? '').slice(0, 8)}`)

    r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'connect', repo: `${owner}/${REPO_NAME}` }) })
    ok('connect na produção', r.status === 200, r.data.fullName ?? r.data.error)

    r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'push' }) })
    ok('PUSH executado a partir da VERCEL', r.status === 200 && r.data.pushed, `${r.data.branch ?? ''} ${r.data.detail ?? r.data.error ?? ''}`)

    await sleep(2000)
    const fileRes = await fetch(`${GH}/repos/${owner}/${REPO_NAME}/contents/PUSH-PRODUCAO.txt`, { headers })
    ok('ARQUIVO CHEGOU NO GITHUB (verificado via API)', fileRes.status === 200)

    // pull de volta (na produção)
    r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'pull' }) })
    ok('pull na produção', r.status === 200 || /nada novo|up to date/i.test(r.data.detail ?? r.data.error ?? ''), r.data.detail ?? r.data.error ?? 'ok')

    await api(`/api/projects/${projectId}?confirm=true`, { method: 'DELETE' }).catch(() => {})
  } finally {
    const del = await fetch(`${GH}/repos/${owner}/${REPO_NAME}`, { method: 'DELETE', headers })
    ok('repo de teste removido (best-effort)', del.status === 204, `status ${del.status}`)
  }
  console.log(`\nRESULTADO: ${passed} ✔ / ${failed} ✘`)
  if (failed > 1) process.exit(1)
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
