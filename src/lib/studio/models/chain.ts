// ============================================================
// PROVIDER CHAIN — roteamento de providers por versão do Poskli
// (POSKLI_VERSION ou seletor de modelos da UI) com failover
// CONTROLADO + POLÍTICA ANTI-RATE-LIMIT (Tarefa C).
//
// NÚCLEO PURO (mesma filosofia do state-machine.ts): imports de
// runtime APENAS de módulos puros com extensão .ts explícita —
// testável isoladamente com node:test.
//
// Chains por versão (spec Tarefa C — Experiential ELIMINADA):
//   0.1        : [BAI]                       Qwen/Hy3/Qwen (só B.AI)
//   0.2        : [BAI, NVIDIA]               GLM/Qwen/Hy3 + NVIDIA (coding/review)
//   0.3.1      : [BAI, NVIDIA]               Hy3/Qwen + review GPT-OSS-20B (NVIDIA)
//   1.0-flash  : [NVIDIA, BAI]               NVIDIA prioritário → B.AI reserva
//   superagent : [BAI, NVIDIA]               GLM + Hy3/Qwen (dupla coding) + GPT-OSS
//
// ROTAS POR PAPEL (VERSION_ROUTES): além da ordem de providers,
// cada versão define qual modelo LÓGICO exerce cada papel
// (master/coding/review) e o comportamento em 429 de cada parada.
//
// POLÍTICA ANTI-RATE-LIMIT (Tarefa C — substitui o invariant
// anterior "429 nunca faz failover" por um controle FINITO):
//   a) Backoff progressivo: 429 → aguardar 5s → 10s → 20s
//      (máx 3 tentativas no MESMO modelo). 3 falhas → o erro
//      QUOTA_EXHAUSTED PARA O RUN imediatamente (nunca cria
//      tarefas de correção para erros de quota).
//   b) Rotação de chaves B.AI: só em falhas elegíveis (rede/5xx)
//      — 429 NUNCA rotaciona chaves (BAIKeyManager inalterado).
//   c) Fallback inteligente por modelo (comportamento por parada):
//        switch-now        → troca de modelo IMEDIATAMENTE no 1º 429
//                            (pares da MESMA conta B.AI — esperar não ajuda)
//        retry-then-switch → 1 retry com backoff 5s; se 429 de novo,
//                            troca (NVIDIA prioritário, mas não infinito)
//        retry-backoff     → (default) 3 tentativas com backoff; depois
//                            QUOTA_EXHAUSTED (para o run honestamente)
//   Falhas ELEGÍVEIS (rede/5xx/timeout/401-403) avançam no chain
//   como antes; CLIENT_ERROR/UNKNOWN não avançam (conservador).
//
// Sem chaves B.AI (sandbox local): o SDK local (zai) substitui o
// B.AI nas paradas — a arquitetura de agentes não muda.
// ============================================================

import { classifyError, type BAIErrorClass } from './error-classes.ts'
import type { CompletionRequest, CompletionResult, LLMProvider, ProviderName } from './types.ts'

export type PoskliVersion = '0.1' | '0.2' | '0.3.1' | '1.0-flash' | 'superagent'
export type Difficulty = 'easy' | 'medium' | 'hard'
export type { ProviderName }

export const POSKLI_VERSIONS: readonly PoskliVersion[] = [
  '0.1', '0.2', '0.3.1', '1.0-flash', 'superagent',
] as const

/** Default = versão do Poskli em produção hoje. */
export const DEFAULT_POSKLI_VERSION: PoskliVersion = '0.2'

const CHAINS: Record<PoskliVersion, readonly ProviderName[]> = {
  '0.1': ['bai'],
  '0.2': ['bai', 'nvidia'],
  '0.3.1': ['bai', 'nvidia'],
  '1.0-flash': ['nvidia', 'bai'],
  'superagent': ['bai', 'nvidia'],
}

/** Normaliza a versão; valor inválido/ausente → default (0.2). */
export function normalizeVersion(v: string | undefined): PoskliVersion {
  const t = (v ?? '').trim()
  return (POSKLI_VERSIONS as readonly string[]).includes(t) ? (t as PoskliVersion) : DEFAULT_POSKLI_VERSION
}

export interface ChainContext {
  /** chaves B.AI configuradas? (sem elas, o sandbox zai substitui) */
  baiConfigured: boolean
  /** NVIDIA_API_KEY presente? */
  nvidiaConfigured: boolean
  difficulty?: Difficulty
}

/** Resolve o chain ORDENADO de providers para a versão + contexto
 *  (ordem de failover para falhas ELEGÍVEIS; 429 segue a política
 *  anti-rate-limit por parada — ver VERSION_ROUTES). */
export function resolveChain(version: PoskliVersion, ctx: ChainContext): ProviderName[] {
  const base: readonly ProviderName[] = CHAINS[version]
  const out: ProviderName[] = []
  for (const n of base) {
    if (n === 'bai') {
      out.push(ctx.baiConfigured ? 'bai' : 'zai')
    } else if (n === 'nvidia' && ctx.nvidiaConfigured) {
      out.push('nvidia')
    }
  }
  return [...new Set(out)]
}

// ---------- ROTAS POR PAPEL (modelo lógico por versão) ----------

/** Chaves estáveis de modelos LÓGICOS (mapeadas ao registry no router). */
export type LogicalModelKey = 'glm' | 'qwen' | 'hy3' | 'deepseek' | 'luna' | 'gpt-oss' | 'nemotron'

export type RouteRole = 'master' | 'coding' | 'review'

/** Comportamento da parada quando recebe 429/rate limit. */
export type RateLimitBehavior = 'retry-backoff' | 'switch-now' | 'retry-then-switch'

export interface RouteStop {
  provider: ProviderName
  /** modelo LÓGICO desta parada (chave do registry no router) */
  model: LogicalModelKey
  /** política anti-rate-limit desta parada (default: retry-backoff) */
  onRateLimit?: RateLimitBehavior
}

/**
 * Rotas por versão × papel (spec Tarefa C):
 *   0.1        : master Qwen · coding Hy3 · review Qwen (B.AI puro)
 *   0.2        : master GLM · coding Qwen→DeepSeek(NVIDIA) ·
 *                review Hy3→GPT-OSS(NVIDIA)
 *   0.3.1      : master Hy3 · coding Qwen→(429)GLM ·
 *                review GPT-OSS(NVIDIA)→(429)Luna(B.AI)
 *   1.0-flash  : NVIDIA prioritário (Nemotron/DeepSeek/GPT-OSS),
 *                429 → 1 retry → B.AI (GLM/Qwen/Luna)
 *   superagent : master GLM→Nemotron · coding Hy3→(429)Qwen→DeepSeek ·
 *                review GPT-OSS(NVIDIA)→(429)Luna
 */
export const VERSION_ROUTES: Readonly<Record<PoskliVersion, Readonly<Record<RouteRole, readonly RouteStop[]>>>> = {
  '0.1': {
    master: [{ provider: 'bai', model: 'qwen' }],
    coding: [{ provider: 'bai', model: 'hy3' }],
    review: [{ provider: 'bai', model: 'qwen' }],
  },
  '0.2': {
    master: [{ provider: 'bai', model: 'glm' }],
    coding: [
      { provider: 'bai', model: 'qwen' },
      { provider: 'nvidia', model: 'deepseek' },
    ],
    review: [
      { provider: 'bai', model: 'hy3' },
      { provider: 'nvidia', model: 'gpt-oss' },
    ],
  },
  '0.3.1': {
    master: [{ provider: 'bai', model: 'hy3' }],
    coding: [
      // Qwen 429 → GLM imediatamente (mesma conta B.AI — esperar não ajuda)
      { provider: 'bai', model: 'qwen', onRateLimit: 'switch-now' },
      { provider: 'bai', model: 'glm' },
    ],
    review: [
      // GPT-OSS-20B (NVIDIA) principal; 429 → 1 retry → GPT-5.6 Luna (B.AI)
      { provider: 'nvidia', model: 'gpt-oss', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', model: 'luna' },
    ],
  },
  '1.0-flash': {
    master: [
      // NVIDIA prioritário, mas não infinito: 429 → 1 retry (5s) → B.AI
      { provider: 'nvidia', model: 'nemotron', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', model: 'glm' },
    ],
    coding: [
      { provider: 'nvidia', model: 'deepseek', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', model: 'qwen' },
    ],
    review: [
      { provider: 'nvidia', model: 'gpt-oss', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', model: 'luna' },
    ],
  },
  superagent: {
    master: [
      { provider: 'bai', model: 'glm', onRateLimit: 'retry-then-switch' },
      { provider: 'nvidia', model: 'nemotron' },
    ],
    coding: [
      // dupla de coding: Hy3 → (429) Qwen (mesma conta) → DeepSeek (NVIDIA)
      { provider: 'bai', model: 'hy3', onRateLimit: 'switch-now' },
      { provider: 'bai', model: 'qwen', onRateLimit: 'retry-then-switch' },
      { provider: 'nvidia', model: 'deepseek' },
    ],
    review: [
      { provider: 'nvidia', model: 'gpt-oss', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', model: 'luna' },
    ],
  },
}

// ---------- CLASSIFICAÇÃO DE ERROS DO CHAIN ----------

export interface ChainErrorShape {
  code?: string
  errorClass?: BAIErrorClass
  httpStatus?: number
  timedOut?: boolean
  message?: string
  eligibleForFailover?: boolean
}

/** Classe do erro: usa a classe ANEXADA pelo provider; classifica o erro bruto se ausente. */
export function errorClassOf(err: unknown): BAIErrorClass {
  const e = (err ?? {}) as ChainErrorShape
  if (e.errorClass) return e.errorClass
  if (e.code === 'RATE_LIMIT' || e.code === 'RATE_LIMITED') return 'RATE_LIMIT'
  return classifyError({ httpStatus: e.httpStatus, message: e.message, timedOut: e.timedOut })
}

/** É um erro de rate limit (429)? */
export function isRateLimitError(err: unknown): boolean {
  const e = (err ?? {}) as ChainErrorShape
  if (e.code === 'RATE_LIMITED' || e.code === 'RATE_LIMIT') return true
  return errorClassOf(err) === 'RATE_LIMIT'
}

/** Falhas elegíveis para failover ENTRE providers (não-429). */
const ELIGIBLE_CLASSES: readonly BAIErrorClass[] = ['SERVER_ERROR', 'NETWORK', 'TIMEOUT', 'AUTH']

export function eligibleForChainFailover(err: unknown): boolean {
  // rate limits seguem a política anti-rate-limit própria (nunca failover elegível)
  if (isRateLimitError(err)) return false
  const e = (err ?? {}) as ChainErrorShape
  const cls = errorClassOf(err)
  // BAI exauriu as chaves em falhas elegíveis → próximo provider do chain
  if (e.code === 'ALL_KEYS_FAILED') {
    return e.errorClass === undefined || ELIGIBLE_CLASSES.includes(e.errorClass)
  }
  return ELIGIBLE_CLASSES.includes(cls)
}

// ---------- POLÍTICA ANTI-RATE-LIMIT (Tarefa C) ----------

/** Backoff progressivo em 429: 5s → 10s → 20s. */
export const RATE_LIMIT_BACKOFF_MS: readonly number[] = [5_000, 10_000, 20_000]

/** Máximo de tentativas no MESMO modelo antes de QUOTA_EXHAUSTED. */
export const RATE_LIMIT_MAX_ATTEMPTS = 3

/** Opções de execução (injetáveis p/ testes — sem esperas reais). */
export interface RateLimitOptions {
  sleep?: (ms: number) => Promise<void>
  backoffMs?: readonly number[]
  maxAttempts?: number
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------- EXECUÇÃO COM FAILOVER CONTROLADO + ANTI-RATE-LIMIT ----------

export interface ChainEntry {
  provider: ProviderName
  llm: LLMProvider
  /** modelo FÍSICO deste provider para o modelo lógico solicitado */
  model: string
  /** política anti-rate-limit desta parada (default: retry-backoff) */
  onRateLimit?: RateLimitBehavior
}

export interface ChainAttempt {
  provider: ProviderName
  errorClass: BAIErrorClass
  message: string
}

function safeMessage(err: unknown): string {
  const e = (err ?? {}) as ChainErrorShape
  const base = String(e.code ?? e.errorClass ?? 'UNKNOWN')
  const msg = (e.message ?? '').replace(/\s+/g, ' ').slice(0, 120)
  return msg ? `${base}: ${msg}` : base
}

/**
 * Executa a requisição percorrendo o chain:
 *   sucesso                        → retorna {result, provider}
 *   429                            → política anti-rate-limit da parada:
 *       switch-now        → próxima parada imediatamente
 *       retry-then-switch → 1 retry (backoff 5s) → próxima parada
 *       retry-backoff     → até 3 tentativas (5s/10s/20s) → QUOTA_EXHAUSTED
 *   falha elegível (rede/5xx/...)  → avança para a próxima parada
 *   falha não-elegível             → propaga (conservador)
 *   chain exaurido                 → QUOTA_EXHAUSTED (se caiu por 429) ou
 *                                    ALL_PROVIDERS_FAILED (elegíveis)
 * QUOTA_EXHAUSTED para o RUN com honestidade — o orquestrador NUNCA
 * cria tarefas de correção para erros de quota (regra de ouro).
 */
export async function executeWithChain(
  entries: readonly ChainEntry[],
  req: Omit<CompletionRequest, 'model'>,
  rl: RateLimitOptions = {}
): Promise<{ result: CompletionResult; provider: ProviderName; attempts: ChainAttempt[] }> {
  if (entries.length === 0) {
    throw Object.assign(
      new Error('CHAIN_VAZIA: nenhum provider configurado para este modelo/versão'),
      { code: 'UNAVAILABLE' }
    )
  }
  const sleep = rl.sleep ?? defaultSleep
  const backoff = rl.backoffMs ?? RATE_LIMIT_BACKOFF_MS
  const maxAttempts = rl.maxAttempts ?? RATE_LIMIT_MAX_ATTEMPTS

  const attempts: ChainAttempt[] = []
  let lastErr: unknown = null
  let lastWasRateLimit = false

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const behavior: RateLimitBehavior = entry.onRateLimit ?? 'retry-backoff'
    let tries = 0
    let advance = false

    while (!advance) {
      tries++
      try {
        const result = await entry.llm.complete({ ...req, model: entry.model })
        return { result, provider: entry.provider, attempts }
      } catch (err) {
        lastErr = err
        const rl_ = isRateLimitError(err)
        lastWasRateLimit = rl_
        const cls = errorClassOf(err)
        attempts.push({ provider: entry.provider, errorClass: cls, message: safeMessage(err) })

        if (rl_) {
          // ---- política anti-rate-limit por parada ----
          if (behavior === 'switch-now') {
            console.warn(
              `[ProviderChain] 429 em ${entry.provider}/${entry.model} → troca IMEDIATA (mesma conta) para a próxima parada`
            )
            advance = true
          } else if (behavior === 'retry-then-switch') {
            if (tries >= 2) {
              console.warn(
                `[ProviderChain] 429 persistiu em ${entry.provider}/${entry.model} após 1 retry → próxima parada`
              )
              advance = true
            } else {
              await sleep(backoff[0] ?? 5_000)
            }
          } else {
            // retry-backoff (default): 3 tentativas → QUOTA_EXHAUSTED
            if (tries >= maxAttempts) {
              throw Object.assign(
                new Error(
                  `QUOTA_EXHAUSTED: ${entry.provider}/${entry.model} devolveu 429 após ${tries} tentativas ` +
                    `(backoff ${(backoff as readonly number[]).join('/')}ms) — run interrompido ` +
                    'para evitar desperdício (política anti-loop; sem correções automáticas)'
                ),
                { code: 'QUOTA_EXHAUSTED', errorClass: 'RATE_LIMIT', quotaExhausted: true, attempts }
              )
            }
            await sleep(backoff[Math.min(tries - 1, backoff.length - 1)] ?? 5_000)
          }
          continue
        }

        // ---- falha NÃO-429 ----
        if (!eligibleForChainFailover(err)) {
          // CLIENT_ERROR / UNKNOWN: para aqui — política conservadora
          throw err
        }
        console.warn(
          `[ProviderChain] failover: ${entry.provider} falhou (classe ${cls}, model ${entry.model}) — tentando a próxima parada do chain`
        )
        advance = true
      }
    }
  }

  // chain exaurido — se caiu por rate limit, é QUOTA_EXHAUSTED (honesto)
  if (lastWasRateLimit) {
    throw Object.assign(
      new Error(
        `QUOTA_EXHAUSTED: todas as paradas de rate limit do chain falharam (${attempts
          .map((a) => `${a.provider}:${a.errorClass}`)
          .join(' → ')}) — run interrompido para evitar desperdício`
      ),
      { code: 'QUOTA_EXHAUSTED', errorClass: 'RATE_LIMIT', quotaExhausted: true, attempts, cause: lastErr }
    )
  }
  throw Object.assign(
    new Error(`CHAIN_EXAURIDO: ${attempts.map((a) => `${a.provider}:${a.errorClass}`).join(' → ')}`),
    { code: 'ALL_PROVIDERS_FAILED', attempts, cause: lastErr }
  )
}
