// ============================================================
// POSKLI 0.2 — CLASSIFICAÇÃO DE ERROS (NÚCLEO PURO)
//
// Todo erro do pipeline é CLASSIFICADO — nunca mascarado:
//   catch (error) { status = "success" }  ← PROIBIDO
//
// Taxonomia (spec §31):
//   PROVIDER_RATE_LIMIT | PROVIDER_TIMEOUT | PROVIDER_ERROR |
//   TOOL_FAILURE | COMMAND_FAILURE | BUILD_FAILURE | TEST_FAILURE |
//   IMPLEMENTATION_FAILURE | VALIDATION_FAILURE | WORKSPACE_FAILURE |
//   BUDGET_TIMEOUT | CANCELLED | UNKNOWN_FAILURE
//
// ZERO imports — puro, determinístico, testável isoladamente.
// Mensagens nunca expõem keys/tokens (o provider já mascara; aqui
// só classificamos e produzimos mensagem amigável).
// ============================================================

export type PoskliErrorCode =
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'TOOL_FAILURE'
  | 'COMMAND_FAILURE'
  | 'BUILD_FAILURE'
  | 'TEST_FAILURE'
  | 'IMPLEMENTATION_FAILURE'
  | 'VALIDATION_FAILURE'
  | 'WORKSPACE_FAILURE'
  | 'BUDGET_TIMEOUT'
  | 'CANCELLED'
  | 'UNKNOWN_FAILURE'

export interface ClassifiedError {
  code: PoskliErrorCode
  /** Mensagem amigável (linguagem de produto, sem internals). */
  friendly: string
  /** Pode ser tentado novamente dentro dos limites? */
  retryable: boolean
  /** Detalhe técnico seguro para diagnóstico (já sem segredos). */
  detail: string
}

/** Sanitiza o detalhe: remove possíveis segredos antes de registrar. */
function safeDetail(message: string): string {
  return message
    // tokens/chaves conhecidos → máscara
    .replace(/sk-[a-zA-Z0-9]{16,}/g, '[REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/vcp_[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/npg_[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .slice(0, 400)
}

/** Classifica um erro (objeto Error, string ou unknown) deterministicamente. */
export function classifyError(err: unknown): ClassifiedError {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const msg = raw
  const detail = safeDetail(raw || 'erro sem mensagem')

  // ---- rate limit (política: failover NÃO aplicado; jamais vira sucesso) ----
  if (
    /BAI_RATE_LIMIT/i.test(msg) ||
    /\b429\b/.test(msg) ||
    /too many requests/i.test(msg) ||
    /rate[ _-]?limit/i.test(msg)
  ) {
    return {
      code: 'PROVIDER_RATE_LIMIT',
      friendly: 'Limite de requisições do provedor de IA atingido durante esta etapa.',
      retryable: false, // política atual: sem failover para rate limits
      detail,
    }
  }

  // ---- timeouts ----
  if (/BAI_TIMEOUT/i.test(msg) || /PROVIDER_TIMEOUT/i.test(msg)) {
    return {
      code: 'PROVIDER_TIMEOUT',
      friendly: 'O provedor de IA não respondeu dentro do tempo limite.',
      retryable: true,
      detail,
    }
  }
  if (/^TIMEOUT:|^BUDGET|orçamento de \d+s esgotado/i.test(msg)) {
    return {
      code: 'BUDGET_TIMEOUT',
      friendly: 'O tempo total disponível para a execução foi esgotado.',
      retryable: false,
      detail,
    }
  }

  // ---- provedor ----
  if (/^BAI_HTTP_5\d\d/i.test(msg) || /BAI_FALHA|BAI_ERRO_PROVEDOR|BAI_RESPOSTA_VAZIA|network|ENOTFOUND|ECONNRESET|ECONNREFUSED|fetch failed/i.test(msg)) {
    return {
      code: 'PROVIDER_ERROR',
      friendly: 'Falha de comunicação com o provedor de IA.',
      retryable: true,
      detail,
    }
  }

  // ---- workspace ----
  if (/ENOENT|EACCES|EPERM|WORKSPACE|workspace não encontrado|EPERM/i.test(msg)) {
    return {
      code: 'WORKSPACE_FAILURE',
      friendly: 'Falha ao acessar o workspace do projeto.',
      retryable: false,
      detail,
    }
  }

  // ---- comandos / build / testes ----
  if (/exit code \d+|^npm (run )?build/i.test(msg) && /build/i.test(msg)) {
    return { code: 'BUILD_FAILURE', friendly: 'O build do projeto falhou.', retryable: true, detail }
  }
  if (/TEST_FAILURE|testes falharam/i.test(msg)) {
    return { code: 'TEST_FAILURE', friendly: 'Os testes automatizados falharam.', retryable: true, detail }
  }
  if (/COMMAND_FAILURE|comando falhou/i.test(msg)) {
    return { code: 'COMMAND_FAILURE', friendly: 'Um comando executado no terminal falhou.', retryable: true, detail }
  }

  // ---- ferramentas ----
  if (/TOOL_CRASH|TOOL_FAILURE|ferramenta/i.test(msg)) {
    return { code: 'TOOL_FAILURE', friendly: 'Uma ferramenta do agente falhou ao executar.', retryable: true, detail }
  }

  // ---- implementação ----
  if (/IMPLEMENTATION_FAILURE|implementação falhou/i.test(msg)) {
    return { code: 'IMPLEMENTATION_FAILURE', friendly: 'A implementação não pôde ser concluída.', retryable: true, detail }
  }

  // ---- validação ----
  if (/VALIDATION_FAILURE|validação falhou/i.test(msg)) {
    return { code: 'VALIDATION_FAILURE', friendly: 'A validação do resultado falhou.', retryable: true, detail }
  }

  // ---- cancelamento ----
  if (/CANCELLED|cancelado/i.test(msg)) {
    return { code: 'CANCELLED', friendly: 'Execução cancelada.', retryable: false, detail }
  }

  // ---- agente/provedor genérico (ERRO_DO_AGENTE, DEEPSEEK_BLOQUEADO etc.) ----
  if (/ERRO_DO_AGENTE|BAI_HTTP_|DEEPSEEK|PROVIDER/i.test(msg)) {
    return {
      code: 'PROVIDER_ERROR',
      friendly: 'O agente de IA não conseguiu concluir esta etapa.',
      retryable: true,
      detail,
    }
  }

  return {
    code: 'UNKNOWN_FAILURE',
    friendly: 'Falha inesperada durante a execução.',
    retryable: true,
    detail,
  }
}

/** Registro estruturado de rate limit (spec §13) — sem expor segredo. */
export interface RateLimitRecord {
  provider: string
  stage: string
  attempt: number
  keyLabel: string // ex.: "key#1" — NUNCA a key
  errorType: PoskliErrorCode
  policy: string
  retried: boolean
  outcome: string
}

export function rateLimitRecord(
  stage: string,
  attempt: number,
  keyLabel: string,
  retried: boolean,
  outcome: string
): RateLimitRecord {
  return {
    provider: 'BAI',
    stage,
    attempt,
    keyLabel,
    errorType: 'PROVIDER_RATE_LIMIT',
    policy: 'failover NÃO aplicado a rate limits',
    retried,
    outcome,
  }
}
