// ============================================================
// PROVIDER CHAIN — roteamento de providers por versão do Poskli
// (POSKLI_VERSION) com failover CONTROLADO entre providers.
//
// NÚCLEO PURO (mesma filosofia do state-machine.ts): imports de
// runtime APENAS de módulos puros com extensão .ts explícita —
// testável isoladamente com node:test.
//
// Chains por versão (spec do produto):
//   0.1          : [BAI]                      (GLM/Qwen/Hy3)
//   0.2          : [BAI, NVIDIA]
//   0.3.1        : [BAI, NVIDIA, EXPLABS*]    (*somente tarefas difíceis)
//   1.0-flash    : [NVIDIA, EXPLABS, BAI]     (BAI como reserva)
//   expposkli-1.0: [EXPLABS] — EXCLUSIVO Experiential
//   expposkli-1.1: [EXPLABS] — EXCLUSIVO Experiential
//
// Versões "expposkli-*" são EXCLUSIVAS da Experiential Labs: nenhum
// outro provider entra no chain — por CONSTRUÇÃO, um failover para
// NVIDIA/B.AI é impossível. Se a Experiential falhar (após o retry
// interno com o modelFallback da versão), o erro é propagado com
// honestidade; sem chave EXPLABS, o chain fica VAZIO (erro controlado).
//
// Sem chaves B.AI (sandbox local): o SDK local (zai) substitui o
// B.AI no chain — a arquitetura de agentes não muda.
//
// POLÍTICA INVARIÁVEL: 429/rate limit NUNCA faz failover — nem
// entre chaves (BAIKeyManager) nem entre providers (aqui).
// Falhas ELEGÍVEIS (rede/5xx/timeout/401-403) avançam no chain;
// CLIENT_ERROR/UNKNOWN não avançam (conservador — economiza créditos).
// BAIKeyError ALL_KEYS_FAILED (2 chaves exauridas em falhas elegíveis)
// avança para o próximo provider.
// ============================================================

import { classifyError, type BAIErrorClass } from './error-classes.ts'
import type { CompletionRequest, CompletionResult, LLMProvider, ProviderName } from './types.ts'

export type PoskliVersion = '0.1' | '0.2' | '0.3.1' | '1.0-flash' | 'expposkli-1.0' | 'expposkli-1.1'
export type Difficulty = 'easy' | 'medium' | 'hard'
export type { ProviderName }

export const POSKLI_VERSIONS: readonly PoskliVersion[] = [
  '0.1', '0.2', '0.3.1', '1.0-flash', 'expposkli-1.0', 'expposkli-1.1',
] as const

/** Versões EXCLUSIVAS da Experiential Labs (spec expposkli-1.0/1.1). */
export const EXCLUSIVE_EXPLABS_VERSIONS: readonly PoskliVersion[] = ['expposkli-1.0', 'expposkli-1.1'] as const

export function isExpposkliVersion(v: PoskliVersion): boolean {
  return (EXCLUSIVE_EXPLABS_VERSIONS as readonly string[]).includes(v)
}

/** Default = versão do Poskli em produção hoje. */
export const DEFAULT_POSKLI_VERSION: PoskliVersion = '0.2'

const CHAINS: Record<PoskliVersion, readonly ProviderName[]> = {
  '0.1': ['bai'],
  '0.2': ['bai', 'nvidia'],
  '0.3.1': ['bai', 'nvidia', 'explabs'],
  '1.0-flash': ['nvidia', 'explabs', 'bai'],
  'expposkli-1.0': ['explabs'],
  'expposkli-1.1': ['explabs'],
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
  /** EXPLABS_API_KEY presente? */
  explabsConfigured: boolean
  difficulty?: Difficulty
}

/** Resolve o chain ORDENADO de providers para a versão + contexto.
 *  Versões expposkli-*: chain = [explabs] (exclusivo) — mesmo que B.AI/
 *  NVIDIA estejam configurados, eles NUNCA entram (sem failover para fora). */
export function resolveChain(version: PoskliVersion, ctx: ChainContext): ProviderName[] {
  let base: readonly ProviderName[] = CHAINS[version]
  // 0.3.1: EXPLABS participa somente de tarefas difíceis (spec)
  if (version === '0.3.1' && (ctx.difficulty ?? 'medium') !== 'hard') {
    base = base.filter((n) => n !== 'explabs')
  }
  const out: ProviderName[] = []
  for (const n of base) {
    if (n === 'bai') {
      out.push(ctx.baiConfigured ? 'bai' : 'zai')
    } else if (n === 'nvidia' && ctx.nvidiaConfigured) {
      out.push('nvidia')
    } else if (n === 'explabs' && ctx.explabsConfigured) {
      out.push('explabs')
    }
  }
  return [...new Set(out)]
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

/** Falhas elegíveis para failover ENTRE providers (429 NUNCA). */
const ELIGIBLE_CLASSES: readonly BAIErrorClass[] = ['SERVER_ERROR', 'NETWORK', 'TIMEOUT', 'AUTH']

export function eligibleForChainFailover(err: unknown): boolean {
  const e = (err ?? {}) as ChainErrorShape
  // POLÍTICA INVARIÁVEL: rate limit NUNCA faz failover
  if (e.code === 'RATE_LIMITED' || e.code === 'RATE_LIMIT') return false
  const cls = errorClassOf(err)
  if (cls === 'RATE_LIMIT') return false
  // BAI exauriu as 2 chaves em falhas elegíveis → próximo provider do chain
  if (e.code === 'ALL_KEYS_FAILED') {
    return e.errorClass === undefined || ELIGIBLE_CLASSES.includes(e.errorClass)
  }
  return ELIGIBLE_CLASSES.includes(cls)
}

// ---------- EXECUÇÃO COM FAILOVER CONTROLADO ----------

export interface ChainEntry {
  provider: ProviderName
  llm: LLMProvider
  /** modelo FÍSICO deste provider para o modelo lógico solicitado */
  model: string
  /** modelo FÍSICO alternativo do MESMO provider (retry interno —
   *  usado nas versões expposkli-*: fallback Experiential→Experiential,
   *  NUNCA um provider externo; 429 nunca dispara retry). */
  modelFallback?: string
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
 * Executa a requisição percorrendo o chain — 1 tentativa por provider.
 *   sucesso                       → retorna {result, provider}
 *   429/rate limit                → propaga IMEDIATAMENTE (política)
 *   falha elegível                → avança para o próximo provider
 *   falha não-elegível            → propaga (conservador)
 *   chain exaurido em elegíveis   → erro controlado com todas as tentativas
 */
export async function executeWithChain(
  entries: readonly ChainEntry[],
  req: Omit<CompletionRequest, 'model'>
): Promise<{ result: CompletionResult; provider: ProviderName; attempts: ChainAttempt[] }> {
  if (entries.length === 0) {
    throw Object.assign(
      new Error('CHAIN_VAZIA: nenhum provider configurado para este modelo/versão'),
      { code: 'UNAVAILABLE' }
    )
  }
  const attempts: ChainAttempt[] = []
  let lastErr: unknown = null
  for (const entry of entries) {
    try {
      const fallback =
        entry.modelFallback && entry.modelFallback !== entry.model ? entry.modelFallback : undefined
      const result = await entry.llm.complete({
        ...req,
        model: entry.model,
        ...(fallback ? { modelFallback: fallback } : {}),
      })
      return { result, provider: entry.provider, attempts }
    } catch (err) {
      lastErr = err
      const cls = errorClassOf(err)
      attempts.push({ provider: entry.provider, errorClass: cls, message: safeMessage(err) })
      if (!eligibleForChainFailover(err)) {
        // 429 / CLIENT_ERROR / UNKNOWN: para aqui — política conservadora
        throw err
      }
      console.warn(
        `[ProviderChain] failover: ${entry.provider} falhou (classe ${cls}, model ${entry.model}) — tentando o próximo provider do chain`
      )
    }
  }
  throw Object.assign(
    new Error(`CHAIN_EXAURIDO: ${attempts.map((a) => `${a.provider}:${a.errorClass}`).join(' → ')}`),
    { code: 'ALL_PROVIDERS_FAILED', attempts, cause: lastErr }
  )
}
