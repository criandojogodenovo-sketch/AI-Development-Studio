// ============================================================
// B.AI PROVIDER — provider OpenAI-compatible para a B.AI
// (server-side ONLY — chaves jamais chegam ao frontend)
//
// - Todas as chamadas passam pelo BAIKeyManager (failover
//   controlado KEY1 → KEY2 para falhas ELEGÍVEIS).
// - Timeout por requisição; máximo 2 tentativas HTTP por chamada
//   lógica (uma por chave) — economia de créditos.
// - NUNCA registra a chave; logs apenas com índice da chave.
// - Endpoint configurável: BAI_BASE_URL (default /v1).
// ============================================================

import { STUDIO_CONFIG } from '../../config'
import { BAIKeyManager } from '../bai-key-manager'
import type { CompletionRequest, CompletionResult, LLMProvider } from '../types'

// Instância compartilhada do key manager por processo (não usa
// globalThis para evitar código antigo sobrevivendo a hot-reload)
const keyManager = new BAIKeyManager()

export interface BAIChatResponse {
  choices?: {
    message?: { content?: string }
    finish_reason?: string
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string; type?: string }
}

export class BAIProvider implements LLMProvider {
  name = 'bai'
  private keyManager: BAIKeyManager

  constructor() {
    this.keyManager = keyManager
  }

  /** Disponível se há chaves B.AI configuradas (sem chamada de rede — economiza créditos) */
  async isAvailable(): Promise<boolean> {
    return this.keyManager.isConfigured()
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const baseUrl = (process.env.BAI_BASE_URL ?? STUDIO_CONFIG.bai.baseUrl).replace(/\/+$/, '')
    const endpoint = `${baseUrl}/chat/completions`
    const timeoutMs = STUDIO_CONFIG.models.requestTimeoutMs
    const started = Date.now()

    // Failover controlado: KEY1 → (falha elegível) → KEY2 → erro controlado
    return this.keyManager.executeWithFailover(async (key, keyIndex) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const controller = new AbortController()
        timer = setTimeout(() => controller.abort(), timeoutMs)

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`, // chave NUNCA registrada/logada
          },
          body: JSON.stringify({
            model: req.model,
            messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
            temperature: req.temperature,
            max_tokens: req.maxTokens,
          }),
          signal: controller.signal,
        })
        if (timer) clearTimeout(timer)

        if (!res.ok) {
          // status anexado para classificação do key manager; corpo truncado
          // apenas com classe/mensagem de erro do provedor (sem material sensível)
          const bodyText = await res.text().catch(() => '')
          let providerMessage = bodyText.slice(0, 300)
          try {
            const parsed = JSON.parse(bodyText) as BAIChatResponse
            if (parsed.error?.message) providerMessage = parsed.error.message.slice(0, 300)
          } catch { /* corpo não-JSON: mantém truncado */ }
          throw Object.assign(
            new Error(`BAI_HTTP_${res.status}: ${providerMessage || 'sem corpo'}`),
            { httpStatus: res.status }
          )
        }

        const json = (await res.json()) as BAIChatResponse
        const choice = json.choices?.[0]
        const content = choice?.message?.content ?? ''
        const finishReason = choice?.finish_reason

        // Alguns provedores retornam HTTP 200 com corpo de erro — não silenciar
        if (json.error?.message) {
          throw Object.assign(
            new Error(`BAI_ERRO_PROVEDOR_200: ${json.error.message.slice(0, 300)}`),
            { httpStatus: 200 }
          )
        }

        if (!content && finishReason !== 'length') {
          // Diagnóstico seguro: estrutura do corpo (sem segredos) para identificar
          // formatos inesperados/modelos inválidos nos logs de runtime
          const bodyPreview = JSON.stringify(json).slice(0, 250)
          console.warn(`[BAIProvider] resposta vazia para model=${req.model} http=200 corpo=${bodyPreview}`)
          throw Object.assign(
            new Error(`BAI_RESPOSTA_VAZIA: corpo=${bodyPreview}`),
            { httpStatus: 200 }
          )
        }

        return {
          content: typeof content === 'string' ? content : JSON.stringify(content),
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          model: req.model,
          durationMs: Date.now() - started,
          finishReason,
        } satisfies CompletionResult
      } catch (err) {
        if (timer) clearTimeout(timer)
        const e = err as Error & { httpStatus?: number }
        // AbortController → timeout local
        if (e.name === 'AbortError') {
          throw Object.assign(new Error('BAI_TIMEOUT'), { timedOut: true })
        }
        // rede (fetch failed, ECONNRESET, etc.) — sem status
        if (!e.httpStatus && /fetch failed|ECONN|network|socket/i.test(e.message ?? '')) {
          const netMsg = `BAI_NETWORK: ${e.message}`
          console.warn(`[BAIProvider] falha de rede (key#${keyIndex}) model=${req.model}: ${String(e.cause ?? e.message).slice(0, 200)}`)
          throw Object.assign(new Error(netMsg), { network: true })
        }
        // erro do provedor (HTTP ou 200-com-erro) — visível nos logs de runtime
        console.warn(`[BAIProvider] falha (key#${keyIndex}) model=${req.model}: ${e.message.slice(0, 250)}`)
        throw e
      }
    })
  }

  /** Snapshot seguro para diagnóstico/UI (sem chaves). */
  keyStatus() {
    return this.keyManager.status()
  }
}
