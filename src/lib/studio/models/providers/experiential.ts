// ============================================================
// EXPERIENTIAL LABS PROVIDER (env: EXPLABS_*) — api.experientiallabs.ai
// OpenAI-compatible, server-side ONLY. Catálogo (ids validados AO
// VIVO em 2026-09-06 contra GET /v1/models — 313 modelos):
//   master         : gpt-6-astra      ✔ existe (sujeito a bloqueio por localização)
//   masterFallback : claude-fable-5.1 ✔ existe (não há "fable-5.1" simples no catálogo)
//   coding         : claude-fable-5.1
//   review         : claude-fable-5.1
// Configuráveis: EXPLABS_MODEL_MASTER / _MASTER_FALLBACK / _CODING / _REVIEW.
//
// RETRY DE MODELO (2 caminhos, 1 tentativa extra no MÁXIMO):
//   A) req.modelFallback EXPLÍCITO (versões expposkli-1.0/1.1 — o
//      ModelRouter injeta o modelo alternativo da versão): retry
//      quando a falha for elegível (AUTH/CLIENT_ERROR/SERVER_ERROR/
//      NETWORK/TIMEOUT). 429/rate limit NUNCA dispara retry.
//      Fallback Experiential→Experiential apenas — a versão é
//      exclusiva, NUNCA um provider externo.
//   B) LEGADO (catálogo global, sem modelFallback explícito): retry
//      ÚNICO do modelo master com o masterFallback quando a classe
//      do erro for AUTH (403 model_location_not_supported) ou
//      CLIENT_ERROR — comportamento histórico preservado.
// ============================================================

import { STUDIO_CONFIG } from '../../config.ts'
import { OpenAICompatProvider } from './openai-compat.ts'
import type { CompletionRequest, CompletionResult } from '../types.ts'

function envModel(v: string | undefined, fallback: string): string {
  const t = (v ?? '').trim()
  return t || fallback
}

export const EXPLABS_MODEL_CATALOG = {
  master: envModel(process.env.EXPLABS_MODEL_MASTER, 'gpt-6-astra'),
  masterFallback: envModel(process.env.EXPLABS_MODEL_MASTER_FALLBACK, 'claude-fable-5.1'),
  coding: envModel(process.env.EXPLABS_MODEL_CODING, 'claude-fable-5.1'),
  review: envModel(process.env.EXPLABS_MODEL_REVIEW, 'claude-fable-5.1'),
} as const

/** Classes que autorizam o retry com modelFallback EXPLÍCITO (429 NUNCA). */
const EXPLICIT_FALLBACK_CLASSES: readonly string[] = [
  'AUTH', 'CLIENT_ERROR', 'SERVER_ERROR', 'NETWORK', 'TIMEOUT',
]

export class ExperientialProvider extends OpenAICompatProvider {
  constructor() {
    super({
      name: 'explabs',
      apiKeyEnv: 'EXPLABS_API_KEY',
      baseUrlEnv: 'EXPLABS_BASE_URL',
      defaultBaseUrl: STUDIO_CONFIG.explabs.baseUrl,
      requestTimeoutMs: STUDIO_CONFIG.models.requestTimeoutMs,
    })
  }

  /**
   * Retry ÚNICO de modelo (A explícito p/ expposkli-*; B legado do
   * master regional). Demais casos propagam sem retry — o
   * ProviderChain decide. POLÍTICA INVARIÁVEL: 429 nunca tenta.
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      return await super.complete(req)
    } catch (err) {
      const e = err as { errorClass?: string; code?: string }
      const cls = e?.errorClass

      // POLÍTICA INVARIÁVEL: rate limit NUNCA dispara retry de modelo
      if (cls === 'RATE_LIMIT' || e?.code === 'RATE_LIMITED' || e?.code === 'RATE_LIMIT') {
        throw err
      }

      // (A) modelFallback explícito — versões expposkli-1.0/1.1
      const explicit = req.modelFallback && req.modelFallback !== req.model ? req.modelFallback : undefined
      if (explicit && cls && EXPLICIT_FALLBACK_CLASSES.includes(cls)) {
        console.warn(
          `[explabs] modelo "${req.model}" falhou (classe ${cls}) — tentando modelo alternativo da Experiential "${explicit}"`
        )
        return await super.complete({ ...req, model: explicit })
      }

      // (B) LEGADO: fallback regional do master (catálogo global)
      const isMaster = req.model === EXPLABS_MODEL_CATALOG.master
      const fallback = EXPLABS_MODEL_CATALOG.masterFallback
      const blockish = cls === 'AUTH' || cls === 'CLIENT_ERROR'
      if (isMaster && blockish && fallback && fallback !== req.model) {
        console.warn(
          `[explabs] master "${req.model}" bloqueado (classe ${cls}) — tentando fallback regional "${fallback}"`
        )
        return await super.complete({ ...req, model: fallback })
      }
      throw err
    }
  }
}
