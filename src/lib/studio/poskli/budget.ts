// ============================================================
// POSKLI / BUDGET POR NÍVEL (NÚCLEO PURO)
// ============================================================
// FASE 2 da auditoria: limites ESPECÍFICOS por versão do Poskli
// (0.1, 0.2, 0.3.1, 1.0-flash, superagent) para:
//   - nº máximo de tool calls por agente
//   - nº máximo de passos (steps) por agente
//   - tempo máximo por agente
//   - chars de contexto de arquivos (contextBlock)
//
// Evidência que motivou (medição real 2026-09-07):
//   - média de 4.271 tokens IN por passo (contexto reenviado)
//   - run "site sobre gatos": 186.407 tokens / 968s, 98% na
//     fase IMPLEMENTING — sem limites por nível, o 0.1 (barato)
//     queimava o mesmo orçamento do superagent.
//
// Regra: nível BARATO = orçamento MENOR (para de cedo, poupa
// tokens); superagent = orçamento MAIOR (tarefa difícil).
// ZERO imports de runtime → testável com node:test.
// ============================================================

export interface AgentBudget {
  /** Máximo de tool calls por agente (runAgent toolBudget). */
  maxToolCalls: number
  /** Máximo de passos do loop ReAct por agente. */
  maxSteps: number
  /** Timeout por agente (ms). */
  agentTimeoutMs: number
  /** Máximo de chars do bloco de arquivos no contexto (analyze/implement). */
  contextFileChars: number
}

export type BudgetLevel = '0.1' | '0.2' | '0.3.1' | '1.0-flash' | 'superagent'

/** Orçamentos por versão do Poskli (FASE 2 — auditado). */
export const BUDGETS: Readonly<Record<BudgetLevel, AgentBudget>> = {
  // 0.1: nível leve (B.AI puro, Qwen/Hy3) — teto apertado
  '0.1': { maxToolCalls: 12, maxSteps: 10, agentTimeoutMs: 240_000, contextFileChars: 8_000 },
  // 0.2: default (B.AI → NVIDIA) — equilíbrio
  '0.2': { maxToolCalls: 24, maxSteps: 16, agentTimeoutMs: 420_000, contextFileChars: 12_000 },
  // 0.3.1: B.AI → NVIDIA com review GPT-OSS — um pouco mais
  '0.3.1': { maxToolCalls: 30, maxSteps: 18, agentTimeoutMs: 480_000, contextFileChars: 12_000 },
  // 1.0-flash: NVIDIA prioritário — flash: rápido, teto médio
  '1.0-flash': { maxToolCalls: 24, maxSteps: 14, agentTimeoutMs: 420_000, contextFileChars: 10_000 },
  // superagent: projetos difíceis — orçamento máximo
  superagent: { maxToolCalls: 40, maxSteps: 22, agentTimeoutMs: 600_000, contextFileChars: 16_000 },
}

export const DEFAULT_BUDGET_LEVEL: BudgetLevel = '0.2'

/** Normaliza a versão para nível de orçamento (inválido → default). */
export function budgetLevelOf(version: string | undefined | null): BudgetLevel {
  const t = (version ?? '').trim()
  return (t in BUDGETS) ? (t as BudgetLevel) : DEFAULT_BUDGET_LEVEL
}

/** Orçamento do nível (cópia defensiva — nunca mutável pelo caller). */
export function budgetFor(version: string | undefined | null): AgentBudget {
  return { ...BUDGETS[budgetLevelOf(version)] }
}

/** Clamp do orçamento de steps contra a definição do agente (menor vence). */
export function clampSteps(agentMaxSteps: number, budget: AgentBudget): number {
  return Math.max(1, Math.min(agentMaxSteps, budget.maxSteps))
}

/** Clamp do orçamento de tool calls (menor vence). */
export function clampToolCalls(requested: number, budget: AgentBudget): number {
  return Math.max(1, Math.min(requested, budget.maxToolCalls))
}
