// ============================================================
// POSKLI 0.2 — MÁQUINA DE ESTADOS DETERMINÍSTICA (NÚCLEO PURO)
//
// REGRA FUNDAMENTAL (spec Poskli 0.2):
//   "Concluído" somente quando os critérios REAIS de conclusão
//   forem satisfeitos. Terminou de executar ≠ concluiu.
//   Falso positivo de conclusão é ERRO CRÍTICO.
//
// Este módulo é a FONTE ÚNICA DE VERDADE do resultado global.
//   - ZERO imports (puro, determinístico, testável isoladamente)
//   - Backend persiste o resultado de deriveFinalStatus()
//   - Frontend consome o MESMO estado lógico (run.derived)
//   - Nunca deriva sucesso de um único boolean (npm test)
//
// Estados globais: SUCCESS | FAILED | BLOCKED | PARTIAL | CANCELLED
// Fases operacionais: ANALYZING → PLANNING → IMPLEMENTING →
//   TESTING → (CORRECTING → TESTING)* → REVIEWING → VERIFYING
// ============================================================

// ---------- TIPOS (erasable-only: sem enums) ----------

export type PoskliGlobalState =
  | 'PENDING' | 'RUNNING'
  | 'SUCCESS' | 'FAILED' | 'BLOCKED' | 'PARTIAL' | 'CANCELLED'

export type PoskliPhase =
  | 'ANALYZING' | 'PLANNING' | 'IMPLEMENTING' | 'TESTING'
  | 'CORRECTING' | 'REVIEWING' | 'VERIFYING'

/** Estado persistido em run.state (terminal = exibido na UI). */
export type PoskliTerminalState = 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'PARTIAL' | 'CANCELLED'

export type TaskSnapshotStatus =
  | 'PENDING' | 'RUNNING' | 'BLOCKED' | 'FAILED' | 'REVIEWING' | 'COMPLETED' | 'CANCELLED'

export type TestRecordStatus = 'PASS' | 'FAIL'

export type CorrectionState = 'PLANNED' | 'STARTED' | 'COMPLETED' | 'FAILED' | 'BLOCKED'

export type ReviewStatus = 'NOT_RUN' | 'PASS' | 'CHANGES_REQUESTED' | 'FAILED' | 'BLOCKED'

export type CheckStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_APPLICABLE'

export interface TaskSnapshot {
  id: string
  title?: string
  status: TaskSnapshotStatus
  /** Tarefa obrigatória (default: true — conservador). */
  required?: boolean
  attempts?: number
  agentRole?: string
}

export interface TestRecordSnapshot {
  id: string
  status: TestRecordStatus
  command?: string
  executionId?: string
  /** Quando rodou: INITIAL | AFTER_CORRECTION | POST_REVIEW | FINAL */
  trigger?: string
  exitCode?: number | null
  ts?: string
}

export interface CorrectionSnapshot {
  id: string
  state: CorrectionState
  /** Motivo que disparou: TEST_FAILURE | REVIEW_CHANGES */
  trigger?: string
  attempt?: number
}

export interface ReviewSnapshot {
  status: ReviewStatus
  verdict?: string
  /** Código do bloqueio (ex.: PROVIDER_RATE_LIMIT) quando status=BLOCKED. */
  blockedReason?: string
  attempts?: number
}

export interface VerificationCheck {
  id: string
  label: string
  required: boolean
  status: CheckStatus
  evidence: string
}

export interface VerificationResult {
  ran: boolean
  checks: VerificationCheck[]
}

export interface DeriveFinalStatusInput {
  /** Run cancelado cooperativamente pelo usuário. */
  cancelled: boolean
  /** Run terminou SEM percorrer o fluxo completo (crash/stale/freeze). */
  interrupted: boolean
  /** Snapshots FINAIS das tarefas do grafo desta execução. */
  tasks: TaskSnapshot[]
  /** Registros de teste em ORDEM CRONOLÓGICA. */
  tests: TestRecordSnapshot[]
  review: ReviewSnapshot
  corrections: CorrectionSnapshot[]
  verification: VerificationResult | null
  /** Testes são requisito de conclusão (default: inferido conservador). */
  testsRequired?: boolean
  /** Revisão é requisito (default: true). */
  reviewRequired?: boolean
}

export interface Criterion {
  id: string
  label: string
  status: 'PASS' | 'FAIL' | 'BLOCKED'
  evidence: string
}

export interface DeriveCounters {
  tasks: { total: number; completed: number; failed: number; blocked: number; pending: number }
  corrections: { necessary: boolean; planned: number; applied: number; failed: number }
  tests: { runs: number; passed: number; failed: number; lastStatus: TestRecordStatus | null }
  review: ReviewStatus
}

export interface DeriveFinalStatusResult {
  state: PoskliGlobalState
  /** Código de máquina (estável, para testes). */
  reason: string
  /** Resumo em linguagem de produto (pt-BR). */
  summary: string
  /** Critérios avaliados — a base da decisão. */
  criteria: Criterion[]
  counters: DeriveCounters
  /** Sempre true: derivação conservadora por construção. */
  conservative: true
  derivedAt: string
}

// ---------- CONSTANTES ----------

export const POSKLI_PHASES: readonly PoskliPhase[] = [
  'ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'CORRECTING', 'REVIEWING', 'VERIFYING',
] as const

export const POSKLI_TERMINAL_STATES: readonly PoskliTerminalState[] = [
  'COMPLETED', 'FAILED', 'BLOCKED', 'PARTIAL', 'CANCELLED',
] as const

const PHASE_LABELS: Record<string, string> = {
  ANALYZING: 'Analisando',
  PLANNING: 'Planejando',
  IMPLEMENTING: 'Implementando',
  TESTING: 'Testando',
  CORRECTING: 'Corrigindo',
  REVIEWING: 'Revisando',
  VERIFYING: 'Verificando',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
  BLOCKED: 'Bloqueado',
  PARTIAL: 'Parcial',
  CANCELLED: 'Cancelado',
  PENDING: 'Aguardando',
  RUNNING: 'Em execução',
  SUCCESS: 'Concluído',
}

export function phaseLabel(s: string): string {
  return PHASE_LABELS[s] ?? s
}

export function isTerminalState(s: string): boolean {
  return (POSKLI_TERMINAL_STATES as readonly string[]).includes(s)
}

export function isPhase(s: string): s is PoskliPhase {
  return (POSKLI_PHASES as readonly string[]).includes(s)
}

/** Mapeia estado global → estado exibido (persistido em run.state). */
export function displayFromGlobal(state: PoskliGlobalState): PoskliTerminalState | PoskliPhase | 'PENDING' | 'RUNNING' {
  if (state === 'SUCCESS') return 'COMPLETED'
  if (state === 'FAILED' || state === 'BLOCKED' || state === 'PARTIAL' || state === 'CANCELLED') return state
  return state // PENDING | RUNNING (não persistido como terminal)
}

/** Um estado de run está ativo (executando) ou é terminal? */
export function isRunActive(state: string): boolean {
  return isPhase(state)
}

// ---------- HELPERS ----------

function requiredTasks(tasks: TaskSnapshot[]): TaskSnapshot[] {
  // Conservador: toda tarefa não-cancelada do grafo da execução é
  // obrigatória, salvo marcação explícita required=false.
  return tasks.filter((t) => t.required !== false && t.status !== 'CANCELLED')
}

function lastTest(tests: TestRecordSnapshot[]): TestRecordSnapshot | null {
  if (tests.length === 0) return null
  return tests[tests.length - 1]
}

function testsRequiredDefault(input: DeriveFinalStatusInput, tasks: TaskSnapshot[]): boolean {
  if (input.testsRequired !== undefined) return input.testsRequired
  // Default conservador: rodou testes OU o plano tem tarefa de testes
  return input.tests.length > 0 || tasks.some((t) => t.agentRole === 'testing')
}

// ---------- VERIFICAÇÃO (checklist determinístico) ----------

export interface BuildVerificationInput {
  previewRequired: boolean
  /** null = não verificado */
  previewOk: boolean | null
  buildRequired: boolean
  buildOk: boolean | null
  /** Implementação produziu artefatos (arquivos criados/editados)? null = não verificado */
  artifactsProduced: boolean | null
}

export function buildVerificationChecks(input: BuildVerificationInput): VerificationCheck[] {
  const checks: VerificationCheck[] = []

  checks.push(
    input.previewRequired
      ? {
          id: 'preview',
          label: 'Preview funcionando',
          required: true,
          status: input.previewOk === null ? 'BLOCKED' : input.previewOk ? 'PASS' : 'FAIL',
          evidence:
            input.previewOk === null
              ? 'preview não verificado nesta execução'
              : input.previewOk
                ? 'entrypoint web presente e servindo'
                : 'entrypoint web ausente ou inválido',
        }
      : {
          id: 'preview',
          label: 'Preview',
          required: false,
          status: 'NOT_APPLICABLE',
          evidence: 'projeto sem preview web no escopo',
        }
  )

  checks.push(
    input.buildRequired
      ? {
          id: 'build',
          label: 'Build funcionando',
          required: true,
          status: input.buildOk === null ? 'BLOCKED' : input.buildOk ? 'PASS' : 'FAIL',
          evidence:
            input.buildOk === null
              ? 'build não executado (orçamento ou indisponibilidade)'
              : input.buildOk
                ? 'comando de build concluído com exit 0'
                : 'comando de build falhou',
        }
      : {
          id: 'build',
          label: 'Build',
          required: false,
          status: 'NOT_APPLICABLE',
          evidence: 'sem script de build no projeto',
        }
  )

  checks.push({
    id: 'artifacts',
    label: 'Artefatos produzidos',
    required: true,
    status: input.artifactsProduced === null ? 'BLOCKED' : input.artifactsProduced ? 'PASS' : 'FAIL',
    evidence:
      input.artifactsProduced === null
        ? 'não foi possível auditar arquivos criados/editados'
        : input.artifactsProduced
          ? 'arquivos foram criados ou editados nesta execução'
          : 'nenhum arquivo foi criado ou editado (implementação sem artefatos)',
  })

  return checks
}

// ---------- CONTADORES (derivados dos dados reais) ----------

export function deriveCounters(input: DeriveFinalStatusInput): DeriveCounters {
  const tasks = requiredTasks(input.tasks)
  const byStatus = (s: TaskSnapshotStatus) => tasks.filter((t) => t.status === s).length
  const last = lastTest(input.tests)
  const necessary =
    input.tests.some((t) => t.status === 'FAIL') || input.review.status === 'CHANGES_REQUESTED'

  return {
    tasks: {
      total: tasks.length,
      completed: byStatus('COMPLETED'),
      failed: byStatus('FAILED'),
      blocked: byStatus('BLOCKED'),
      pending: byStatus('PENDING') + byStatus('RUNNING') + byStatus('REVIEWING'),
    },
    corrections: {
      necessary,
      planned: input.corrections.length,
      applied: input.corrections.filter((c) => c.state === 'COMPLETED').length,
      failed: input.corrections.filter((c) => c.state === 'FAILED' || c.state === 'BLOCKED').length,
    },
    tests: {
      runs: input.tests.length,
      passed: input.tests.filter((t) => t.status === 'PASS').length,
      failed: input.tests.filter((t) => t.status === 'FAIL').length,
      lastStatus: last ? last.status : null,
    },
    review: input.review.status,
  }
}

// ---------- DERIVAÇÃO FINAL (FONTE DA VERDADE) ----------

/**
 * deriveFinalStatus — determinística, pura, conservadora.
 *
 * Ordem de avaliação dos critérios (cada um com evidência):
 *   1. tasks       — tarefas obrigatórias concluídas
 *   2. tests       — testes necessários passando (última execução)
 *   3. review      — revisão concluída quando obrigatória
 *   4. corrections — correções necessárias aplicadas
 *   5. verification— verificação final executada e aprovada
 *   6. lifecycle   — fluxo completo (não interrompido)
 *
 * Agregação:
 *   cancelado            → CANCELLED
 *   qualquer FAIL        → FAILED
 *   todos PASS           → SUCCESS
 *   senão (BLOCKED mix)  → PARTIAL se ≥1 tarefa obrigatória concluída, senão BLOCKED
 */
export function deriveFinalStatus(input: DeriveFinalStatusInput): DeriveFinalStatusResult {
  const criteria: Criterion[] = constCriteria(input)
  const counters = deriveCounters(input)

  // ---- cancelamento tem precedência ----
  if (input.cancelled) {
    return finalize('CANCELLED', 'CANCELADO_PELO_USUÁRIO', 'Execução cancelada pelo usuário.', criteria, counters)
  }

  // ---- agregação conservadora ----
  const failed = criteria.find((c) => c.status === 'FAIL') ?? null
  if (failed) {
    return finalize('FAILED', `CRITÉRIO_${failed.id.toUpperCase()}_FALHOU`, failed.evidence, criteria, counters)
  }
  const allPass = criteria.every((c) => c.status === 'PASS')
  if (allPass) {
    return finalize(
      'SUCCESS',
      'CRITÉRIOS_SATISFEITOS',
      'Todos os critérios de conclusão foram satisfeitos com evidências.',
      criteria,
      counters
    )
  }
  // ---- bloqueios: PARTIAL se algo foi concluído, BLOCKED se nada ----
  const blockedEvidence = criteria.filter((c) => c.status === 'BLOCKED').map((c) => c.evidence).join('; ')
  if (counters.tasks.completed > 0) {
    return finalize(
      'PARTIAL',
      'CONCLUSÃO_PARCIAL',
      `Parte do trabalho foi concluída (${counters.tasks.completed}/${counters.tasks.total} tarefas), mas há etapas bloqueadas: ${blockedEvidence}`,
      criteria,
      counters
    )
  }
  return finalize(
    'BLOCKED',
    'EXECUÇÃO_BLOQUEADA',
    `Não foi possível comprovar a conclusão: ${blockedEvidence}`,
    criteria,
    counters
  )
}

/** Avalia os 6 critérios (função interna — pura). */
function constCriteria(input: DeriveFinalStatusInput): Criterion[] {
  const tasks = requiredTasks(input.tasks)
  const criteria: Criterion[] = []

  // ---- 1. TAREFAS ----
  if (tasks.length === 0) {
    criteria.push({
      id: 'tasks',
      label: 'Tarefas',
      status: 'BLOCKED',
      evidence: 'nenhuma tarefa foi planejada ou concluída nesta execução',
    })
  } else if (tasks.some((t) => t.status === 'FAILED')) {
    const failed = tasks.filter((t) => t.status === 'FAILED')
    criteria.push({
      id: 'tasks',
      label: 'Tarefas',
      status: 'FAIL',
      evidence: `tarefa obrigatória FAILED: ${failed.map((t) => t.title ?? t.id.slice(-6)).join(', ')}`,
    })
  } else if (tasks.every((t) => t.status === 'COMPLETED')) {
    criteria.push({
      id: 'tasks',
      label: 'Tarefas',
      status: 'PASS',
      evidence: `${tasks.length}/${tasks.length} tarefas concluídas`,
    })
  } else {
    const completed = tasks.filter((t) => t.status === 'COMPLETED').length
    const blocked = tasks.filter((t) => t.status === 'BLOCKED')
    criteria.push({
      id: 'tasks',
      label: 'Tarefas',
      status: 'BLOCKED',
      evidence:
        blocked.length > 0
          ? `tarefa bloqueada por dependência não satisfeita: ${blocked.map((t) => t.title ?? t.id.slice(-6)).join(', ')}`
          : `apenas ${completed}/${tasks.length} tarefas concluídas`,
    })
  }

  // ---- 2. TESTES ----
  const testsRequired = testsRequiredDefault(input, tasks)
  const last = lastTest(input.tests)
  if (!testsRequired) {
    criteria.push({
      id: 'tests',
      label: 'Testes',
      status: 'PASS',
      evidence: 'sem testes no escopo do pedido',
    })
  } else if (!last) {
    criteria.push({
      id: 'tests',
      label: 'Testes',
      status: 'BLOCKED',
      evidence: 'testes necessários não foram executados',
    })
  } else if (last.status === 'PASS') {
    criteria.push({
      id: 'tests',
      label: 'Testes',
      status: 'PASS',
      evidence: `${input.tests.length} execução(ões) de teste — última ${last.command ? `\`${last.command}\`` : 'execução'} PASS`,
    })
  } else {
    criteria.push({
      id: 'tests',
      label: 'Testes',
      status: 'FAIL',
      evidence: `testes falharam (${input.tests.filter((t) => t.status === 'FAIL').length}/${input.tests.length} execuções com falha)`,
    })
  }

  // ---- 3. REVISÃO ----
  const reviewRequired = input.reviewRequired ?? true
  if (!reviewRequired) {
    criteria.push({
      id: 'review',
      label: 'Revisão',
      status: 'PASS',
      evidence: 'revisão dispensada por política',
    })
  } else {
    switch (input.review.status) {
      case 'PASS':
        criteria.push({
          id: 'review',
          label: 'Revisão',
          status: 'PASS',
          evidence: 'revisão aprovou a implementação',
        })
        break
      case 'CHANGES_REQUESTED':
      case 'FAILED':
        criteria.push({
          id: 'review',
          label: 'Revisão',
          status: 'FAIL',
          evidence: input.review.status === 'CHANGES_REQUESTED' ? 'revisão solicitou mudanças não resolvidas' : 'revisão reprovou a implementação',
        })
        break
      case 'BLOCKED':
        criteria.push({
          id: 'review',
          label: 'Revisão',
          status: 'BLOCKED',
          evidence: `revisão bloqueada${input.review.blockedReason ? `: ${input.review.blockedReason}` : ''} — failover não aplicado a rate limits por política`,
        })
        break
      default:
        criteria.push({
          id: 'review',
          label: 'Revisão',
          status: 'BLOCKED',
          evidence: 'revisão obrigatória não executada',
        })
    }
  }

  // ---- 4. CORREÇÕES ----
  const necessary = input.tests.some((t) => t.status === 'FAIL') || input.review.status === 'CHANGES_REQUESTED'
  const applied = input.corrections.filter((c) => c.state === 'COMPLETED').length
  const planned = input.corrections.length
  const problemsResolved =
    (last ? last.status === 'PASS' : true) && (input.review.status === 'PASS' || !reviewRequired)
  if (!necessary) {
    criteria.push({
      id: 'corrections',
      label: 'Correções',
      status: 'PASS',
      evidence: 'nenhuma correção foi necessária',
    })
  } else if (problemsResolved) {
    criteria.push({
      id: 'corrections',
      label: 'Correções',
      status: 'PASS',
      evidence: `problemas resolvidos — ${applied}/${planned} correção(ões) aplicada(s)`,
    })
  } else if (applied === 0) {
    criteria.push({
      id: 'corrections',
      label: 'Correções',
      status: 'FAIL',
      evidence: `0/${planned || 1} correções aplicadas — problemas persistem`,
    })
  } else {
    criteria.push({
      id: 'corrections',
      label: 'Correções',
      status: 'FAIL',
      evidence: `${applied}/${planned} correções aplicadas — problemas persistem`,
    })
  }

  // ---- 5. VERIFICAÇÃO FINAL ----
  if (!input.verification || !input.verification.ran) {
    criteria.push({
      id: 'verification',
      label: 'Verificação',
      status: 'BLOCKED',
      evidence: 'verificação final determinística não executada',
    })
  } else {
    const required = input.verification.checks.filter((c) => c.required)
    const failedChecks = required.filter((c) => c.status === 'FAIL')
    const blockedChecks = required.filter((c) => c.status === 'BLOCKED')
    if (failedChecks.length > 0) {
      criteria.push({
        id: 'verification',
        label: 'Verificação',
        status: 'FAIL',
        evidence: `verificação falhou: ${failedChecks.map((c) => c.label).join(', ')}`,
      })
    } else if (blockedChecks.length > 0) {
      criteria.push({
        id: 'verification',
        label: 'Verificação',
        status: 'BLOCKED',
        evidence: `verificação incompleta: ${blockedChecks.map((c) => c.label).join(', ')}`,
      })
    } else {
      criteria.push({
        id: 'verification',
        label: 'Verificação',
        status: 'PASS',
        evidence: `${required.filter((c) => c.status === 'PASS').length}/${required.length} verificações obrigatórias aprovadas`,
      })
    }
  }

  // ---- 6. CICLO DE VIDA ----
  if (input.interrupted) {
    criteria.push({
      id: 'lifecycle',
      label: 'Fluxo',
      status: 'BLOCKED',
      evidence: 'execução interrompida antes da conclusão do fluxo',
    })
  } else {
    criteria.push({
      id: 'lifecycle',
      label: 'Fluxo',
      status: 'PASS',
      evidence: 'fluxo executado até a derivação final do resultado',
    })
  }

  return criteria
}

function finalize(
  state: PoskliGlobalState,
  reason: string,
  summary: string,
  criteria: Criterion[],
  counters: DeriveCounters
): DeriveFinalStatusResult {
  return {
    state,
    reason,
    summary,
    criteria,
    counters,
    conservative: true,
    derivedAt: new Date().toISOString(),
  }
}

// ---------- MARKDOWN DO RESULTADO (mesma fonte da verdade) ----------

/** Gera o relatório "Resultado do Poskli" a partir da derivação —
 *  backend e UI nunca divergem: ambos consomem deriveFinalStatus. */
export function deriveResultMarkdown(
  derivation: DeriveFinalStatusResult,
  opts: { request: string; tokens?: number; iterations?: string; evidence?: readonly string[] }
): string {
  const stateLabel = phaseLabel(displayFromGlobal(derivation.state) as string)
  const c = derivation.counters
  const lines: string[] = [
    '## Resultado do Poskli',
    '',
    `**Pedido:** ${opts.request.slice(0, 300)}`,
    `**Estado:** ${stateLabel} — ${derivation.summary}`,
    `**Tarefas:** ${c.tasks.completed}/${c.tasks.total} concluídas${c.tasks.failed > 0 ? ` · ${c.tasks.failed} falharam` : ''}${c.tasks.blocked > 0 ? ` · ${c.tasks.blocked} bloqueadas` : ''}`,
    `**Correções:** ${c.corrections.necessary ? `${c.corrections.applied}/${c.corrections.planned} aplicadas` : 'não foram necessárias'}`,
    `**Testes:** ${c.tests.runs > 0 ? `${c.tests.runs} execução(ões) — última ${c.tests.lastStatus ?? '—'}` : 'não executados'}`,
    `**Revisão:** ${reviewStatusLabel(c.review)}`,
  ]
  if (opts.iterations) lines.push(`**Iterações de correção:** ${opts.iterations}`)
  if (opts.tokens !== undefined) lines.push(`**Tokens:** ${opts.tokens}`)

  lines.push('', '### Critérios de conclusão')
  for (const crit of derivation.criteria) {
    const icon =
      crit.status === 'PASS' ? '✓' : crit.status === 'FAIL' ? '✗' : '⊘'
    lines.push(`- ${icon} **${crit.label}**: ${crit.status} — ${crit.evidence}`)
  }

  if (opts.evidence && opts.evidence.length > 0) {
    lines.push('', '### Evidências')
    for (const e of opts.evidence.slice(-12)) lines.push(`- ${e}`)
  }

  return lines.join('\n')
}

export function reviewStatusLabel(status: ReviewStatus): string {
  switch (status) {
    case 'PASS': return 'aprovada'
    case 'CHANGES_REQUESTED': return 'solicitou mudanças'
    case 'FAILED': return 'reprovada'
    case 'BLOCKED': return 'bloqueada'
    default: return 'não executada'
  }
}
