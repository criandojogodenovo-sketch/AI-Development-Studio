// ============================================================
// B.AI KEY MANAGER — failover controlado de chaves de API
//
// Fluxo: Request → KEY 1 → falha ELEGÍVEL → KEY 2 → ambas
// falharem → erro controlado.
//
// REGRAS (rígidas):
//   - NUNCA rotação infinita (máx. 1 chave alternada por chamada).
//   - NUNCA usar KEY 2 para contornar rate limits ou limites
//     impostos pelo provedor (429 NÃO é elegível para failover).
//   - KEY 2 somente para disponibilidade/failover (rede, 5xx,
//     timeout, 401/403 da própria chave) dentro das regras.
//   - Limites de tentativas por chave e cooldown por chave.
//   - Registrar APENAS informações técnicas seguras (índice da
//     chave, classe do erro, timestamps). NUNCA a chave em si.
//   - Erros sempre controlados (tipos estáveis para o pipeline).
// ============================================================

import { STUDIO_CONFIG } from '../config'
import { classifyError } from './error-classes'
import type { BAIErrorClass } from './error-classes'

// Re-export p/ compatibilidade (consumidores existentes importam daqui)
export { classifyError }
export type { BAIErrorClass }

// ---------- Tipos ----------

export interface BAIKeyInfo {
  index: 1 | 2
  /** estado atual da chave */
  state: 'ACTIVE' | 'COOLDOWN' | 'FAILED'
  /** falhas elegíveis consecutivas */
  consecutiveEligibleFailures: number
  /** número total de falhas (todas as classes) */
  totalFailures: number
  /** total de usos bem-sucedidos */
  totalSuccesses: number
  cooldownUntil: number | null
}

export interface BAIKeyManagerStatus {
  configured: boolean
  keys: BAIKeyInfo[]
  /** chave ativa atual (índice), ou null se nenhuma */
  activeKeyIndex: 1 | 2 | null
}

// ---------- Erro controlado ----------

export class BAIKeyError extends Error {
  code: 'NO_KEYS_CONFIGURED' | 'ALL_KEYS_FAILED' | 'RATE_LIMITED' | 'COOLDOWN'
  /** falha ELEGÍVEL = pode tentar a outra chave */
  eligibleForFailover: boolean
  errorClass: BAIErrorClass
  /** diagnóstico seguro (sem segredo) por chave */
  attempts: { keyIndex: 1 | 2; errorClass: BAIErrorClass; message: string }[]

  constructor(
    code: BAIKeyError['code'],
    message: string,
    opts: {
      eligibleForFailover?: boolean
      errorClass?: BAIErrorClass
      attempts?: { keyIndex: 1 | 2; errorClass: BAIErrorClass; message: string }[]
    } = {}
  ) {
    super(message)
    this.name = 'BAIKeyError'
    this.code = code
    this.eligibleForFailover = opts.eligibleForFailover ?? false
    this.errorClass = opts.errorClass ?? 'UNKNOWN'
    this.attempts = opts.attempts ?? []
  }
}

/** Falhas ELEGÍVEIS para failover — somente indisponibilidade. */
function isEligible(cls: BAIErrorClass): boolean {
  // RATE_LIMIT: explicitamente PROIBIDO usar KEY 2 para contornar.
  // CLIENT_ERROR: falharia igual na outra chave — não elegível.
  return cls === 'SERVER_ERROR' || cls === 'NETWORK' || cls === 'TIMEOUT' || cls === 'AUTH'
}

// ---------- KEY MANAGER ----------

export class BAIKeyManager {
  private keys: BAIKeyInfo[]
  private activeIndex: 1 | 2 | null
  private readonly maxFailuresBeforeCooldown: number
  private readonly cooldownMs: number

  constructor() {
    const key1 = (process.env.BAI_API_KEY_1 ?? '').trim()
    const key2 = (process.env.BAI_API_KEY_2 ?? '').trim()

    this.keys = [
      { index: 1, state: key1 ? 'ACTIVE' : 'FAILED', consecutiveEligibleFailures: 0, totalFailures: 0, totalSuccesses: 0, cooldownUntil: null },
      { index: 2, state: key2 ? 'ACTIVE' : 'FAILED', consecutiveEligibleFailures: 0, totalFailures: 0, totalSuccesses: 0, cooldownUntil: null },
    ]

    // Chave ativa preferencial: KEY 1. Sem KEY 1 (e com KEY 2): KEY 2.
    this.activeIndex = key1 ? 1 : key2 ? 2 : null

    this.maxFailuresBeforeCooldown = STUDIO_CONFIG.bai.failuresBeforeCooldown
    this.cooldownMs = STUDIO_CONFIG.bai.cooldownMs
  }

  /** Há alguma chave configurada? */
  isConfigured(): boolean {
    return this.activeIndex !== null
  }

  /** Snapshot de status — SOMENTE dados seguros (nunca as chaves). */
  status(): BAIKeyManagerStatus {
    return {
      configured: this.isConfigured(),
      keys: this.keys.map((k) => ({ ...k })),
      activeKeyIndex: this.activeIndex,
    }
  }

  /**
   * Chave a usar na próxima tentativa. Ordem de preferência:
   *   1. chave ativa (se fora de cooldown);
   *   2. a outra chave (se configurada e fora de cooldown);
   *   3. null → nenhuma disponível (erro controlado).
   * `exclude` garante que a chave que acabou de falhar NÃO seja
   * readquirida na mesma chamada (sem rotação infinita).
   */
  acquireKey(exclude?: 1 | 2): { index: 1 | 2; key: string } | null {
    if (this.activeIndex === null) return null
    const now = Date.now()
    const order: (1 | 2)[] = this.activeIndex === 1 ? [1, 2] : [2, 1]

    for (const idx of order) {
      if (idx === exclude) continue
      const info = this.keys[idx - 1]
      if (info.state === 'FAILED') continue
      if (info.cooldownUntil && info.cooldownUntil > now) continue
      const key = (idx === 1 ? process.env.BAI_API_KEY_1 : process.env.BAI_API_KEY_2 ?? '').trim()
      if (key) {
        if (this.activeIndex !== idx) this.activeIndex = idx
        return { index: idx, key }
      }
    }
    return null
  }

  /**
   * Reporta falha de uma tentativa com uma chave.
   * Retorna se o erro é elegível para tentar a OUTRA chave.
   */
  reportFailure(keyIndex: 1 | 2, errorClass: BAIErrorClass): { eligibleForFailover: boolean } {
    const info = this.keys[keyIndex - 1]
    info.totalFailures++
    const eligible = isEligible(errorClass)
    if (eligible) info.consecutiveEligibleFailures++

    // Cooldown local da chave após N falhas elegíveis consecutivas
    if (info.consecutiveEligibleFailures >= this.maxFailuresBeforeCooldown) {
      info.cooldownUntil = Date.now() + this.cooldownMs
      info.consecutiveEligibleFailures = 0
      // Log SEGURO: apenas índice e duração — sem chave, sem mensagem crua
      console.warn(
        `[BAIKeyManager] key#${keyIndex} em cooldown ${Math.round(this.cooldownMs / 1000)}s após ${this.maxFailuresBeforeCooldown} falhas elegíveis`
      )
    }
    return { eligibleForFailover: eligible }
  }

  /** Reporta sucesso — zera contadores de falha da chave. */
  reportSuccess(keyIndex: 1 | 2): void {
    const info = this.keys[keyIndex - 1]
    info.totalSuccesses++
    info.consecutiveEligibleFailures = 0
    info.cooldownUntil = null
    info.state = 'ACTIVE'
  }

  /**
   * Loop de chamada com failover controlado (uma única passada):
   *   KEY ativa → executa → falha elegível → OUTRA chave (1x) →
   *   falha → erro controlado. NUNCA volta à primeira chave.
   *   RATE_LIMIT nunca dispara failover.
   */
  async executeWithFailover<T>(
    fn: (key: string, keyIndex: 1 | 2) => Promise<T>
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new BAIKeyError(
        'NO_KEYS_CONFIGURED',
        'BAI_KEYS_AUSENTES: configure BAI_API_KEY_1 (e opcionalmente BAI_API_KEY_2) no servidor',
        { errorClass: 'AUTH' }
      )
    }

    const attempts: { keyIndex: 1 | 2; errorClass: BAIErrorClass; message: string }[] = []
    // Máximo de chaves distintas tentadas: 2 (sem rotação infinita)
    const triedKeys = new Set<number>()
    // Chave que acabou de falhar — readquirida nunca na mesma chamada
    let exclude: 1 | 2 | undefined

    while (triedKeys.size < 2) {
      const acquired = this.acquireKey(exclude)
      if (!acquired) break
      if (triedKeys.has(acquired.index)) break // já tentou esta chave nesta chamada
      triedKeys.add(acquired.index)

      try {
        const result = await fn(acquired.key, acquired.index)
        this.reportSuccess(acquired.index)
        return result
      } catch (err) {
        const e = err as Error & { httpStatus?: number; timedOut?: boolean }
        const errorClass = classifyError({
          httpStatus: e.httpStatus,
          message: e.message,
          timedOut: e.timedOut,
        })
        // Mensagem segura para diagnóstico: classe + status, sem corpo crudo que
        // possa conter material sensível
        const safeMessage = `${errorClass}${e.httpStatus ? ` (HTTP ${e.httpStatus})` : ''}`
        attempts.push({ keyIndex: acquired.index, errorClass, message: safeMessage })

        const { eligibleForFailover } = this.reportFailure(acquired.index, errorClass)

        if (errorClass === 'RATE_LIMIT') {
          // REGRA: NUNCA usar a outra chave para contornar rate limit
          throw new BAIKeyError(
            'RATE_LIMITED',
            `BAI_RATE_LIMIT: limite do provedor atingido (key#${acquired.index}); failover intencionalmente NÃO aplicado a rate limits`,
            { errorClass, attempts }
          )
        }
        if (!eligibleForFailover) {
          throw new BAIKeyError(
            'ALL_KEYS_FAILED',
            `BAI_FALHA: key#${acquired.index} retornou ${safeMessage}; erro não elegível para failover`,
            { errorClass, attempts }
          )
        }
        // elegível → próxima iteração tenta a OUTRA chave (excluindo esta)
        exclude = acquired.index
      }
    }

    throw new BAIKeyError(
      'ALL_KEYS_FAILED',
      `BAI_TODAS_CHAVES_FALHARAM: ${attempts.map((a) => `key#${a.keyIndex}:${a.message}`).join(' | ')}`,
      { attempts }
    )
  }
}
