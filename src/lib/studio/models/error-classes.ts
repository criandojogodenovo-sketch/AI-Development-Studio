// ============================================================
// ERROR CLASSES — classificação de erros de providers LLM
// NÚCLEO PURO (zero imports): importável por node:test (extensão
// .ts explícita) e pelo bai-key-manager (re-exporta p/ compat).
// Recebe APENAS status HTTP e/ou mensagem — nunca material
// sensível (chaves são mascaradas nos pontos de origem).
// ============================================================

/** Classe de erro de rede/HTTP para decisão de failover */
export type BAIErrorClass =
  | 'RATE_LIMIT'      // 429 — NUNCA elegível para failover
  | 'AUTH'            // 401/403 — chave inválida/revogada/locação (elegível: outra credencial pode funcionar)
  | 'CLIENT_ERROR'    // 400/404/422 — erro de requisição (não elegível: falharia igual em outra chave)
  | 'SERVER_ERROR'    // 5xx — servidor instável (elegível)
  | 'NETWORK'         // ECONNRESET/ETIMEDOUT/fetch failed (elegível)
  | 'TIMEOUT'         // timeout local (elegível)
  | 'UNKNOWN'

/**
 * Classifica um erro em classe estável. Recebe APENAS status HTTP
 * e/ou mensagem de erro — nunca material sensível.
 */
export function classifyError(opts: {
  httpStatus?: number
  message?: string
  timedOut?: boolean
}): BAIErrorClass {
  if (opts.timedOut) return 'TIMEOUT'
  const msg = (opts.message ?? '').toLowerCase()
  if (opts.httpStatus === 429 || msg.includes('too many requests') || msg.includes('rate limit')) {
    return 'RATE_LIMIT'
  }
  if (opts.httpStatus === 401 || opts.httpStatus === 403) return 'AUTH'
  if (opts.httpStatus !== undefined && opts.httpStatus >= 400 && opts.httpStatus < 500) {
    return 'CLIENT_ERROR'
  }
  if (opts.httpStatus !== undefined && opts.httpStatus >= 500) return 'SERVER_ERROR'
  if (
    msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('enotfound') ||
    msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('network') ||
    msg.includes('socket hang up')
  ) {
    return 'NETWORK'
  }
  return 'UNKNOWN'
}
