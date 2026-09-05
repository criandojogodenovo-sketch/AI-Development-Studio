// ============================================================
// MODELS / PROVIDER ZAI — provider REAL funcional
// Usa z-ai-web-dev-sdk (backend only). Config em /etc/.z-ai-config.
// Este é o motor LLM real validado por smoke test.
// ============================================================

import ZAI from 'z-ai-web-dev-sdk'
import { STUDIO_CONFIG } from '../../config'
import type { CompletionRequest, CompletionResult, LLMProvider } from '../types'
interface ZAIInstance {
  chat: {
    completions: {
      create: (params: {
        messages: { role: string; content: string }[]
        thinking?: { type: string }
        temperature?: number
        max_tokens?: number
      }) => Promise<{
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }>
    }
  }
}

let zaiInstance: ZAIInstance | null = null
let zaiReady: Promise<ZAIInstance> | null = null

async function getZAI(): Promise<ZAIInstance> {
  if (zaiInstance) return zaiInstance
  if (!zaiReady) {
    zaiReady = ZAI.create() as Promise<ZAIInstance>
    zaiInstance = await zaiReady
  }
  return zaiInstance!
}

export class ZAIProvider implements LLMProvider {
  name = 'zai'

  async isAvailable(): Promise<boolean> {
    try {
      await getZAI()
      return true
    } catch {
      return false
    }
  }

  /**
   * Chamada com RETRY + BACKOFF exponencial para 429/5xx.
   * Limites: 5 tentativas, delay 2s→ 4s→ 8s→ 16s→ 32s (+ jitter).
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const zai = await getZAI()
    const started = Date.now()
    const timeoutMs = STUDIO_CONFIG.models.requestTimeoutMs
    const MAX_RETRIES = 5

    let lastError: Error | null = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const completion = await Promise.race([
          zai.chat.completions.create({
            messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
            thinking: { type: 'disabled' },
            temperature: req.temperature,
            max_tokens: req.maxTokens,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Object.assign(new Error('MODEL_TIMEOUT'), { code: 'TIMEOUT' })),
              timeoutMs
            )
          }),
        ])
        if (timer) clearTimeout(timer)

        const choice = completion?.choices?.[0]
        const content = choice?.message?.content ?? ''
        return {
          content: typeof content === 'string' ? content : JSON.stringify(content),
          promptTokens: completion?.usage?.prompt_tokens ?? 0,
          completionTokens: completion?.usage?.completion_tokens ?? 0,
          model: req.model,
          durationMs: Date.now() - started,
          finishReason: (choice?.finish_reason as string | undefined) ?? undefined,
        }
      } catch (err) {
        if (timer) clearTimeout(timer)
        const e = err as Error & { code?: string }
        lastError = e
        const isRateLimit = /429|too many requests/i.test(e.message ?? '')
        const isTransient = /5\d\d|ECONNRESET|ETIMEDOUT|fetch failed/i.test(e.message ?? '')
        if ((isRateLimit || isTransient) && attempt < MAX_RETRIES) {
          const delay = Math.min(2000 * 2 ** attempt, 32_000) + Math.random() * 1000
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        throw Object.assign(
          new Error(`ZAI_PROVIDER_ERROR: ${e.message}`),
          { code: isRateLimit ? 'RATE_LIMIT' : 'PROVIDER_ERROR', detail: e.message }
        )
      }
    }
    throw Object.assign(
      new Error(`ZAI_PROVIDER_ERROR: ${lastError?.message ?? 'desconhecido'}`),
      { code: 'PROVIDER_ERROR' }
    )
  }
}
