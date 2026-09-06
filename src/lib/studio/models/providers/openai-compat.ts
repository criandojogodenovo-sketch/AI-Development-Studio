// ============================================================
// OPENAI-COMPATIBLE PROVIDER BASE — infraestrutura HTTP
// compartilhada (NVIDIA NIM, Experiential Labs). A B.AI mantém o
// BAIProvider dedicado (failover interno de 2 chaves).
//
// - Server-side ONLY — a chave NUNCA é registrada/logada/exposta.
// - Erros classificados (errorClass anexado) para o ProviderChain.
// - Timeout por request (AbortController); 1 tentativa HTTP por
//   chamada — o chain decide o failover (economia de créditos).
// - Modelos de raciocínio (nemotron/gpt-oss/deepseek na NIM):
//   content null + finish=length = truncamento válido (content '');
//   quando o provider entrega a saída em reasoning_content sem
//   content, usa-a defensivamente como conteúdo.
// ============================================================

import { classifyError, type BAIErrorClass } from '../error-classes.ts'
import type { CompletionRequest, CompletionResult, LLMProvider } from '../types.ts'

export interface OpenAICompatChatResponse {
  choices?: {
    message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string; type?: string; code?: string }
}

export interface OpenAICompatOptions {
  /** nome estável do provider (logs/chain — ex: nvidia, explabs) */
  name: string
  /** env var que contém a chave (lida no construtor — nunca exportada) */
  apiKeyEnv: string
  /** env var opcional do endpoint base */
  baseUrlEnv?: string
  /** endpoint default quando env ausente/vazio */
  defaultBaseUrl: string
  requestTimeoutMs: number
}

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(opts: OpenAICompatOptions) {
    this.name = opts.name
    this.apiKey = (process.env[opts.apiKeyEnv] ?? '').trim()
    const raw = opts.baseUrlEnv ? (process.env[opts.baseUrlEnv] ?? '').trim() : ''
    this.baseUrl = (raw || opts.defaultBaseUrl).replace(/\/+$/, '')
    this.timeoutMs = opts.requestTimeoutMs
  }

  /** Chave configurada? (sync, sem rede — usado na resolução do chain) */
  isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  async isAvailable(): Promise<boolean> {
    return this.isConfigured()
  }

  private err(message: string, cls: BAIErrorClass, extra: Record<string, unknown> = {}): Error {
    return Object.assign(new Error(message), { errorClass: cls, ...extra })
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.apiKey) {
      throw this.err(
        `${this.name.toUpperCase()}_CHAVE_AUSENTE: configure a env var do provider no servidor`,
        'AUTH',
        { code: 'NO_KEY' }
      )
    }
    const endpoint = `${this.baseUrl}/chat/completions`
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const controller = new AbortController()
      timer = setTimeout(() => controller.abort(), this.timeoutMs)
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`, // chave NUNCA registrada/logada
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
        const bodyText = await res.text().catch(() => '')
        let providerMessage = bodyText.slice(0, 300)
        try {
          const parsed = JSON.parse(bodyText) as OpenAICompatChatResponse
          if (parsed.error?.message) providerMessage = parsed.error.message.slice(0, 300)
        } catch { /* corpo não-JSON: mantém truncado */ }
        const cls = classifyError({ httpStatus: res.status, message: providerMessage })
        console.warn(`[${this.name}] HTTP ${res.status} (model=${req.model}): ${providerMessage.slice(0, 180)}`)
        throw this.err(
          `${this.name.toUpperCase()}_HTTP_${res.status}: ${providerMessage || 'sem corpo'}`,
          cls,
          { httpStatus: res.status }
        )
      }

      const json = (await res.json()) as OpenAICompatChatResponse
      const choice = json.choices?.[0]
      const finishReason = choice?.finish_reason ?? undefined

      // Alguns provedores retornam HTTP 200 com corpo de erro — não silenciar
      if (json.error?.message) {
        const msg = json.error.message.slice(0, 300)
        const cls: BAIErrorClass = /rate|429|quota|limit/i.test(msg) ? 'RATE_LIMIT' : 'UNKNOWN'
        throw this.err(`${this.name.toUpperCase()}_ERRO_PROVEDOR_200: ${msg}`, cls, { httpStatus: 200 })
      }

      const rawContent = choice?.message?.content
      let content = typeof rawContent === 'string' ? rawContent : ''
      // Modelos de raciocínio (NIM): content null com a resposta em
      // reasoning_content — uso defensivo quando não é truncamento
      if (!content && finishReason !== 'length') {
        const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning
        if (typeof reasoning === 'string' && reasoning.trim()) content = reasoning
      }

      if (!content && finishReason !== 'length') {
        const bodyPreview = JSON.stringify(json).slice(0, 250)
        console.warn(`[${this.name}] resposta vazia (model=${req.model}) corpo=${bodyPreview}`)
        throw this.err(
          `${this.name.toUpperCase()}_RESPOSTA_VAZIA: corpo=${bodyPreview}`,
          'UNKNOWN',
          { httpStatus: 200 }
        )
      }

      return {
        content,
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        model: req.model,
        durationMs: Date.now() - started,
        finishReason,
      }
    } catch (err) {
      if (timer) clearTimeout(timer)
      const e = err as Error & { errorClass?: BAIErrorClass; name?: string; cause?: unknown }
      if (e.errorClass) throw err // já classificado acima
      if (e.name === 'AbortError') {
        throw this.err(`${this.name.toUpperCase()}_TIMEOUT`, 'TIMEOUT', { timedOut: true })
      }
      if (/fetch failed|ECONN|network|socket/i.test(e.message ?? '')) {
        console.warn(
          `[${this.name}] falha de rede (model=${req.model}): ${String(e.cause ?? e.message).slice(0, 200)}`
        )
        throw this.err(`${this.name.toUpperCase()}_NETWORK: ${(e.message ?? '').slice(0, 200)}`, 'NETWORK')
      }
      throw this.err(`${this.name.toUpperCase()}_ERRO: ${(e.message ?? '').slice(0, 200)}`, 'UNKNOWN')
    }
  }
}
