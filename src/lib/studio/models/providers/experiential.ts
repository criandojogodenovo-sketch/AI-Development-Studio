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
// REGRA REGIONAL (spec): "gpt-6-astra, se bloqueado por região,
// tente fable-5.1" — implementado como retry ÚNICO do modelo
// master com o fallback quando a classe do erro for AUTH
// (403 model_location_not_supported) ou CLIENT_ERROR.
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
   * Retry ÚNICO do modelo master com o fallback regional quando a
   * falha indicar bloqueio por localização/modelo (AUTH/CLIENT_ERROR).
   * Demais modelos e classes propagam sem retry — o ProviderChain decide.
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      return await super.complete(req)
    } catch (err) {
      const e = err as { errorClass?: string }
      const cls = e?.errorClass
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
