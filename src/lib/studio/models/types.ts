// ============================================================
// MODELS — Tipos compartilhados do sistema de modelos
// ============================================================

export type ModelRole = 'master' | 'coding' | 'review' | 'testing' | 'github' | 'deepseek'

/** Providers físicos do sistema (o chain decide a ordem por versão do Poskli). */
export type ProviderName = 'bai' | 'zai' | 'nvidia'

export interface ModelDefinition {
  id: string            // id lógico — nome no provider primário (B.AI); estável p/ uso/auditoria
  label: string         // ex: GLM-5.3-Flash
  role: ModelRole
  /** modelo FÍSICO por provider — o ProviderChain resolve qual usar */
  physical: Partial<Record<ProviderName, string>>
  enabledByDefault: boolean
  description: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
}

export interface CompletionResult {
  content: string
  promptTokens: number
  completionTokens: number
  model: string
  durationMs: number
  /** 'length' = resposta truncada por max_tokens (crítico para o loop de agentes) */
  finishReason?: string
}

export interface LLMProvider {
  name: string
  isAvailable(): Promise<boolean>
  complete(req: CompletionRequest): Promise<CompletionResult>
}

export interface UsageRecord {
  day: string
  model: string
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  errors: number
}

// Registro de erros para roteamento e diagnóstico
export interface ModelCallError extends Error {
  code: 'UNAVAILABLE' | 'DISABLED' | 'TIMEOUT' | 'PROVIDER_ERROR' | 'RATE_LIMIT'
  model?: string
  detail?: unknown
}
