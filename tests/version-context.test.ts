// ============================================================
// VERSION CONTEXT — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/version-context.test.ts
// Valida o contexto de versão por requisição (AsyncLocalStorage):
//   V1. withPoskliVersion define a versão DENTRO do contexto async
//   V2. Versão inválida/vazia/ausente → SEM override (env decide)
//   V3. Herança através de awaits aninhados (comportamento que o
//       orquestrador/agente rely para propagar a versão do run)
//   V4. Fora do contexto → undefined (fallback para a env)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { withPoskliVersion, requestPoskliVersion } from '../src/lib/studio/models/version-context.ts'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('V1 — withPoskliVersion define a versão dentro do contexto', async () => {
  assert.equal(requestPoskliVersion(), undefined, 'pré-condição: fora do contexto')
  await withPoskliVersion('superagent', async () => {
    assert.equal(requestPoskliVersion(), 'superagent')
    return null
  })
  assert.equal(requestPoskliVersion(), undefined, 'pós: fora do contexto novamente')
})

test('V2 — versão inválida/vazia/ausente: executa SEM override (env decide)', async () => {
  for (const invalid of ['9.9', 'expposkli-1.0', 'expposkli-1.1', '   ', '', undefined]) {
    let seen: string | undefined = 'sentinela'
    await withPoskliVersion(invalid, async () => {
      seen = requestPoskliVersion()
      return null
    })
    assert.equal(seen, undefined, `versão ${JSON.stringify(invalid)} não deve criar override (expposkli removidas — Tarefa C)`)
  }
})

test('V3 — herança através de awaits aninhados (propagação orquestrador→agente)', async () => {
  await withPoskliVersion('1.0-flash', async () => {
    await delay(1)
    await (async () => {
      await delay(1)
      assert.equal(requestPoskliVersion(), '1.0-flash', 'contexto deve sobreviver a awaits aninhados')
    })()
    return null
  })
})

test('V4 — valor de retorno da fn é preservado', async () => {
  const out = await withPoskliVersion('0.3.1', async () => {
    assert.equal(requestPoskliVersion(), '0.3.1')
    return 42
  })
  assert.equal(out, 42)
})

test('V5 — todas as 5 versões são aceitas como override válido', async () => {
  for (const v of ['0.1', '0.2', '0.3.1', '1.0-flash', 'superagent']) {
    let seen: string | undefined
    await withPoskliVersion(v, async () => {
      seen = requestPoskliVersion()
      return null
    })
    assert.equal(seen, v)
  }
})
