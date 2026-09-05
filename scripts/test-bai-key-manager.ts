// ============================================================
// TESTE UNITÁRIO — BAIKeyManager (failover controlado de chaves)
// Executar: bun scripts/test-bai-key-manager.ts
// Valida as REGRAS do sistema:
//   R1. Sem chaves → erro controlado NO_KEYS_CONFIGURED
//   R2. Falha elegível (rede/5xx/timeout/401) na KEY1 → failover KEY2
//   R3. 429 rate limit → NUNCA failover (regra explícita)
//   R4. 4xx cliente → NUNCA failover (falharia igual na KEY2)
//   R5. Ambas falham → ALL_KEYS_FAILED sem rotação infinita
//   R6. Cooldown após N falhas elegíveis consecutivas
//   R7. Sucesso zera contadores
//   R8. Chave NUNCA aparece em mensagens de erro
// ============================================================

import { BAIKeyManager, classifyError } from '../src/lib/studio/models/bai-key-manager'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`) }
  else { failed++; console.error(`  ❌ ${msg}`) }
}

const K1 = 'FAKE-KEY-ONE-aaaaaaaaaaaaaaaaaaaa'
const K2 = 'FAKE-KEY-TWO-bbbbbbbbbbbbbbbbbbbb'

function setup(k1: string, k2: string) {
  process.env.BAI_API_KEY_1 = k1
  process.env.BAI_API_KEY_2 = k2
  return new BAIKeyManager()
}

function netErr() {
  return Object.assign(new Error('fetch failed: ECONNRESET'), { network: true })
}

console.log('\n[R1] sem chaves configuradas')
{
  process.env.BAI_API_KEY_1 = ''
  process.env.BAI_API_KEY_2 = ''
  const km = new BAIKeyManager()
  assert(!km.isConfigured(), 'isConfigured() = false')
  let threw = ''
  try { await km.executeWithFailover(async () => 'x') } catch (e) { threw = (e as Error).message }
  assert(threw.includes('BAI_KEYS_AUSENTES'), 'erro controlado NO_KEYS_CONFIGURED')
}

console.log('\n[R2] falha elegível de rede na KEY1 → failover para KEY2')
{
  const km = setup(K1, K2)
  const tried: string[] = []
  const result = await km.executeWithFailover(async (key, idx) => {
    tried.push(key)
    if (idx === 1) throw netErr()
    return 'ok-from-key2'
  })
  assert(result === 'ok-from-key2', 'resultado da KEY2 retornado')
  assert(tried.length === 2, 'exatamente 2 tentativas (sem rotação infinita)')
  assert(tried[0] === K1 && tried[1] === K2, 'ordem KEY1 → KEY2')
  const st = km.status()
  assert(st.activeKeyIndex === 2, 'chave ativa passa a ser 2')
  assert(st.keys[0].totalFailures === 1, 'falha da KEY1 registrada')
  assert(st.keys[1].totalSuccesses === 1, 'sucesso da KEY2 registrado')
}

console.log('\n[R3] 429 rate limit na KEY1 → NUNCA usa KEY2')
{
  const km = setup(K1, K2)
  let key2Called = 0
  let code = ''
  let msg = ''
  try {
    await km.executeWithFailover(async (_key, idx) => {
      if (idx === 2) key2Called++
      throw Object.assign(new Error('BAI_HTTP_429: too many requests'), { httpStatus: 429 })
    })
  } catch (e) {
    code = (e as { code?: string }).code ?? ''
    msg = (e as Error).message
  }
  assert(code === 'RATE_LIMITED', 'erro controlado RATE_LIMITED')
  assert(key2Called === 0, 'KEY2 jamais acionada para contornar rate limit')
  assert(msg.indexOf(K1) === -1 && msg.indexOf(K2) === -1, 'chave não aparece no erro')
}

console.log('\n[R4] erro de cliente 400 na KEY1 → sem failover')
{
  const km = setup(K1, K2)
  let key2Called = 0
  let code = ''
  try {
    await km.executeWithFailover(async (_key, idx) => {
      if (idx === 2) key2Called++
      throw Object.assign(new Error('BAI_HTTP_400: bad request'), { httpStatus: 400 })
    })
  } catch (e) { code = (e as { code?: string }).code ?? '' }
  assert(code === 'ALL_KEYS_FAILED', 'erro controlado (não elegível)')
  assert(key2Called === 0, 'KEY2 não acionada para erro de cliente')
}

console.log('\n[R5] ambas as chaves com falha de rede → ALL_KEYS_FAILED, máx 2 tentativas')
{
  const km = setup(K1, K2)
  let attempts = 0
  let code = ''
  let attemptsInfo: { keyIndex: number }[] = []
  try {
    await km.executeWithFailover(async () => { attempts++; throw netErr() })
  } catch (e) {
    code = (e as { code?: string }).code ?? ''
    attemptsInfo = ((e as { attempts?: { keyIndex: number }[] }).attempts ?? []) as { keyIndex: number }[]
  }
  assert(code === 'ALL_KEYS_FAILED', 'erro controlado ALL_KEYS_FAILED')
  assert(attempts === 2, 'exatamente 2 tentativas (1 por chave)')
  assert(attemptsInfo.length === 2, 'diagnóstico seguro com 2 tentativas')
  assert(attemptsInfo.every((a) => [1, 2].includes(a.keyIndex)), 'diagnóstico por índice de chave')
}

console.log('\n[R2b] 401 AUTH na KEY1 é elegível → KEY2 assume')
{
  const km = setup(K1, K2)
  const r = await km.executeWithFailover(async (_k, idx) => {
    if (idx === 1) throw Object.assign(new Error('BAI_HTTP_401: unauthorized'), { httpStatus: 401 })
    return 'ok-2'
  })
  assert(r === 'ok-2', '401 na KEY1 failover para KEY2 (chave pode estar revogada)')
}

console.log('\n[R6] cooldown após 3 falhas elegíveis consecutivas na KEY1')
{
  const km = setup(K1, K2)
  // 3 falhas elegíveis consecutivas SOMENTE na KEY1 (KEY2 saudável)
  km.reportFailure(1, 'NETWORK')
  km.reportFailure(1, 'NETWORK')
  km.reportFailure(1, 'NETWORK')
  const st = km.status()
  assert(st.keys[0].cooldownUntil !== null, 'KEY1 em cooldown após 3 falhas elegíveis')
  assert(st.keys[1].cooldownUntil === null, 'KEY2 fora de cooldown (sem falhas)')
  const acquired = km.acquireKey()
  assert(acquired?.index === 2, 'enquanto KEY1 em cooldown, acquireKey → KEY2')
}

console.log('\n[R7] sucesso zera contadores de falha')
{
  const km = setup(K1, K2)
  km.reportFailure(1, 'NETWORK')
  km.reportFailure(1, 'NETWORK')
  km.reportSuccess(1)
  const st = km.status()
  assert(st.keys[0].consecutiveEligibleFailures === 0, 'contador consecutivo zerado')
  assert(st.keys[0].cooldownUntil === null, 'cooldown limpo')
}

console.log('\n[R8] chaves nunca vazam em mensagens de erro')
{
  const km = setup(K1, K2)
  let msg = ''
  try {
    await km.executeWithFailover(async () => {
      throw Object.assign(new Error(`fetch failed`), { network: true })
    })
  } catch (e) { msg = (e as Error).message + JSON.stringify((e as { attempts?: unknown }).attempts ?? []) }
  assert(!msg.includes(K1) && !msg.includes(K2), 'nenhuma chave material em mensagens/diagnóstico')
}

console.log('\n[classify] classificação de erros')
{
  assert(classifyError({ httpStatus: 429 }) === 'RATE_LIMIT', '429 → RATE_LIMIT')
  assert(classifyError({ httpStatus: 401 }) === 'AUTH', '401 → AUTH')
  assert(classifyError({ httpStatus: 400 }) === 'CLIENT_ERROR', '400 → CLIENT_ERROR')
  assert(classifyError({ httpStatus: 503 }) === 'SERVER_ERROR', '503 → SERVER_ERROR')
  assert(classifyError({ message: 'fetch failed' }) === 'NETWORK', 'fetch failed → NETWORK')
  assert(classifyError({ timedOut: true }) === 'TIMEOUT', 'timeout → TIMEOUT')
}

console.log(`\n========================================`)
console.log(`RESULTADO: ${passed} passaram, ${failed} falharam`)
process.exit(failed > 0 ? 1 : 0)
