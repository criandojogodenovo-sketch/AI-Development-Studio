// ============================================================
// POSKLI / AGENT POOL — pool de modelos por dificuldade
// ============================================================
// O sistema FIXAVA um único modelo por papel (master/coding/review)
// por versão do Poskli — pouco flexível e caro em tokens. Este
// módulo introduz o POOL DINÂMICO: o master classifica a
// dificuldade do pedido (via TOON) e o router seleciona os
// agentes (modelos) por dificuldade:
//
//   simple : master Mimo·Qwen      coding GPT-OSS-20B     review Mimo·Qwen
//   medium : master Llama·Nemotron coding DeepSeek-V4     review Qwen
//   hard   : master Mimo·Qwen      coding GLM-5.3         review Mimo·Qwen
//   complex: master Llama·Nemotron coding Hy3 ou GLM-5.3  review Qwen
//
// Em `complex` o coding ALTERNA: Hy3 quando a tarefa exige
// pesquisa/contexto amplo; GLM-5.3 quando é lógica pura.
//
// NOMES DE PRODUTO × MODELOS LÓGICOS do registry (router.ts):
//   'mimo-v2.5'                → qwen     (B.AI, classe flash — leve/rápido)
//   'meta/llama-3.3-70b-instr'→ nemotron (NVIDIA, grande porte — robusto)
//   'gpt-oss-20b'              → gpt-oss  (NVIDIA openai/gpt-oss-20b)
//   'deepseek-v4-flash-0731'   → deepseek (NVIDIA deepseek-v4-flash-0731)
//   'glm-5.3'                  → glm      (B.AI glm-5.3-flash)
//   'hy3'                      → hy3      (B.AI hy3)
//   'qwen'                     → qwen     (B.AI qwen3.8-flash)
//
// ZERO imports de runtime → testável com node:test.
// ============================================================

import type { Difficulty, TaskKind } from './toon.ts'

export type { Difficulty, TaskKind }

export type AgentRole = 'master' | 'coding' | 'review'

export interface AgentPool {
  master: string[]
  coding: string[]
  review: string[]
}

/** Todos os modelos do pool por papel (nomes de produto).
 *  Manter sincronizado com instructions.json. */
export const POOL: AgentPool = {
  master: ['mimo-v2.5', 'meta/llama-3.3-70b-instruct'],
  coding: ['gpt-oss-20b', 'deepseek-v4-flash-0731', 'glm-5.3', 'hy3'],
  review: ['mimo-v2.5', 'qwen'],
}

export interface RoleAssignment {
  master: string
  coding: string
  review: string
}

/** Seleção por dificuldade (nomes de produto — spec do usuário). */
export const DIFFICULTY_MAP: Readonly<Record<Difficulty, RoleAssignment>> = {
  simple: {
    master: 'mimo-v2.5',
    coding: 'gpt-oss-20b', // rápido e barato para tarefas leves
    review: 'mimo-v2.5',
  },
  medium: {
    master: 'meta/llama-3.3-70b-instruct',
    coding: 'deepseek-v4-flash-0731', // equilíbrio para tarefas médias
    review: 'qwen',
  },
  hard: {
    master: 'mimo-v2.5',
    coding: 'glm-5.3', // raciocínio forte para tarefas difíceis
    review: 'mimo-v2.5',
  },
  complex: {
    master: 'meta/llama-3.3-70b-instruct',
    coding: 'hy3', // excelente em pesquisa/raciocínio complexo (ou GLM-5.3)
    review: 'qwen',
  },
}

/** Seleciona o trio de agentes (nomes de produto) por dificuldade. */
export function selectAgentsForTask(difficulty: Difficulty): RoleAssignment {
  return DIFFICULTY_MAP[difficulty]
}

/** Contexto usado APENAS em tarefas complex para alternar o coding. */
export type ComplexContext = 'research' | 'logic' | 'default'

/** complex: pesquisa/contexto amplo → hy3 · lógica pura → glm-5.3. */
export function selectCodingForComplex(context: ComplexContext): string {
  switch (context) {
    case 'research':
      return 'hy3'
    case 'logic':
      return 'glm-5.3'
    default:
      return 'hy3'
  }
}

/** Resolve UM agente (nome de produto) para o papel. */
export function resolveAgent(
  role: AgentRole,
  difficulty: Difficulty,
  complexContext: ComplexContext = 'default',
): string {
  const trio = DIFFICULTY_MAP[difficulty]
  if (role === 'coding' && difficulty === 'complex') {
    return selectCodingForComplex(complexContext)
  }
  return trio[role] ?? POOL[role][0]
}

export const DIFFICULTIES: readonly Difficulty[] = ['simple', 'medium', 'hard', 'complex']

export function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value)
}

// ---------- ROTAS (paradas provider + modelo LÓGICO) ----------

/** Parada de rota compatível com RouteStop do chain.ts (router resolve). */
export interface PoolRouteStop {
  provider: 'bai' | 'nvidia'
  /** modelo LÓGICO do registry (chave do LOGICAL_TO_REGISTRY no router). */
  model: string
  onRateLimit?: 'retry-backoff' | 'switch-now' | 'retry-then-switch'
}

/** Nomes de produto → modelos LÓGICOS do registry. */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  'mimo-v2.5': 'qwen',
  'meta/llama-3.3-70b-instruct': 'nemotron',
  'gpt-oss-20b': 'gpt-oss',
  'deepseek-v4-flash-0731': 'deepseek',
  'glm-5.3': 'glm',
  hy3: 'hy3',
  qwen: 'qwen',
}

/** Perfil da tarefa detetado pelo TOON (o router lê via ALS). */
export interface TaskProfile {
  difficulty: Difficulty
  kind: TaskKind
}

const ROUTES: Readonly<Record<Difficulty, Readonly<Record<AgentRole, readonly PoolRouteStop[]>>>> = {
  // leve: paradas flash (B.AI) com reserva NVIDIA — custo mínimo
  simple: {
    master: [
      { provider: 'bai', model: 'qwen', onRateLimit: 'retry-then-switch' },
      { provider: 'nvidia', model: 'nemotron' },
    ],
    coding: [
      { provider: 'nvidia', model: 'gpt-oss', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', model: 'qwen' },
    ],
    review: [
      { provider: 'bai', model: 'qwen', onRateLimit: 'retry-then-switch' },
      { provider: 'nvidia', model: 'gpt-oss' },
    ],
  },
  // médio: NVIDIA prioritário (nemotron/deepseek) com reserva B.AI
  medium: {
    master: [
      { provider: 'nvidia', model: 'nemotron', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', model: 'glm' },
    ],
    coding: [
      { provider: 'nvidia', model: 'deepseek', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', model: 'qwen' },
    ],
    review: [
      { provider: 'bai', model: 'qwen', onRateLimit: 'retry-then-switch' },
      { provider: 'nvidia', model: 'gpt-oss' },
    ],
  },
  // difícil: coding GLM-5.3 (raciocínio) com reservas
  hard: {
    master: [
      { provider: 'bai', model: 'qwen', onRateLimit: 'retry-then-switch' },
      { provider: 'nvidia', model: 'nemotron' },
    ],
    coding: [
      { provider: 'bai', model: 'glm', onRateLimit: 'retry-then-switch' },
      { provider: 'nvidia', model: 'deepseek' },
    ],
    review: [
      { provider: 'bai', model: 'qwen', onRateLimit: 'retry-then-switch' },
      { provider: 'nvidia', model: 'gpt-oss' },
    ],
  },
  // complexo: coding alterna hy3 (pesquisa) / glm-5.3 (lógica)
  complex: {
    master: [
      { provider: 'nvidia', model: 'nemotron', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', model: 'glm' },
    ],
    coding: [
      { provider: 'bai', model: 'hy3', onRateLimit: 'switch-now' },
      { provider: 'bai', model: 'qwen', onRateLimit: 'retry-then-switch' },
      { provider: 'nvidia', model: 'deepseek' },
    ],
    review: [
      { provider: 'nvidia', model: 'gpt-oss', onRateLimit: 'retry-then-switch' },
      { provider: 'bai', model: 'qwen' },
    ],
  },
}

/** Coding de complex: hy3 (research) ou glm-5.3 (logic), com reservas. */
const COMPLEX_CODING: Readonly<Record<'research' | 'logic', readonly PoolRouteStop[]>> = {
  research: [
    { provider: 'bai', model: 'hy3', onRateLimit: 'switch-now' },
    { provider: 'bai', model: 'qwen', onRateLimit: 'retry-then-switch' },
    { provider: 'nvidia', model: 'deepseek' },
  ],
  logic: [
    { provider: 'bai', model: 'glm', onRateLimit: 'retry-then-switch' },
    { provider: 'bai', model: 'qwen', onRateLimit: 'switch-now' },
    { provider: 'nvidia', model: 'deepseek' },
  ],
}

/** Contexto complex derivado do kind do TOON. */
export function complexContextOf(kind: TaskKind): ComplexContext {
  if (kind === 'research') return 'research'
  if (kind === 'logic') return 'logic'
  return 'default'
}

/**
 * Rotas por papel para o perfil da tarefa (master analisa → router
 * executa). Em complex, o coding alternante entra no lugar da
 * parada única: research → hy3 · logic → glm-5.3.
 */
export function routesForTaskProfile(profile: TaskProfile): Record<AgentRole, PoolRouteStop[]> {
  const base = ROUTES[profile.difficulty]
  if (profile.difficulty === 'complex') {
    const cc = complexContextOf(profile.kind)
    const coding = cc === 'logic' ? COMPLEX_CODING.logic : COMPLEX_CODING.research
    return {
      master: [...base.master],
      coding: [...coding],
      review: [...base.review],
    }
  }
  return {
    master: [...base.master],
    coding: [...base.coding],
    review: [...base.review],
  }
}

/** Agentes (nomes de produto) para o perfil — usado em eventos/UI. */
export function agentsForProfile(profile: TaskProfile): RoleAssignment {
  const trio = DIFFICULTY_MAP[profile.difficulty]
  if (profile.difficulty === 'complex') {
    return { ...trio, coding: selectCodingForComplex(complexContextOf(profile.kind)) }
  }
  return { ...trio }
}
