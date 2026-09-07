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
//        SEM dificuldade (compat): coding 30.000·20 · testing 10.000·5 ·
//        review 10.000·5
//        COM dificuldade (ELÁSTICO — TOON): coding 150k–300k ·
//        testing 20k–35k · review 15k–25k (+ master 30k–45k)
//     Excedeu → "Orçamento atingido, a terminar" (para honesto).
//   3. Contexto MÍNIMO por subagente: o orquestrador envia apenas
//      o necessário (tarefa + diff/testes — nunca o projeto todo).
//
// ZERO imports de runtime → testável com node:test.
// ============================================================

export type DelegationRole = 'coding' | 'testing' | 'review'

/** Dificuldade da tarefa (TOON) — orçamento elástico por dificuldade. */
export type TaskDifficulty = 'simple' | 'medium' | 'hard' | 'complex'

export interface SubagentBudget {
  role: DelegationRole
  /** Nome de produto exibido no chat (sem nomes técnicos). */
  label: string
  /** Máximo de tool calls do subagente. */
  maxToolCalls: number
  /** Orçamento de tokens IN+OUT do subagente. */
  maxTokens: number
}

/** Orçamentos por subagente SEM dificuldade (fixos — compat).
 *  Corrigido p/ os ELÁSTICOS quando a dificuldade é conhecida. */
export const SUBAGENT_BUDGETS: Readonly<Record<DelegationRole, SubagentBudget>> = {
  coding: { role: 'coding', label: 'agente de programação', maxToolCalls: 20, maxTokens: 30_000 },
  testing: { role: 'testing', label: 'agente de testes', maxToolCalls: 5, maxTokens: 10_000 },
  review: { role: 'review', label: 'agente de revisão', maxToolCalls: 5, maxTokens: 10_000 },
}

// ---------- ORÇAMENTO ELÁSTICO (pool por dificuldade) ----------

/** Orçamento total do run por papel para cada dificuldade. */
export interface ElasticBudget {
  coding: number
  testing: number
  review: number
  master: number
}

/**
 * ORÇAMENTO ELÁSTICO — o teto de tokens por papel escala com a
 * dificuldade detetada pelo TOON. Motivação: "Faz um site sobre
 * gatos" (simple) morria com MAX_LIMITS_REACHED no teto fixo de
 * 30k do coding; 150k dá folga real, e tarefas complexas
 * recebem até 300k sem inflar o custo das simples.
 */
export const ELASTIC_BUDGETS: Readonly<Record<TaskDifficulty, ElasticBudget>> = {
  simple: { coding: 150_000, testing: 20_000, review: 15_000, master: 30_000 },
  medium: { coding: 200_000, testing: 25_000, review: 18_000, master: 35_000 },
  hard: { coding: 250_000, testing: 30_000, review: 20_000, master: 40_000 },
  complex: { coding: 300_000, testing: 35_000, review: 25_000, master: 45_000 },
}

/** Orçamento elástico do run para a dificuldade (spec do usuário). */
export function getBudgetForTask(difficulty: TaskDifficulty): ElasticBudget {
  return ELASTIC_BUDGETS[difficulty] ?? ELASTIC_BUDGETS.simple
}

/** Tool calls elásticos por papel×dificuldade (coding 20→30, resto 5→10). */
const ELASTIC_TOOL_CALLS: Readonly<Record<TaskDifficulty, Record<DelegationRole, number>>> = {
  simple: { coding: 20, testing: 5, review: 5 },
  medium: { coding: 24, testing: 6, review: 6 },
  hard: { coding: 26, testing: 8, review: 8 },
  complex: { coding: 30, testing: 10, review: 10 },
}

/** Orçamento do papel (coding/testing/review); outros → null.
 *  COM dificuldade → ELÁSTICO (150k–300k no coding) — o fixo de
 *  30k era a causa raiz do MAX_LIMITS_REACHED em runs legítimos. */
export function subagentBudgetFor(role: string, difficulty?: TaskDifficulty): SubagentBudget | null {
  const key = (role ?? '').trim().toLowerCase() as DelegationRole
  if (!(key in SUBAGENT_BUDGETS)) return null
  const base = SUBAGENT_BUDGETS[key]
  if (!difficulty || !(difficulty in ELASTIC_BUDGETS)) return base
  const elastic = getBudgetForTask(difficulty)
  return {
    ...base,
    maxTokens: elastic[key],
    maxToolCalls: ELASTIC_TOOL_CALLS[difficulty][key],
  }
}

export interface BudgetDecision {
  exceeded: boolean
  /** Mensagem honesta quando excedeu ("Orçamento atingido…"). */
  message?: string
}

const BUDGET_STOP_MESSAGE = 'Orçamento atingido, a terminar'

/** Orçamento de TOKENS do subagente excedeu? (opcional: dificuldade elástica). */
export function tokenBudgetDecision(role: string, tokensUsed: number, difficulty?: TaskDifficulty): BudgetDecision {
  const b = subagentBudgetFor(role, difficulty)
  if (!b || tokensUsed < b.maxTokens) return { exceeded: false }
  return {
    exceeded: true,
    message: `${BUDGET_STOP_MESSAGE} — ${b.label} consumiu ${tokensUsed.toLocaleString('pt-PT')} tokens (teto ${b.maxTokens.toLocaleString('pt-PT')})`,
  }
}

/** Orçamento de TOOL CALLS do subagente excedeu? (opcional: dificuldade elástica). */
export function toolBudgetDecision(role: string, toolCallsUsed: number, difficulty?: TaskDifficulty): BudgetDecision {
  const b = subagentBudgetFor(role, difficulty)
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
