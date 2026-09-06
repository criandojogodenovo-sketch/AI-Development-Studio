// ============================================================
// VERSION CONTEXT — versão do Poskli POR REQUISIÇÃO (server-side)
//
// A UI envia a versão escolhida pelo usuário (seletor de modelos,
// persistida em localStorage) no corpo (`poskliVersion`) ou header
// (`x-poskli-version`) das chamadas Poskli. O backend a valida e
// envelopa a execução com withPoskliVersion() — TODAS as chamadas
// ao ModelRouter dentro do contexto (orquestrador, agentes, testes
// reais) enxergam a versão via AsyncLocalStorage.
//
// Prioridade: requisição (ALS) > env POSKLI_VERSION (default).
// Valor inválido/ausente → sem override → env decide (comportamento
// anterior preservado para clientes que não enviam o parâmetro).
//
// Módulo de runtime (node:async_hooks) — NUNCA importar de código
// client. Imports puros com .ts explícito (testável com node:test).
// ============================================================

import { AsyncLocalStorage } from 'node:async_hooks'
import { POSKLI_VERSIONS, type PoskliVersion } from './chain.ts'

const versionStorage = new AsyncLocalStorage<PoskliVersion>()

/**
 * Executa fn com a versão do Poskli ativa para ESTE contexto async
 * (run do orquestrador, request de API). Versão inválida/vazia →
 * executa SEM override (a env POSKLI_VERSION continua mandando).
 */
export function withPoskliVersion<T>(version: string | undefined, fn: () => Promise<T>): Promise<T> {
  const t = (version ?? '').trim()
  if (t && (POSKLI_VERSIONS as readonly string[]).includes(t)) {
    return versionStorage.run(t as PoskliVersion, fn)
  }
  return fn()
}

/** Versão ativa deste contexto async (undefined = usar a env). */
export function requestPoskliVersion(): PoskliVersion | undefined {
  return versionStorage.getStore()
}
