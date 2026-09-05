// ============================================================
// TESTE UNITÁRIO — env-validator (validação de ambiente server-side)
// Executar: bun scripts/test-env-validator.ts
// Regras validadas:
//   V1. DATABASE_URL ausente → ERRO claro (consumidor: Prisma)
//   V2. DATABASE_URL não-postgres (ex.: SQLite file:) → ERRO
//   V3. DATABASE_URL com channel_binding=require → ERRO (Prisma não suporta)
//   V4. DATABASE_URL postgres válida → sem erro de banco
//   V5. AUTH_SECRET default fraco → WARN dev / ERRO produção
//   V6. BAI keys ausentes → WARN (fallback SDK sandbox)
//   V7. BAI keys duplicadas → WARN (failover sem efeito)
//   V8. EXECUTION_PROVIDER=docker → WARN (não implementado — honestidade)
//   V9. Numérico inválido → WARN (config usaria default)
//   V10. NEXT_PUBLIC_<secret> definida → ERRO (vazaria para o frontend)
//   V11. ENABLE_DEEPSEEK com valor lixo → WARN interpretado false
//   V12. NUNCA há valor de secret nas mensagens (grep nos issues)
//   V13. WORKSPACES_ROOT relativa → ERRO
//   V14. Ambiente totalmente válido → ok=true, zero erros
//   V15. environmentSummary() não expõe valores (só booleanos/last-4)
// ============================================================

import { validateEnvironment, formatIssues, environmentSummary } from '../src/lib/studio/security/env-validator'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`) }
  else { failed++; console.error(`  ❌ ${msg}`) }
}

/** Backup/restore das variáveis que o teste manipula. */
const MANAGED = [
  'DATABASE_URL', 'AUTH_SECRET', 'BAI_API_KEY_1', 'BAI_API_KEY_2',
  'EXECUTION_PROVIDER', 'WORKSPACES_ROOT', 'ENABLE_DEEPSEEK',
  'AGENT_MAX_STEPS', 'NEXT_PUBLIC_BAI_API_KEY_1', 'NEXT_PUBLIC_DATABASE_URL',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'NODE_ENV',
]
const backup: Record<string, string | undefined> = {}
for (const v of MANAGED) backup[v] = process.env[v]
function restore() {
  for (const v of MANAGED) {
    if (backup[v] === undefined) delete process.env[v]
    else process.env[v] = backup[v]
  }
}
function clean() {
  for (const v of MANAGED) delete process.env[v]
}
const VALID_DB = 'postgresql://user:pass@ep-host-pooler.us-east-2.aws.neon.tech/db?sslmode=require'

function errVars(r: ReturnType<typeof validateEnvironment>) { return r.errors.map(e => e.varName) }
function warnVars(r: ReturnType<typeof validateEnvironment>) { return r.warnings.map(w => w.varName) }

// ---------------- V1: DATABASE_URL ausente ----------------
console.log('\n[V1] DATABASE_URL ausente → ERRO')
{
  clean()
  const r = validateEnvironment('development')
  assert(!r.ok, 'resultado não-ok')
  assert(errVars(r).includes('DATABASE_URL'), 'erro nomeia DATABASE_URL')
  const msg = r.errors.find(e => e.varName === 'DATABASE_URL')?.message ?? ''
  assert(/OBRIGAT/i.test(msg) || /AUSENTE/i.test(msg), 'mensagem explica obrigatoriedade')
  const e1 = r.errors.find(e => e.varName === 'DATABASE_URL')
  assert((e1?.consumer ?? '').includes('Prisma'), 'issue cita o consumidor real (Prisma)')
}

// ---------------- V2: DATABASE_URL não-postgres ----------------
console.log('\n[V2] DATABASE_URL SQLite → ERRO (schema é postgresql)')
{
  clean()
  process.env.DATABASE_URL = 'file:/home/x/db/custom.db'
  const r = validateEnvironment('development')
  assert(!r.ok, 'resultado não-ok')
  const e = r.errors.find(x => x.varName === 'DATABASE_URL')
  assert(Boolean(e), 'erro presente')
  assert((e?.message ?? '').includes('postgres'), 'mensagem exige postgres://')
}

// ---------------- V3: channel_binding ----------------
console.log('\n[V3] channel_binding=require → ERRO com correção')
{
  clean()
  process.env.DATABASE_URL = VALID_DB + '&channel_binding=require'
  const r = validateEnvironment('development')
  const e = r.errors.find(x => x.varName === 'DATABASE_URL')
  assert(Boolean(e), 'erro presente')
  assert((e?.message ?? '').includes('channel_binding'), 'mensagem nomeia o problema')
  assert((e?.message ?? '').includes('sslmode=require'), 'mensagem prescreve a correção (TLS mantido)')
}

// ---------------- V4: postgres válida ----------------
console.log('\n[V4] DATABASE_URL postgres válida → sem erro de banco')
{
  clean()
  process.env.DATABASE_URL = VALID_DB
  const r = validateEnvironment('development')
  assert(!errVars(r).includes('DATABASE_URL'), 'nenhum erro de DATABASE_URL')
}

// ---------------- V5: AUTH_SECRET fraca ----------------
console.log('\n[V5] AUTH_SECRET default → WARN dev, ERRO produção')
{
  clean()
  process.env.DATABASE_URL = VALID_DB
  process.env.AUTH_SECRET = 'troque-por-um-segredo-forte-aleatorio'
  const dev = validateEnvironment('development')
  assert(dev.ok, 'dev: apenas warn, sistema segue')
  assert(warnVars(dev).includes('AUTH_SECRET'), 'dev: warn emitido')
  const prod = validateEnvironment('production')
  assert(!prod.ok, 'prod: default fraco é ERRO')
  assert(errVars(prod).includes('AUTH_SECRET'), 'prod: erro nomeia AUTH_SECRET')
}

// ---------------- V6: BAI keys ausentes ----------------
console.log('\n[V6] sem BAI keys → WARN com caminho honesto')
{
  clean()
  process.env.DATABASE_URL = VALID_DB
  const dev = validateEnvironment('development')
  assert(dev.warnings.some(w => w.varName.includes('BAI_API_KEY')), 'dev: warn sobre chaves ausentes')
  assert(dev.warnings.some(w => /sandbox|z-ai/i.test(w.message)), 'dev: avisa fallback SDK sandbox')
  const prod = validateEnvironment('production')
  assert(prod.warnings.some(w => /PRODUÇ[ÃA]O/i.test(w.message)), 'prod: avisa que sandbox não existe fora daqui')
}

// ---------------- V7: BAI keys duplicadas ----------------
console.log('\n[V7] chaves idênticas → WARN (failover inútil)')
{
  clean()
  process.env.DATABASE_URL = VALID_DB
  process.env.BAI_API_KEY_1 = 'FAKE-KEY-same-aaaaaaaaaaaaaaaaaaaa'
  process.env.BAI_API_KEY_2 = 'FAKE-KEY-same-aaaaaaaaaaaaaaaaaaaa'
  const r = validateEnvironment('development')
  assert(r.warnings.some(w => /idênticas/i.test(w.message)), 'warn de chaves idênticas')
}

// ---------------- V8: EXECUTION_PROVIDER ----------------
console.log('\n[V8] docker/remote → WARN de não implementado')
{
  clean()
  process.env.DATABASE_URL = VALID_DB
  process.env.EXECUTION_PROVIDER = 'docker'
  const r = validateEnvironment('development')
  assert(r.warnings.some(w => w.varName === 'EXECUTION_PROVIDER' && /não implementado/i.test(w.message)), 'warn honesto sobre docker')
  process.env.EXECUTION_PROVIDER = 'kubernetes'
  const r2 = validateEnvironment('development')
  assert(r2.warnings.some(w => w.varName === 'EXECUTION_PROVIDER' && /não reconhecido/i.test(w.message)), 'warn de valor desconhecido')
}

// ---------------- V9: numérico inválido ----------------
console.log('\n[V9] AGENT_MAX_STEPS=abc → WARN (default silencioso evitado)')
{
  clean()
  process.env.DATABASE_URL = VALID_DB
  process.env.AGENT_MAX_STEPS = 'abc'
  const r = validateEnvironment('development')
  assert(r.warnings.some(w => w.varName === 'AGENT_MAX_STEPS' && /default/i.test(w.message)), 'warn explica substituição por default')
  process.env.AGENT_MAX_STEPS = '-5'
  const r2 = validateEnvironment('development')
  assert(r2.warnings.some(w => w.varName === 'AGENT_MAX_STEPS'), 'negativo também avisado')
}

// ---------------- V10: NEXT_PUBLIC_ de secret ----------------
console.log('\n[V10] NEXT_PUBLIC_BAI_API_KEY_1 definida → ERRO')
{
  clean()
  process.env.DATABASE_URL = VALID_DB
  process.env.NEXT_PUBLIC_BAI_API_KEY_1 = 'algo'
  const r = validateEnvironment('development')
  assert(!r.ok, 'erro bloqueante')
  const e = r.errors.find(x => x.varName === 'NEXT_PUBLIC_BAI_API_KEY_1')
  assert(Boolean(e), 'erro nomeia a variável com prefixo')
  assert((e?.message ?? '').includes('frontend') || (e?.message ?? '').includes('cliente'), 'mensagem explica o vazamento')
}

// ---------------- V11: ENABLE_DEEPSEEK lixo ----------------
console.log('\n[V11] ENABLE_DEEPSEEK=maybe → WARN, interpretado false')
{
  clean()
  process.env.DATABASE_URL = VALID_DB
  process.env.ENABLE_DEEPSEEK = 'maybe'
  const r = validateEnvironment('development')
  assert(r.warnings.some(w => w.varName === 'ENABLE_DEEPSEEK' && /false/i.test(w.message)), 'warn informa interpretação como false')
}

// ---------------- V13: WORKSPACES_ROOT relativa ----------------
console.log('\n[V13] WORKSPACES_ROOT relativa → ERRO')
{
  clean()
  process.env.DATABASE_URL = VALID_DB
  process.env.WORKSPACES_ROOT = 'workspaces'
  const r = validateEnvironment('development')
  assert(errVars(r).includes('WORKSPACES_ROOT'), 'erro de caminho absoluto')
}

// ---------------- V12+V15: segurança das mensagens ----------------
console.log('\n[V12/V15] nenhuma mensagem/summary expõe valor de secret')
{
  clean()
  process.env.DATABASE_URL = VALID_DB
  process.env.BAI_API_KEY_1 = 'SECRET-VALUE-xyz-DO-NOT-LEAK-1234567890'
  process.env.BAI_API_KEY_2 = 'SECRET-VALUE-abc-DO-NOT-LEAK-0987654321'
  process.env.GITHUB_TOKEN = 'ghp_verysecretLEAKCHECK0000000000'
  process.env.AUTH_SECRET = 'AUTH-SECRET-LEAK-CHECK-abcdef-123456'
  const r = validateEnvironment('development')
  const allText = JSON.stringify({ e: r.errors, w: r.warnings, s: environmentSummary() }) + formatIssues(r)
  const leaks = ['SECRET-VALUE-xyz', 'SECRET-VALUE-abc', 'verysecretLEAKCHECK', 'AUTH-SECRET-LEAK-CHECK', 'user:pass']
  for (const leak of leaks) {
    assert(!allText.includes(leak), `"${leak.slice(0, 18)}…" ausente de toda a saída`)
  }
  const sum = JSON.stringify(environmentSummary())
  assert(sum.includes('…'), 'summary de token usa apenas last-4')
}

// ---------------- V14: ambiente válido completo ----------------
console.log('\n[V14] ambiente válido → ok, zero erros')
{
  clean()
  process.env.DATABASE_URL = VALID_DB
  process.env.BAI_API_KEY_1 = 'FAKE-VALID-KEY-aaaaaaaaaaaaaaaaaaaaaa'
  process.env.BAI_API_KEY_2 = 'FAKE-VALID-KEY-bbbbbbbbbbbbbbbbbbbbbbbb'
  process.env.AUTH_SECRET = 'x'.repeat(40)
  process.env.EXECUTION_PROVIDER = 'local'
  process.env.WORKSPACES_ROOT = '/home/z/my-project/workspaces'
  process.env.ENABLE_DEEPSEEK = 'false'
  process.env.AGENT_MAX_STEPS = '30'
  const r = validateEnvironment('production')
  assert(r.ok, 'ok=true em produção com tudo válido')
  assert(r.errors.length === 0, 'zero erros')
}

restore()
console.log(`\n========================================`)
console.log(`VALIDAÇÃO DE AMBIENTE (testes): ${passed} passaram, ${failed} falharam`)
if (failed > 0) process.exit(1)
