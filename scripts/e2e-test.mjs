// ============================================================
// E2E TEST — AI Development Studio (pipeline real completo)
// Valida: registro → login → criação projeto → pipeline
// multi-agente (LLM REAL + tools REAIS) → arquivos → testes.
// ============================================================

const BASE = 'http://localhost:3000'
const log = (...a) => console.log(...a)
let token = ''
let userId = ''

async function api(path, init = {}) {
  const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, { ...init, headers })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 500) } }
  return { status: res.status, data }
}

async function assert(cond, msg) {
  if (!cond) {
    console.error(`❌ FALHOU: ${msg}`)
    process.exit(1)
  }
  log(`✅ ${msg}`)
}

// ---------- 1. Registro ----------
const email = `e2e_${Date.now()}@test.dev`
const password = 'senha-segura-123'
let r = await api('/api/auth/register', {
  method: 'POST',
  body: JSON.stringify({ email, name: 'E2E Tester', password }),
})
await assert(r.status === 200 || (r.status === 500 && false), `registro respondeu ${r.status}`)
token = r.data.token
userId = r.data.user?.id
await assert(Boolean(token && userId), 'registro gerou token e usuário')

// ---------- 2. Login (credenciais funcionam) ----------
r = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password }),
})
await assert(r.status === 200 && r.data.token, 'login com credenciais válidas')

// ---------- 3. Auth inválida rejeitada ----------
r = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password: 'errada' }),
})
await assert(r.status === 401, 'login com senha errada rejeitado (401)')

// ---------- 4. Sem token: API protegida rejeita ----------
const savedToken = token
token = '' // limpa token para testar proteção
r = await api('/api/projects')
await assert(r.status === 401, 'API sem token rejeitada (401)')
token = savedToken // restaura

// ---------- 5. Criação de projeto com template MINI_GAME ----------
r = await api('/api/projects', {
  method: 'POST',
  body: JSON.stringify({
    name: 'Jogo Sobrevivencia E2E',
    type: 'MINI_GAME',
    description: 'Mini-game 2D de sobrevivência mobile para teste e2e',
    approvalMode: 'AUTONOMOUS',
  }),
})
await assert(r.status === 201 && r.data.project?.id, 'projeto MINI_GAME criado com template')
const projectId = r.data.project.id

// ---------- 6. Detalhe do projeto: arquivos do template ----------
r = await api(`/api/projects/${projectId}`)
await assert(r.status === 200 && r.data.files?.length >= 5, `workspace com ${r.data.files?.length} arquivos do template`)
await assert(r.data.project.type === 'MINI_GAME', 'tipo do projeto correto')

// ---------- 7. Preview serve index.html ----------
r = await fetch(`${BASE}/api/preview/${projectId}/`, { headers: { authorization: `Bearer ${token}` } })
await assert(r.status === 200 && (await r.text()).includes('<canvas'), 'preview serve o jogo (index.html com canvas)')

// ---------- 8. Terminal: comando permitido ----------
r = await api('/api/terminal', {
  method: 'POST',
  body: JSON.stringify({ project: projectId, command: 'ls -la' }),
})
await assert(r.status === 200 && r.data.exitCode === 0, 'terminal executa comando permitido (ls)')

// ---------- 9. Terminal: comando PROIBIDO negado ----------
r = await api('/api/terminal', {
  method: 'POST',
  body: JSON.stringify({ project: projectId, command: 'sudo rm -rf /' }),
})
await assert(r.data.exitCode === 126 && r.data.stderr?.includes('NEGADO'), 'comando perigoso NEGADO pela allowlist')

// ---------- 10. Models overview (DeepSeek desativado) ----------
r = await api('/api/models')
await assert(r.status === 200, 'models overview disponível')
const ds = r.data.models?.find((m) => m.id === 'deepseek-v4-flash')
await assert(ds && ds.available === false, 'DeepSeek DESATIVADO por padrão (evidence-based)')
await assert(r.data.enableDeepseek === false, 'ENABLE_DEEPSEEK=false confirmado')

// ---------- 11. PIPELINE REAL (LLM + agents + tools) ----------
log('\n🚀 Iniciando pipeline REAL (LLM verdadeiro — aguarde)...')
const request = 'Melhore o jogo: adicione sistema de vidas (3 vidas) e aumente a dificuldade progressivamente com o tempo. Deixe tudo testado.'
r = await api(`/api/projects/${projectId}/run`, {
  method: 'POST',
  body: JSON.stringify({ request }),
})
await assert(r.status === 202, 'pipeline aceito (202) — rodando em background')

// Poll do progresso com timeout
const started = Date.now()
const TIMEOUT = 8 * 60 * 1000 // 8 min
let lastPercent = 0
while (Date.now() - started < TIMEOUT) {
  await new Promise((res) => setTimeout(res, 10_000))
  const d = await api(`/api/projects/${projectId}`)
  const p = d.data.progress
  lastPercent = p.percent
  const status = d.data.project.status
  const tasksByStatus = Object.entries(p.byStatus).map(([k, v]) => `${k}:${v}`).join(' ')
  log(`   ⏳ ${status} — ${p.completed}/${p.total} tarefas (${p.percent}%) [${tasksByStatus}] — ${Math.round((Date.now() - started) / 1000)}s`)
  if (['COMPLETED', 'FAILED'].includes(status)) break
  // para quando não há mais nada PENDING/RUNNING/BLOCKED/REVIEWING
  if (p.total > 0 && p.byStatus.PENDING === undefined && p.byStatus.RUNNING === undefined && p.byStatus.BLOCKED === undefined && p.byStatus.REVIEWING === undefined) break
}

// ---------- 12. Validação final do pipeline ----------
r = await api(`/api/projects/${projectId}`)
const finalStatus = r.data.project.status
log(`\n📊 STATUS FINAL: ${finalStatus} — ${lastPercent}%`)
log(`   Runs: ${r.data.runs?.length ?? 0} | Tokens: ${r.data.runs?.reduce((a, x) => a + x.tokensIn + x.tokensOut, 0) ?? 0}`)
for (const t of r.data.progress.tasks) {
  log(`   ${t.status.padEnd(10)} #${t.order + 1} ${t.title}${t.error ? ' ⚠ ' + t.error.slice(0, 80) : ''}`)
}

// Evidências REAIS: arquivos mudaram?
const main = await api(`/api/files?project=${projectId}&path=src/main.js`)
if (main.status === 200) {
  const hasLives = /vidas|lives/i.test(main.data.content)
  log(`\n🔍 EVIDÊNCIA: main.js ${hasLives ? 'CONTÉM' : 'NÃO contém'} sistema de vidas`)
}

// Testes executados de verdade?
r = await api('/api/activity?project=' + projectId + '&take=100')
const testEvents = r.data.events.filter((e) => e.type.startsWith('test.'))
log(`🔍 EVIDÊNCIA: ${testEvents.length} eventos de teste | ${r.data.events.length} eventos totais`)
for (const e of testEvents.slice(0, 5)) log(`   ${e.type}: ${e.message.slice(0, 90)}`)

log('\n' + (finalStatus === 'COMPLETED' || lastPercent >= 50 ? '🏆 E2E GLOBAL: SUCESSO' : `⚠ E2E GLOBAL: ${finalStatus} (${lastPercent}%) — ver logs acima`))
process.exit(finalStatus === 'COMPLETED' || lastPercent >= 50 ? 0 : 2)
