#!/usr/bin/env node
// ============================================================
// SMOKE TEST — FASE 2 / C3..C8: Workspace API, Editor (assets),
// Git real, Diagnostics, shell de navegação
// ============================================================
const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const ts = Date.now()
const email = `smoke.f2b.${ts}@studio-test.local`
const password = 'Smoke-F2B-OK!'

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
  console.log('SMOKE FASE 2 — C3..C8 (workspace API, editor, git, diagnostics)')
  console.log(`alvo: ${BASE}\n`)

  // ---------- AUTH + PROJETO ----------
  let r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name: 'Smoke F2B', password }) })
  if (r.status === 400) r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  ok('login', r.status === 200 && r.data.token)
  token = r.data.token

  r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `Smoke F2B ${ts}`, type: 'MINI_GAME', description: 'teste C3-C8' }) })
  ok('criar projeto', r.status === 201)
  projectId = r.data.project?.id

  // ---------- C3: WORKSPACE API ----------
  console.log('[C3 — workspace API]')
  r = await api(`/api/workspace/tree?project=${projectId}`)
  ok('tree', r.status === 200 && r.data.tree?.length > 0, `${r.data.tree?.length} entradas`)

  r = await api('/api/workspace/file', { method: 'POST', body: JSON.stringify({ project: projectId, path: 'src/util.js', content: 'export const soma = (a, b) => a + b\n' }) })
  ok('criar arquivo', r.status === 200 && r.data.ok, r.data.bytes + 'B')

  r = await api(`/api/workspace/file?project=${projectId}&path=src/util.js`)
  ok('ler arquivo', r.status === 200 && r.data.content?.includes('soma'))

  r = await api('/api/workspace/dir', { method: 'POST', body: JSON.stringify({ project: projectId, path: 'src/nova-pasta' }) })
  ok('criar pasta', r.status === 200)

  r = await api('/api/workspace/rename', { method: 'POST', body: JSON.stringify({ project: projectId, from: 'src/util.js', to: 'src/nova-pasta/util2.js' }) })
  ok('renomear/mover', r.status === 200 && r.data.moved >= 1)

  r = await api(`/api/workspace/search?project=${projectId}&q=soma`)
  ok('busca', r.status === 200 && r.data.results?.length > 0, `${r.data.results?.length} hits`)

  // snapshot + restore
  r = await api('/api/workspace/snapshot', { method: 'POST', body: JSON.stringify({ project: projectId, label: 'antes-de-deletar' }) })
  ok('snapshot criado', r.status === 201 && r.data.id, `${r.data.fileCount} arquivos`)
  const snapId = r.data.id

  r = await api(`/api/workspace/entry?project=${projectId}&path=src/nova-pasta/util2.js`, { method: 'DELETE' })
  ok('remover arquivo', r.status === 200 && r.data.removed === 1)

  r = await api('/api/workspace/snapshot/restore', { method: 'POST', body: JSON.stringify({ project: projectId, snapshotId: snapId }) })
  ok('restaurar snapshot', r.status === 200 && r.data.restored > 0)

  // segurança
  r = await api(`/api/workspace/file?project=${projectId}&path=../../etc/passwd`)
  ok('workspace traversal bloqueado', r.status === 403 || r.status === 400, `status ${r.status}`)
  r = await api('/api/workspace/file', { method: 'POST', body: JSON.stringify({ project: projectId, path: 'malicioso.env', content: 'x' }) })
  ok('extensão bloqueada (.env)', r.status === 403, `status ${r.status}`)
  r = await api('/api/workspace/file', { method: 'POST', body: JSON.stringify({ project: projectId, path: '.git/config', content: 'x' }) })
  ok('.git bloqueado para usuário', r.status === 403, `status ${r.status}`)

  // ---------- C3: EDITOR ASSETS ----------
  console.log('[C3 — editor assets locais]')
  const monacoLoader = await fetch(BASE + '/monaco/vs/loader.js')
  ok('monaco loader.js local', monacoLoader.status === 200, `${monacoLoader.headers.get('content-type')}`)
  const monacoEditor = await fetch(BASE + '/monaco/vs/editor/editor.main.js')
  ok('monaco editor.main.js local', monacoEditor.status === 200)

  // página renderiza (shell novo)
  const page = await fetch(BASE + '/')
  const html = await page.text()
  ok('shell renderiza', page.status === 200 && html.length > 1000, `${html.length} chars`)

  // ---------- C6: GIT REAL ----------
  console.log('[C6 — git real (isomorphic-git)]')
  r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'init' }) })
  ok('git init', r.status === 200 && r.data.initialized === true)

  r = await api(`/api/git?project=${projectId}`)
  ok('git status (não inicializado pós-init → branch main)', r.status === 200 && r.data.status, `branch: ${r.data.status?.branch}`)

  r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'commit', message: 'commit inicial do smoke' }) })
  ok('git commit', r.status === 200 && r.data.committed === true, `oid ${(r.data.oid ?? '').slice(0, 8)}`)

  r = await api(`/api/git?project=${projectId}`)
  ok('git status pós-commit (limpo)', r.status === 200 && r.data.status?.changes?.length === 0, `${r.data.status?.commits?.length} commits`)
  ok('git log', (r.data.status?.commits?.length ?? 0) >= 1, r.data.status?.commits?.[0]?.message)

  // arquivo novo → mudança detectada + diff
  await api('/api/workspace/file', { method: 'POST', body: JSON.stringify({ project: projectId, path: 'src/modificado.js', content: 'console.log("novo")\n' }) })
  r = await api(`/api/git?project=${projectId}`)
  ok('mudança detectada', (r.data.status?.changes?.length ?? 0) >= 1, r.data.status?.changes?.map((c) => `${c.path}:${c.status}`).join(','))
  r = await api(`/api/git?project=${projectId}&diff=`)
  ok('git diff working vs HEAD', r.status === 200 && String(r.data.diff ?? '').includes('+'), 'diff com adição')

  // branch + checkout
  r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'branch', name: 'feature/teste' }) })
  ok('git branch', r.status === 200 && r.data.branch === 'feature/teste')
  r = await api('/api/git', { method: 'POST', body: JSON.stringify({ project: projectId, action: 'checkout', name: 'feature/teste' }) })
  ok('git checkout', r.status === 200 && r.data.branch === 'feature/teste')

  // git persistido no DB (arquivos .git/*)
  r = await api(`/api/workspace/tree?project=${projectId}&max=1000`)
  // .git é filtrado da tree por design — verifica via status após "re-materialização" implícita
  ok('tree sem .git (por design)', !(r.data.tree ?? []).some((t) => t.path.startsWith('.git/')))

  // ---------- DIAGNOSTICS ----------
  console.log('[C8 — diagnostics]')
  r = await api('/api/diagnostics')
  ok('diagnostics responde', r.status === 200 && r.data.validation, `db: ${r.data.validation?.database}`)
  ok('diagnostics agentes', (r.data.agents?.length ?? 0) >= 5)
  ok('diagnostics ferramentas', (r.data.tools?.length ?? 0) >= 10, `${r.data.tools?.length} tools`)
  ok('diagnostics execuções agregadas', Array.isArray(r.data.executions))

  // sem auth
  const noAuth = await fetch(BASE + `/api/workspace/tree?project=${projectId}`)
  ok('workspace sem sessão → 401', noAuth.status === 401)

  console.log(`\nRESULTADO: ${passed} ✔ / ${failed} ✘`)
  if (failed > 0) process.exit(1)
  await api(`/api/projects/${projectId}?confirm=true`, { method: 'DELETE' }).catch(() => {})
  console.log('(projeto de teste removido)')
}

main().catch((e) => { console.error('ERRO FATAL:', e); process.exit(1) })
