// ============================================================
// NVIDIA PROVIDER — NIM (integrate.api.nvidia.com), OpenAI-compatible
// Server-side ONLY. Catálogo por papel (ids validados AO VIVO em
// 2026-09-06 contra GET /v1/models do endpoint):
//   master: nvidia/nemotron-3-super-120b-a12b        ✔ existe
//   coding: deepseek-ai/deepseek-v4-flash-0731       ✔ existe (cold start lento)
//   review: openai/gpt-oss-20b                       ✔ existe
// Configuráveis: NVIDIA_MODEL_MASTER / _CODING / _REVIEW.
// ============================================================

import { STUDIO_CONFIG } from '../../config.ts'
import { OpenAICompatProvider } from './openai-compat.ts'

function envModel(v: string | undefined, fallback: string): string {
  const t = (v ?? '').trim()
  return t || fallback
}

export const NVIDIA_MODEL_CATALOG = {
  master: envModel(process.env.NVIDIA_MODEL_MASTER, 'nvidia/nemotron-3-super-120b-a12b'),
  coding: envModel(process.env.NVIDIA_MODEL_CODING, 'deepseek-ai/deepseek-v4-flash-0731'),
  review: envModel(process.env.NVIDIA_MODEL_REVIEW, 'openai/gpt-oss-20b'),
} as const

export class NVIDIAProvider extends OpenAICompatProvider {
  constructor() {
    super({
      name: 'nvidia',
      apiKeyEnv: 'NVIDIA_API_KEY',
      baseUrlEnv: 'NVIDIA_BASE_URL',
      defaultBaseUrl: STUDIO_CONFIG.nvidia.baseUrl,
      requestTimeoutMs: STUDIO_CONFIG.models.requestTimeoutMs,
    })
  }
}
