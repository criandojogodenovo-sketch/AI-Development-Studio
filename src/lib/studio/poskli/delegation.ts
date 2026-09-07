// ============================================================
// POSKLI / DELEGAÇÃO (NÚCLEO PURO) — orquestrador + subagentes
// ============================================================
// Arquitetura de delegação visível (refactor do fluxo):
//   MASTER (orquestrador) — analisa, planeja e DELEGA; NUNCA
//   escreve código nem executa testes diretamente.
//     ├── Coding Agent  (agente de programação)
//     ├── Testing Agent (agente de testes)
//     └── Review Agent  (agente de revisão)
//
// REGRAS (anti-loop / anti-gasto):
//   1. SÓ o orquestrador delega (canDelegate). Subagentes NUNCA
//      comunicam diretamente entre si — todo resultado volta ao
//      orquestrador, que decide o próximo passo.
//   2. Cada subagente tem ORÇAMENTO PRÓPRIO (tokens + tool calls):
//        coding: 30.000 tokens · 20 tool calls
//        testing: 10.000 tokens · 5 tool calls
//        review: 10.000 tokens · 5 tool calls
//     Excedeu → "Orçamento atingido, a terminar" (para honesto).
//   3. Contexto MÍNIMO por subagente: o orquestrador envia apenas
//      o necessário (tarefa + diff/testes — nunca o projeto todo).
//
// ZERO imports de runtime → testável com node:test.
// ============================================================

export type DelegationRole = 'coding' | 'testing' | 'review'

export interface SubagentBudget {
  role: DelegationRole
  /** Nome de produto exibido no chat (sem nomes técnicos). */
  label: string
  /** Máximo de tool calls do subagente. */
  maxToolCalls: number
  /** Orçamento de tokens IN+OUT do subagente. */
  maxTokens: number
}

/** Orçamentos por subagente (pedido do usuário). */
export const SUBAGENT_BUDGETS: Readonly<Record<DelegationRole, SubagentBudget>> = {
  coding: { role: 'coding', label: 'agente de programação', maxToolCalls: 20, maxTokens: 30_000 },
  testing: { role: 'testing', label: 'agente de testes', maxToolCalls: 5, maxTokens: 10_000 },
  review: { role: 'review', label: 'agente de revisão', maxToolCalls: 5, maxTokens: 10_000 },
}

/** Orçamento do papel (coding/testing/review); outros → null. */
export function subagentBudgetFor(role: string): SubagentBudget | null {
  const key = (role ?? '').trim().toLowerCase() as DelegationRole
  return key in SUBAGENT_BUDGETS ? SUBAGENT_BUDGETS[key] : null
}

export interface BudgetDecision {
  exceeded: boolean
  /** Mensagem honesta quando excedeu ("Orçamento atingido…"). */
  message?: string
}

const BUDGET_STOP_MESSAGE = 'Orçamento atingido, a terminar'

/** Orçamento de TOKENS do subagente excedeu? */
export function tokenBudgetDecision(role: string, tokensUsed: number): BudgetDecision {
  const b = subagentBudgetFor(role)
  if (!b || tokensUsed < b.maxTokens) return { exceeded: false }
  return {
    exceeded: true,
    message: `${BUDGET_STOP_MESSAGE} — ${b.label} consumiu ${tokensUsed.toLocaleString('pt-PT')} tokens (teto ${b.maxTokens.toLocaleString('pt-PT')})`,
  }
}

/** Orçamento de TOOL CALLS do subagente excedeu? */
export function toolBudgetDecision(role: string, toolCallsUsed: number): BudgetDecision {
  const b = subagentBudgetFor(role)
  if (!b || toolCallsUsed < b.maxToolCalls) return { exceeded: false }
  return {
    exceeded: true,
    message: `${BUDGET_STOP_MESSAGE} — ${b.label} já usou ${toolCallsUsed} chamadas de ferramenta (teto ${b.maxToolCalls})`,
  }
}

/**
 * QUEM pode delegar a QUEM: apenas o orquestrador (master) delega
 * aos subagentes. Subagentes JAMAIS se comunicam diretamente entre
 * si (coding→testing, testing→review, etc. são proibidos) — todo
 * o fluxo passa pelo orquestrador, que decide o próximo passo.
 */
export function canDelegate(fromAgent: string, toRole: string): boolean {
  if ((fromAgent ?? '').trim().toLowerCase() !== 'master') return false
  return subagentBudgetFor(toRole) !== null
}

/** Clamp do orçamento do subagente contra o nível do Poskli
 *  (0.1/0.2/…/superagent) — o MENOR vence. */
export function clampSubagentBudgets(
  levelBudget: { maxToolCalls: number },
  sub: SubagentBudget
): { maxToolCalls: number; tokenBudget: number } {
  return {
    maxToolCalls: Math.max(1, Math.min(levelBudget.maxToolCalls, sub.maxToolCalls)),
    tokenBudget: sub.maxTokens,
  }
}

/** Frase natural da fase de delegação no chat. */
export function delegationMessage(taskTitle: string, role: string): string {
  const b = subagentBudgetFor(role)
  const label = b ? b.label : 'agente especializado'
  return `A delegar «${taskTitle.slice(0, 60)}» ao ${label}…`
}

/** Label de produto do subagente (fallback: agente especializado). */
export function delegationLabel(role: string): string {
  return subagentBudgetFor(role)?.label ?? 'agente especializado'
}
