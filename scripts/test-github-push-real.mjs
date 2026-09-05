#!/usr/bin/env node
// ============================================================
// TESTE REAL — GIT/GITHUB INTEGRATION
// 1. cria repo de teste via API (com token, nunca impresso)
// 2. projeto no Studio + arquivos + git init + commit
// 3. connect + push (isomorphic-git dentro do app)
// 4. VERIFICA via API GitHub que o commit chegou
// 5. limpa: remove repo de teste
// ============================================================
import fs from 'fs'

const BASE = 'http://localhost:3000'
const env = fs.readFileSync('/home/z/my-project/.env', 'utf8')
const TOKEN = env.match(/^GITHUB_TOKEN=(.+)$/m)?.[1]?.trim()
if (!TOKEN) { console.error('GITHUB_TOKEN ausente no .env'); process.exit(1) }

const GH = 'https://api.github.com'
const headers = { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'ai-dev-studio-test' }
const ts = Date.now()
const email = `smoke.git.${ts}@studio-test.local`
const REPO_NAME = `studio-push-test-${ts}`

let appToken = ''
let projectId = ''
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
  console.log('TESTE REAL — PUSH/PULL GITHUB (repo temporário)\n')

  // 0. usuário do token
  const me = await (await fetch(`${GH}/user`, { headers })).json()
  ok('token GitHub válido', Boolean(me.login), `conta: ${me.login}`)
  const owner = me.login

  // 1. registra no app
  let r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name: 'Smoke Git', password: 'Git-OK-123!' }) })
  if (r.status === 400) r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'Git-OK-123!' }) })
  ok('login app', r.status === 200 && r.data.token)
  appToken = r.data.token

  // 2. cria repo de teste no GitHub
  const createRepo = await fetch(`${GH}/user/repos`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: REPO_NAME, description: 'teste de push do AI Development Studio (auto-limpo)', private: true, auto_init: false }),
  })
  const repoData = await createRepo.json().catch(() => ({}))
  ok('repo de teste criado no GitHub', createRepo.status === 201, `${repoData.full_name ?? createRepo.status}`)

  try {
    // 3. projeto no app com conteúdo
    r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Push Test ${ts}`, type: 'LANDING_PAGE', description: 'teste push real' }) })
    ok('projeto criado', r.status === 201)
    projectId = r.data.project?.id

    r = await api('/api/workspace/file', { method: 'POST', body: JSON.stringify({ project: projectId, path: 'VEIADO-PUSH.txt', content: `push real do studio em ${new Date().toISOString()}\n` }) })
    ok('arquivo marcador criado', r.status === 200)

    // 4. git init + commit + connect + push via APIs do app
    r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'init' }) })
    ok('git init', r.status === 200)
    r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'commit', message: 'commit real do teste de push' }) })
    ok('git commit local', r.status === 200 && r.data.committed, `oid ${(r.data.oid ?? '').slice(0, 8)}`)

    r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'connect', repo: `${owner}/${REPO_NAME}` }) })
    ok('connect repo', r.status === 200 && r.data.fullName === `${owner}/${REPO_NAME}`, r.data.fullName ?? r.data.error)

    r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'push' }) })
    ok('PUSH REAL executou', r.status === 200 && r.data.pushed, `${r.data.branch} — ${r.data.detail ?? r.data.error ?? ''}`)
    const pushedBranch = r.data.branch

    // 5. VERIFICAÇÃO REAL via API GitHub
    await sleep(2000) // eventual consistência
    const branchRes = await fetch(`${GH}/repos/${owner}/${REPO_NAME}/branches/${pushedBranch}`, { headers })
    ok('branch existe no GitHub (verificado via API)', branchRes.status === 200, pushedBranch)
    if (branchRes.status === 200) {
      const branch = await branchRes.json()
      ok('commit presente no GitHub', Boolean(branch.commit?.sha), branch.commit?.sha?.slice(0, 8))
      // conteúdo do arquivo no GitHub?
      const fileRes = await fetch(`${GH}/repos/${owner}/${REPO_NAME}/contents/VEIADO-PUSH.txt?ref=${pushedBranch}`, { headers })
      ok('arquivo marcador presente no GitHub', fileRes.status === 200)
      if (fileRes.status === 200) {
        const file = await fileRes.json()
        const content = Buffer.from(file.content ?? '', 'base64').toString('utf8')
        ok('conteúdo do arquivo confere', content.includes('push real do studio'))
      }
      // nenhum token no conteúdo? (sanitização)
      ok('nenhum token vazou no push', !content_has_token(JSON.stringify(branch)))
    }

    // 6. PULL REAL: clona o repo em OUTRO projeto e confere o marcador
    r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Pull Test ${ts}`, type: 'EMPTY_PROJECT', description: 'teste pull' }) })
    const projectId2 = r.data.project?.id
    r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId2, action: 'clone', repo: `${owner}/${REPO_NAME}` }) })
    ok('CLONE REAL importou repo', r.status === 200 && (r.data.files ?? 0) > 0, `${r.data.files} arquivos`)

    r = await api(`/api/workspace/tree?project=${projectId2}`)
    ok('arquivo marcador visível no clone', (r.data.tree ?? []).some((f) => f.path === 'VEIADO-PUSH.txt'))

    // 7. limpeza dos projetos de teste
    await api(`/api/projects/${projectId}?confirm=true`, { method: 'DELETE' }).catch(() => {})
    await api(`/api/projects/${projectId2}?confirm=true`, { method: 'DELETE' }).catch(() => {})
  } finally {
    // 8. DELETA o repo de teste (sempre)
    const del = await fetch(`${GH}/repos/${owner}/${REPO_NAME}`, { method: 'DELETE', headers })
    ok('repo de teste removido (limpeza)', del.status === 204, `status ${del.status}`)
  }

  console.log(`\nRESULTADO: ${passed} ✔ / ${failed} ✘`)
  if (failed > 0) process.exit(1)
}

function content_has_token(text) {
  return /gh[pousr]_[A-Za-z0-9]{20,}/.test(text)
}

main().catch((e) => { console.error('ERRO FATAL:', e.message); process.exit(1) })
