// ============================================================
// POSKLI 0.2 — ORQUESTRADOR DE AGENTES
//
// USER → POSKLI ORCHESTRATOR (CONTROLADO)
//        → PLANNER (análise/plano)
//        → ENGINEER (implementação — LOOP AGÊNTICO: o agente
//          decide rodar testes, vê o output e edita arquivos
//          DIRETAMENTE, sem etapas fixas de Revisar/Corrigir)
//        → TESTES REAIS no Execution Engine (giro canônico)
//        → (se falhar: o MESMO agente edita + re-testa, teto 2)
//        → FINAL VERIFICATION (checklist determinístico)
//        → deriveFinalStatus()  ← FONTE ÚNICA DA VERDADE
//
// REGRA ABSOLUTA (0.2):
//   "CONCLUÍDO" somente quando deriveFinalStatus() derivar SUCCESS
//   dos critérios REAIS (tarefas/testes/correções/verificação).
//   Terminou de executar ≠ concluiu. NUNCA mascarar erro como sucesso.
//
// Estados visíveis ao usuário (reconstrução agêntica — sem
// "Revisando"/"Corrigindo" como etapas separadas):
//   ANALYZING → PLANNING → IMPLEMENTING ⇄ TESTING → VERIFYING →
//   COMPLETED | FAILED | BLOCKED | PARTIAL | CANCELLED
//   (CORRECTING/REVIEWING existem apenas p/ compatibilidade de
//   runs ANTIGOS persistidos no DB)
// ============================================================

import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { getAgent } from '../agents/definitions'
import { runAgent, extractJson } from '../agents/base'
import {
  readProjectMemory, memoryToPrompt, updateProjectMemory, selectRelevantFiles,
} from '../context/context-manager'
import { clipToolOutput } from '../context/clip.ts'
import { createTasksFromPlan, transitionTask, readyTasks } from '../orchestrator/task-graph'
import { emitEvent } from '../events/bus'
import { ensureMaterialized, syncBackToDb } from '../workspace/sync'
import { workspaceProvider } from '../workspace/db-provider'
import { runExecution } from '../execution/engine'
import { getTemplate } from '../projects/templates'
import {
  deriveFinalStatus, deriveResultMarkdown, buildVerificationChecks, phaseLabel,
  displayFromGlobal,
  type DeriveFinalStatusInput, type DeriveFinalStatusResult, type TaskSnapshot,
  type TestRecordSnapshot, type CorrectionSnapshot, type ReviewSnapshot, type VerificationResult,
} from './state-machine'
import { classifyError, type PoskliErrorCode } from './errors'
import { withPoskliVersion, requestPoskliVersion, withPoskliTaskProfile, requestPoskliTaskProfile, type PoskliTaskProfile } from '../models/version-context.ts'
import { POSKLI_VERSIONS } from '../models/chain.ts'
import { failureSignature, agenticFixBudget, agenticFixDecision } from './loop-guard.ts'
import { taskText } from '../orchestrator/task-text.ts'
import { budgetFor } from './budget.ts'
import { buildCorrectionContext } from './correction-context.ts'
import { planModeFor } from './fast-plan.ts'
import { subagentBudgetFor, clampSubagentBudgets, delegationMessage, getBudgetForTask } from './delegation.ts'
import { buildToonTask, parseRequestToTOON } from './toon.ts'
import { agentsForProfile } from './agent-pool.ts'
import platformInstructions from './instructions.json'

// ---------- TIPOS ----------

export type PoskliState =
  | 'ANALYZING' | 'PLANNING' | 'IMPLEMENTING' | 'TESTING'
  | 'REVIEWING' | 'CORRECTING' | 'VERIFYING'
  | 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'PARTIAL' | 'CANCELLED'

export interface StageEntry {
  stage: PoskliState
  state: 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED'
  startedAt: string
  finishedAt?: string
  durationMs?: number
  summary?: string
  tokensIn?: number
  tokensOut?: number
}

interface Plan {
  architecture: string
  stack: string[]
  tasks: Array<{ title: string; description: string; agentRole: string; priority: string; dependsOn: number[] }>
}

interface TestOutcome {
  passed: boolean
  executionId: string
  command: string
  stdout: string
  stderr: string
  exitCode: number | null
  status: string
}

/** Registro de teste com IDENTIDADE (spec §11/§23) — persistido em run.testRecords. */
interface TestRecord extends TestRecordSnapshot {
  durationMs?: number
}

/** Registro de correção com estado individual (spec §15) — persistido em run.corrections. */
interface CorrectionRecord extends CorrectionSnapshot {
  startedAt: string
  finishedAt?: string
  evidence?: string
  errorCode?: PoskliErrorCode
}

/** Snapshot da revisão (spec §5/§13) — persistido em run.reviewResult.
 *  MODO AGÊNTICO: a revisão dedicada foi DESPENSADA — o campo
 *  permanece (coluna no DB + derivação) marcado como NOT_RUN e a
 *  derivação recebe reviewRequired=false. */
interface ReviewResult extends ReviewSnapshot {
  issues?: unknown[]
  summary?: string
  ts?: string
}

interface PoskliContext {
  runId: string
  projectId: string
  userId: string
  request: string
  deadline: number
  stages: StageEntry[]
  tokens: { in: number; out: number }
  executions: number
  iteration: number
  maxIterations: number
  evidence: string[]
  plan: Plan
  /** FASE 2 — orçamento por NÍVEL (0.1/0.2/0.3.1/1.0-flash/superagent):
   *  tool calls, steps, timeout e contexto de arquivos. */
  budget: ReturnType<typeof budgetFor>
  /** AGENT POOL — perfil da tarefa (TOON: dificuldade + tipo) que
   *  seleciona os modelos por papel e o orçamento ELÁSTICO. */
  taskProfile?: PoskliTaskProfile
  /** Registros com identidade (nunca duplicados por re-render/polling). */
  testRecords: TestRecord[]
  corrections: CorrectionRecord[]
  review: ReviewResult
  /** AgentRuns executados nesta sessão (auditoria de artefatos). */
  agentRunIds: string[]
  /** Classificação do erro mais significativo (taxonomia §31). */
  errorCode?: PoskliErrorCode
}

const MAX_TASKS = 8
const FILE_WRITE_TOOLS = ['create_file', 'modify_file', 'create_directory']

/** Cota esgotada (Tarefa C §3a): o run PARA honestamente — o catch
 *  do runPoskliInner deriva o estado final conservador. NUNCA cria
 *  tarefas de correção para erros de quota (regra de ouro). */
class QuotaExhaustedAbort extends Error {
  constructor(detail: string) {
    super(`QUOTA_EXHAUSTED: ${detail}`)
    this.name = 'QuotaExhaustedAbort'
  }
}

/** Resumo do DIFF do workspace (Tarefa C §3e): correções recebem
 *  apenas as linhas alteradas + erro resumido — nunca o código completo.
 *  CORREÇÃO: comandos SEM pipe/redirecionamento (allowlist sem shell
 *  rejeita metacaracteres — a saída é limitada pelo clipToolOutput).
 *  FASE 2 — skipSync: leitura (git diff), nunca altera arquivos. */
async function workspaceDiffSummary(ctx: PoskliContext): Promise<string> {
  try {
    const res = await runExecution({
      projectId: ctx.projectId,
      command: 'git diff --unified=1 HEAD',
      userId: ctx.userId,
      source: 'poskli',
      trigger: 'diff-summary',
      timeoutMs: 15_000,
      skipSync: true,
    })
    if (res.status !== 'SUCCESS' && res.exitCode !== 0) {
      return '(diff indisponível — workspace sem git ou comando bloqueado)'
    }
    const raw = (res.stdout ?? '').trim()
    if (!raw) return '(sem alterações não commitadas — workspace limpo)'
    return clipToolOutput(raw)
  } catch {
    return '(diff indisponível — workspace sem git ou comando bloqueado)'
  }
}

/** Checkpoint git agressivo (reversibilidade estilo Codex): commit do
 *  estado atual ANTES/depois de cada ação relevante — o usuário pode
 *  reverter qualquer passo do agente com git. Best-effort (workspace
 *  sem git → silencioso; nunca bloqueia o run).
 *  FASE 2 — skipSync: comandos git NÃO alteram arquivos-fonte (o sync
 *  disco→DB de cada checkpoint era 2 fetches completos do DB por
 *  execução — puro desperdício medido). */
async function checkpointWorkspace(ctx: PoskliContext, label: string): Promise<void> {
  try {
    await runExecution({
      projectId: ctx.projectId,
      command: 'git add -A',
      userId: ctx.userId,
      source: 'poskli',
      trigger: 'checkpoint',
      timeoutMs: 15_000,
      skipSync: true,
    }).catch(() => null)
    const safe = label.replace(/[^\w.-]/g, '-').slice(0, 60)
    await runExecution({
      projectId: ctx.projectId,
      command: `git commit -m poskli-${safe}`,
      userId: ctx.userId,
      source: 'poskli',
      trigger: 'checkpoint',
      timeoutMs: 15_000,
      skipSync: true,
    }).catch(() => null)
    const hash = await runExecution({
      projectId: ctx.projectId,
      command: 'git rev-parse --short HEAD',
      userId: ctx.userId,
      source: 'poskli',
      trigger: 'checkpoint',
      timeoutMs: 10_000,
      skipSync: true,
    }).catch(() => null)
    const h = (hash?.stdout ?? '').trim()
    if (h) ctx.evidence.push(`ponto de restauração git: ${h} (${label})`)
  } catch {
    /* workspace sem git — checkpoint best-effort */
  }
}

/** Há alterações não commitadas no workspace? (detecção de loop
 *  NO_REPO_CHANGE — null quando o git não está disponível).
 *  FASE 2 — skipSync: leitura de estado, nunca altera arquivos. */
async function workspaceHasChanges(ctx: PoskliContext): Promise<boolean | null> {
  try {
    const res = await runExecution({
      projectId: ctx.projectId,
      command: 'git status --porcelain',
      userId: ctx.userId,
      source: 'poskli',
      trigger: 'loop-guard',
      timeoutMs: 10_000,
      skipSync: true,
    })
    if (res.status !== 'SUCCESS' && res.exitCode !== 0) return null
    return ((res.stdout ?? '') + (res.stderr ?? '')).trim().length > 0
  } catch {
    return null
  }
}

const STATE_LABELS: Record<PoskliState, string> = {
  ANALYZING: 'Analisando',
  PLANNING: 'Planejando',
  IMPLEMENTING: 'Implementando',
  TESTING: 'Executando testes',
  REVIEWING: 'Revisando',
  CORRECTING: 'Corrigindo',
  VERIFYING: 'Verificação final',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
  BLOCKED: 'Bloqueado',
  PARTIAL: 'Parcial',
  CANCELLED: 'Cancelado',
}

// ---------- HELPERS ----------

/** Muda o estado visível; retorna false se o run foi cancelado. */
async function setState(ctx: PoskliContext, state: PoskliState): Promise<boolean> {
  const row = await db.poskliRun.findUnique({ where: { id: ctx.runId }, select: { state: true } })
  if (row?.state === 'CANCELLED') return false
  await db.poskliRun.update({ where: { id: ctx.runId }, data: { state } })
  await emitEvent({
    type: 'poskli.state',
    projectId: ctx.projectId,
    runId: ctx.runId,
    status: state,
    message: `Poskli: ${STATE_LABELS[state]}`,
  })
  return true
}

/** Executa um estágio com timeline persistida. Retorna o resultado de fn. */
async function stage<T>(ctx: PoskliContext, stageName: PoskliState, fn: () => Promise<T>): Promise<T> {
  const startedAt = new Date().toISOString()
  const tokensBefore = { ...ctx.tokens }
  const entry: StageEntry = { stage: stageName, state: 'RUNNING', startedAt }
  ctx.stages = [...ctx.stages, entry]
  await db.poskliRun.update({ where: { id: ctx.runId }, data: { stages: ctx.stages as unknown as object } })

  try {
    const result = await fn()
    entry.state = 'DONE'
    entry.summary = summarize(result)
    entry.tokensIn = ctx.tokens.in - tokensBefore.in
    entry.tokensOut = ctx.tokens.out - tokensBefore.out
    return result
  } catch (e) {
    entry.state = 'FAILED'
    entry.summary = classifyError(e).friendly.slice(0, 400)
    throw e
  } finally {
    entry.finishedAt = new Date().toISOString()
    entry.durationMs = Date.now() - new Date(startedAt).getTime()
    await db.poskliRun.update({
      where: { id: ctx.runId },
      data: { stages: ctx.stages as unknown as object, tokensIn: ctx.tokens.in, tokensOut: ctx.tokens.out },
    }).catch(() => {})
  }
}

/** Resumo legível do resultado do estágio (sem expor internals). */
function summarize(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, 400)
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    if (typeof r.summary === 'string') return r.summary.slice(0, 400)
    if (typeof r.passed === 'boolean') return `Testes ${r.passed ? 'PASSARAM' : 'FALHARAM'} — ${String(r.command ?? '')}`
    if (typeof r.verdict === 'string') return `Revisão: ${r.verdict}`
  }
  return 'concluído'
}

/** Comando de testes do projeto (package.json script OU template). */
async function testCommandFor(projectId: string, projectType: string): Promise<string> {
  try {
    const pkgFile = await workspaceProvider.readFile(projectId, 'package.json')
    if (pkgFile && pkgFile.encoding === 'utf8') {
      const pkg = JSON.parse(pkgFile.content) as { scripts?: Record<string, string> }
      if (pkg.scripts?.test && !pkg.scripts.test.includes('echo')) return 'npm test'
    }
  } catch { /* segue para template */ }
  const template = getTemplate(projectType)
  return template?.testCommand ?? 'node --test test/'
}

/** Existe script de build aplicável? (spec §17: "quando aplicável") */
async function buildCommandFor(projectId: string): Promise<string | null> {
  try {
    const pkgFile = await workspaceProvider.readFile(projectId, 'package.json')
    if (pkgFile && pkgFile.encoding === 'utf8') {
      const pkg = JSON.parse(pkgFile.content) as { scripts?: Record<string, string> }
      if (pkg.scripts?.build && !pkg.scripts.build.includes('echo')) return 'npm run build'
    }
  } catch { /* sem package.json → não aplicável */ }
  return null
}

/** Extrai pistas de arquivo/linha da saída REAL dos testes. */
function extractFailureHints(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`.split('\n')
  const hints = lines
    .filter((l) => /error|fail|assert|expected|actual|✖|not ok|throw/i.test(l))
    .slice(0, 12)
  return hints.join('\n').slice(0, 2200) || '(sem detalhes de falha no output)'
}

/** Persiste registros com identidade (testes/correções) — a UI lê do DB. */
async function persistRecords(ctx: PoskliContext): Promise<void> {
  await db.poskliRun.update({
    where: { id: ctx.runId },
    data: {
      testRecords: ctx.testRecords as unknown as object,
      corrections: ctx.corrections as unknown as object,
    },
  }).catch(() => {})
}

// ---------- ESTÁGIOS ----------

async function analyzeStage(ctx: PoskliContext): Promise<Plan> {
  const master = getAgent('master')!
  const project = await db.project.findUnique({ where: { id: ctx.projectId } })
  const memory = await readProjectMemory(ctx.projectId)
  const root = await ensureMaterialized(ctx.projectId)
  const files = await selectRelevantFiles(root, [], ctx.request)
  // FASE 2 — teto de contexto por NÍVEL (0.1: 8k … superagent: 16k;
  // era 20k fixo — média medida de 4.271 tokens IN/passo)
  const fileCap = ctx.budget.contextFileChars
  const fileBlock = files
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, Math.min(2200, Math.floor(fileCap / 6)))}\n\`\`\``)
    .join('\n')
    .slice(0, fileCap)

  // FIX do travamento ("A pensar durante 45s…"): ritmo da análise
  // classificado por pedido — pedidos claros produzem o plano no
  // PRIMEIRO passo, sem pesquisas/inspeções obrigatórias.
  const planMode = planModeFor(ctx.request)

  // AGENT POOL — linha TOON compacta (classificação do pedido) +
  // INSTRUÇÕES DA PLATAFORMA (instructions.json): regras always/
  // never que poupam tokens e evitam ficheiros/testes desnecessários
  const toonLine = ctx.taskProfile?.toon ?? parseRequestToTOON(ctx.request)
  const rules = platformInstructions.agentRules as { always: string[]; never: string[] }
  const instructionsBlock = [
    `PEDIDO (TOON): ${toonLine}`,
    'DIFICULDADE: ' + (ctx.taskProfile?.difficulty ?? buildToonTask(ctx.request).difficulty) +
      ' — o orçamento dos subagentes escala com ela',
    'REGRAS DA PLATAFORMA (obrigatórias):',
    ...rules.always.map((r) => `- ${r}`),
    ...rules.never.map((r) => `- NUNCA: ${r.toLowerCase()}`),
  ].join('\n')

  const out = await runAgent(
    {
      agent: master,
      projectId: ctx.projectId,
      workspaceRoot: root,
      runType: 'PLAN',
      poskliRunId: ctx.runId,
      objective: [
        `Pedido do usuário: "${ctx.request}"`,
        '',
        `## CLASSIFICAÇÃO DO PEDIDO (TOON)\n${instructionsBlock}`,
        '',
        `## RITMO RECOMENDADO PARA ESTE PEDIDO\n${planMode.hint}`,
        '',
        'Analise o estado atual do projeto e produza um plano JSON:',
        '{"plan": {"architecture": "...", "stack": [...], "tasks": [{"title": "...", "description": "...", "agentRole": "coding|testing|review", "priority": "HIGH|MEDIUM|LOW", "dependsOn": [índices]}]}}',
        'MÁXIMO 4 tarefas. Cada tarefa concreta e verificável por testes. Inclua SEMPRE uma tarefa de testes automatizados (agentRole "testing").',
      ].join('\n'),
      contextBlock: [
        `## PROJETO: ${project?.name} (tipo: ${project?.type})`,
        `## DESCRIÇÃO: ${project?.description}`,
        `## MEMÓRIA DO PROJETO\n${memoryToPrompt(memory)}`,
        fileBlock ? `## ARQUIVOS RELEVANTES\n${fileBlock}` : '(workspace vazio ou sem arquivos relevantes)',
      ].join('\n\n'),
      // FASE 2 — orçamento por nível aplicado ao planner
      budget: { maxSteps: ctx.budget.maxSteps, agentTimeoutMs: ctx.budget.agentTimeoutMs },
    },
    Math.min(12, ctx.budget.maxToolCalls)
  )
  ctx.tokens.in += out.tokensIn
  ctx.tokens.out += out.tokensOut
  ctx.agentRunIds.push(out.runId)

  const planJson = extractJson(out.result)
  let plan = (planJson?.plan as Plan) ?? null
  if (!plan && planJson?.tasks) plan = planJson as unknown as Plan
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    plan = {
      architecture: 'Plano determinístico de fallback',
      stack: [],
      tasks: [
        { title: 'Implementação principal', description: `Implemente: ${ctx.request}`, agentRole: 'coding', priority: 'HIGH', dependsOn: [] },
        { title: 'Testes automatizados', description: 'Crie testes node:test cobrindo a implementação; execute e reporte evidências.', agentRole: 'testing', priority: 'HIGH', dependsOn: [0] },
      ],
    }
  }
  // NORMALIZAÇÃO (bug de serialização): o LLM pode devolver
  // description/title como objetos — achatamos em texto legível
  // ANTES de persistir e de montar prompts.
  plan.tasks = plan.tasks.slice(0, MAX_TASKS).map((t) => ({
    ...t,
    title: taskText(t.title) || t.title,
    description: taskText(t.description),
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
  }))
  return plan
}

async function implementTask(
  ctx: PoskliContext,
  task: { id: string; title: string; description: string; agentRole: string; attempts: number },
  extraContext?: string
): Promise<{ status: string; result: string }> {
  const agent = getAgent(task.agentRole) ?? getAgent('coding')!
  const root = await ensureMaterialized(ctx.projectId)
  const memory = await readProjectMemory(ctx.projectId)

  // FASE VISÍVEL — delegação: o orquestrador ANUNCIA a tarefa e o
  // subagente especializado que a vai executar ("A delegar…")
  await emitEvent({
    type: 'task.delegated',
    projectId: ctx.projectId,
    taskId: task.id,
    runId: ctx.runId,
    agent: agent.id,
    message: `Poskli — ${delegationMessage(task.title, task.agentRole)}`,
    data: { taskTitle: task.title.slice(0, 120), subagent: task.agentRole },
  })

  // DELEGAÇÃO EFICIENTE — contexto MÍNIMO por subagente: o REVIEW
  // recebe diff + registos de testes (não o projeto inteiro); os
  // demais recebem os arquivos RELEVANTES à tarefa (teto por nível)
  let fileBlock: string
  if (task.agentRole === 'review') {
    const diff = await workspaceDiffSummary(ctx)
    const lastTests = ctx.testRecords
      .slice(-2)
      .map((t) => `- ${t.status} (${t.command}, exit ${t.exitCode})`)
      .join('\n')
    fileBlock = [
      '## DIFF A REVISAR (linhas alteradas)',
      diff,
      lastTests ? `## ÚLTIMOS TESTES\n${lastTests}` : '(sem testes ainda)',
    ].join('\n\n')
  } else {
    const files = await selectRelevantFiles(root, [], task.title + ' ' + task.description)
    // FASE 2 — teto de contexto por NÍVEL (era 16k fixo) + trechos
    // menores por arquivo (2500 → fileCap/6): menos duplicação entre
    // ANALYZING e IMPLEMENTING dos MESMOS arquivos.
    const fileCap = ctx.budget.contextFileChars
    fileBlock = files
      .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, Math.min(1800, Math.floor(fileCap / 6)))}\n\`\`\``)
      .join('\n')
      .slice(0, fileCap)
  }

  await transitionTask(task.id, 'RUNNING', { attempts: { increment: 1 }, input: { description: task.description, agentRole: task.agentRole, poskli: ctx.runId } as object })
  await emitEvent({ type: 'task.started', projectId: ctx.projectId, taskId: task.id, runId: ctx.runId, agent: agent.id, message: `Poskli — implementando: ${task.title}` })

  // DELEGAÇÃO — orçamentos ESPECÍFICOS do subagente, ELÁSTICOS por
  // dificuldade do pedido (TOON: simple 150k/20 · medium 200k/24 ·
  // hard 250k/26 · complex 300k/30 no coding; testing/review
  // 15k-35k), clamped ao nível do Poskli (o menor vence). Sem
  // perfil (compat): fixos 30k/10k/10k. Excedeu → "Orçamento
  // atingido, a terminar" (AgentRunner).
  const subBudget = subagentBudgetFor(task.agentRole, ctx.taskProfile?.difficulty)
  const subClamp = subBudget ? clampSubagentBudgets(ctx.budget, subBudget) : null
  const toolCallCap = subClamp
    ? subClamp.maxToolCalls
    : Math.min(STUDIO_CONFIG.limits.maxToolCalls, ctx.budget.maxToolCalls)

  const out = await runAgent(
    {
      agent,
      projectId: ctx.projectId,
      workspaceRoot: root,
      taskId: task.id,
      runType: task.agentRole === 'review' ? 'REVIEW' : task.agentRole === 'testing' ? 'TEST' : 'TASK',
      poskliRunId: ctx.runId,
      objective: [
        `TAREFA: ${task.title}`,
        ctx.taskProfile ? `CONTEXTO (TOON): ${ctx.taskProfile.toon}` : '',
        '',
        `DESCRIÇÃO:\n${task.description}`,
        extraContext ? `\n## CONTEXTO ADICIONAL\n${extraContext}` : '',
        '',
        'Complete a tarefa com código real. Ao final, cite evidências.',
      ].filter(Boolean).join('\n'),
      contextBlock: [`## MEMÓRIA DO PROJETO\n${memoryToPrompt(memory)}`, fileBlock ? `## ${task.agentRole === 'review' ? 'EVIDÊNCIAS' : 'ARQUIVOS ATUAIS'}\n${fileBlock}` : ''].filter(Boolean).join('\n\n'),
      // FASE 2 — orçamento por nível (steps/timeout) + DELEGAÇÃO
      // (tool calls e tokens do subagente)
      budget: {
        maxSteps: ctx.budget.maxSteps,
        agentTimeoutMs: ctx.budget.agentTimeoutMs,
        ...(subClamp ? { maxToolCalls: subClamp.maxToolCalls, tokenBudget: subClamp.tokenBudget } : {}),
      },
    },
    toolCallCap
  )
  ctx.tokens.in += out.tokensIn
  ctx.tokens.out += out.tokensOut
  ctx.agentRunIds.push(out.runId)
  // Orçamento atingido → evidência honesta do subagente no run
  if (out.status === 'MAX_LIMITS_REACHED' && /ORÇAMENTO_ATINGIDO/.test(out.result)) {
    ctx.evidence.push(`${task.title}: ${out.result.split('\n')[0].slice(0, 140)}`)
  }
  return { status: out.status, result: out.result }
}

/** Roda os testes REAIS no Execution Engine e registra TestRecord com identidade. */
async function runTestsStage(ctx: PoskliContext, trigger: TestRecord['trigger']): Promise<TestOutcome> {
  const project = await db.project.findUnique({ where: { id: ctx.projectId }, select: { type: true } })
  const command = await testCommandFor(ctx.projectId, project?.type ?? 'EMPTY_PROJECT')
  ctx.executions++

  const res = await runExecution({
    projectId: ctx.projectId,
    command,
    userId: ctx.userId,
    source: 'poskli',
    trigger: 'tester',
    timeoutMs: Math.min(180_000, Math.max(10_000, ctx.deadline - Date.now() - 15_000)),
  })

  await db.poskliRun.update({ where: { id: ctx.runId }, data: { lastExecId: res.executionId } }).catch(() => {})
  const passed = res.status === 'SUCCESS' && res.exitCode === 0

  // ---- TestRecord com identidade estável (dedup na UI por id) ----
  const record: TestRecord = {
    id: `tst_${crypto.randomUUID().slice(0, 12)}`,
    executionId: res.executionId,
    command,
    status: passed ? 'PASS' : 'FAIL',
    exitCode: res.exitCode,
    trigger,
    ts: new Date().toISOString(),
    durationMs: res.durationMs,
  }
  ctx.testRecords = [...ctx.testRecords, record]
  await persistRecords(ctx)

  await emitEvent({
    type: passed ? 'test.passed' : 'test.failed',
    projectId: ctx.projectId,
    runId: ctx.runId,
    agent: 'testing',
    tool: 'execution',
    status: passed ? 'OK' : 'ERROR',
    message: `Poskli — testes ${passed ? 'PASSARAM' : 'FALHARAM'} (${phaseLabel('TESTING')} #${ctx.testRecords.length}): exit ${res.exitCode}`,
    durationMs: res.durationMs,
    data: { testRecordId: record.id, executionId: res.executionId, trigger, attempt: ctx.testRecords.length },
  })
  return { passed, executionId: res.executionId, command, stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, status: res.status }
}


async function verifyPreview(ctx: PoskliContext): Promise<boolean> {
  const project = await db.project.findUnique({ where: { id: ctx.projectId }, select: { type: true } })
  const type = project?.type ?? 'EMPTY_PROJECT'
  if (type === 'API' || type === 'EMPTY_PROJECT') return true
  const index = await workspaceProvider.readFile(ctx.projectId, 'index.html').catch(() => null)
  return Boolean(index)
}

/** Artefatos: arquivos realmente criados/editados nesta execução (auditoria real de ToolCalls). */
async function auditArtifacts(ctx: PoskliContext): Promise<boolean | null> {
  if (ctx.agentRunIds.length === 0) return null
  try {
    const calls = await db.toolCall.count({
      where: {
        runId: { in: ctx.agentRunIds },
        tool: { in: FILE_WRITE_TOOLS },
        status: 'OK',
      },
    })
    return calls > 0
  } catch {
    return null
  }
}

/** Deriva snapshots FINAIS das tarefas do grafo desta execução. */
async function taskSnapshots(projectId: string): Promise<TaskSnapshot[]> {
  const tasks = await db.task.findMany({
    where: { projectId, status: { not: 'CANCELLED' } },
    orderBy: { order: 'asc' },
    select: { id: true, title: true, status: true, attempts: true, agentRole: true },
  })
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status as TaskSnapshot['status'],
    required: true,
    attempts: t.attempts,
    agentRole: t.agentRole,
  }))
}

// ---------- CORREÇÕES (registros com estado individual — spec §15) ----------

async function startCorrection(ctx: PoskliContext, trigger: CorrectionRecord['trigger']): Promise<CorrectionRecord> {
  const record: CorrectionRecord = {
    id: `cor_${crypto.randomUUID().slice(0, 12)}`,
    attempt: ctx.corrections.length + 1,
    trigger,
    state: 'STARTED',
    startedAt: new Date().toISOString(),
  }
  ctx.corrections = [...ctx.corrections, record]
  await persistRecords(ctx)
  await emitEvent({
    type: 'correction.started',
    projectId: ctx.projectId,
    runId: ctx.runId,
    status: 'RUNNING',
    message: `Poskli — correção ${record.attempt} iniciada (${trigger === 'TEST_FAILURE' ? 'falha de testes' : 'revisão solicitou mudanças'})`,
    data: { correctionId: record.id, attempt: record.attempt, trigger },
  })
  return record
}

async function finishCorrection(
  ctx: PoskliContext,
  record: CorrectionRecord,
  state: CorrectionRecord['state'],
  evidence: string,
  errorCode?: PoskliErrorCode
): Promise<void> {
  const idx = ctx.corrections.findIndex((c) => c.id === record.id)
  if (idx >= 0) {
    ctx.corrections[idx] = {
      ...ctx.corrections[idx],
      state,
      evidence: evidence.slice(0, 300),
      errorCode,
      finishedAt: new Date().toISOString(),
    }
    // nova referência do array — a UI lê do DB (persistRecords)
  }
  await persistRecords(ctx)
  await emitEvent({
    type: state === 'COMPLETED' ? 'correction.completed' : 'correction.failed',
    projectId: ctx.projectId,
    runId: ctx.runId,
    status: state,
    message:
      state === 'COMPLETED'
        ? `Poskli — correção ${record.attempt} aplicada`
        : state === 'BLOCKED'
          ? `Poskli — correção ${record.attempt} bloqueada (${errorCode ?? 'bloqueio'})`
          : `Poskli — correção ${record.attempt} falhou`,
    data: { correctionId: record.id, attempt: record.attempt, state },
  })
}

/** Executa UMA correção real (Engenheiro + saída real dos testes/revisão). */
async function applyCorrection(
  ctx: PoskliContext,
  record: CorrectionRecord,
  buildContext: () => Promise<string>
): Promise<void> {
  const target = (await db.task.findFirst({ where: { projectId: ctx.projectId, status: 'COMPLETED' }, orderBy: { order: 'desc' } }))
    ?? (await db.task.findFirst({ where: { projectId: ctx.projectId, status: { not: 'CANCELLED' } }, orderBy: { order: 'asc' } }))
  if (!target) {
    await finishCorrection(ctx, record, 'BLOCKED', 'nenhuma tarefa disponível para corrigir', 'WORKSPACE_FAILURE')
    return
  }
  const fix = await implementTask(ctx, target, await buildContext())
  if (fix.status === 'COMPLETED') {
    await transitionTask(target.id, 'COMPLETED', { result: { output: fix.result.slice(0, 3000), correctedIn: record.attempt } as object, error: null })
    await finishCorrection(ctx, record, 'COMPLETED', `correção aplicada: ${fix.result.slice(0, 140)}`)
    ctx.evidence.push(`Correção ${record.attempt} aplicada (${record.trigger === 'TEST_FAILURE' ? 'falha de testes' : 'revisão'})`)
  } else {
    const classified = classifyError(fix.result)
    await transitionTask(target.id, 'COMPLETED', { result: { output: fix.result.slice(0, 3000), correctedIn: record.attempt } as object })
    if (classified.code === 'QUOTA_EXHAUSTED') {
      // Tarefa C §3a: cota esgotada → correção BLOCKED + run ABORTADO
      // honestamente (nunca nova correção para erro de quota)
      await finishCorrection(ctx, record, 'BLOCKED', `cota esgotada: ${fix.result.slice(0, 140)}`, 'QUOTA_EXHAUSTED')
      ctx.errorCode = 'QUOTA_EXHAUSTED'
      ctx.evidence.push(`Correção ${record.attempt} bloqueada (QUOTA_EXHAUSTED) — run interrompido`)
      throw new QuotaExhaustedAbort('correção interrompida por cota esgotada')
    }
    await finishCorrection(ctx, record, classified.code === 'PROVIDER_RATE_LIMIT' ? 'BLOCKED' : 'FAILED', `tentativa falhou: ${fix.result.slice(0, 140)}`, classified.code)
    if (classified.code === 'PROVIDER_RATE_LIMIT') ctx.errorCode = classified.code
    ctx.evidence.push(`Correção ${record.attempt} não concluída (${classified.code})`)
  }
}

// ---------- ORQUESTRADOR PRINCIPAL ----------

/**
 * Executa o run. `poskliVersion` (opcional — seletor de modelos da UI)
 * define a cadeia de providers do ModelRouter para TODO este run via
 * AsyncLocalStorage; ausente/inválido → env POSKLI_VERSION decide.
 */
/** AGENT POOL — deteta o perfil da tarefa (TOON) do run e envolve
 *  a execução: o ModelRouter passa a selecionar os modelos por
 *  DIFICULDADE (simple/medium/hard/complex) via ALS, e o orçamento
 *  dos subagentes fica ELÁSTICO (150k–300k). */
export async function runPoskli(runId: string, poskliVersion?: string): Promise<void> {
  const run = await db.poskliRun.findUnique({ where: { id: runId } }).catch(() => null)
  const request = (run?.request ?? '').trim()
  if (!request) {
    return withPoskliVersion(poskliVersion, () => runPoskliInner(runId))
  }
  const toonTask = buildToonTask(request)
  const profile: PoskliTaskProfile = {
    difficulty: toonTask.difficulty,
    kind: toonTask.kind,
    toon: parseRequestToTOON(request),
  }
  return withPoskliVersion(poskliVersion, () =>
    withPoskliTaskProfile(profile, () => runPoskliInner(runId))
  )
}

async function runPoskliInner(runId: string): Promise<void> {
  const run = await db.poskliRun.findUnique({ where: { id: runId } })
  if (!run || run.state === 'CANCELLED') return

  const project = await db.project.findUnique({ where: { id: run.projectId } })
  if (!project) return

  const started = Date.now()
  const effectiveBudgetMs = process.env.VERCEL
    ? Math.min(STUDIO_CONFIG.limits.maxTotalExecutionMs, 270_000)
    : STUDIO_CONFIG.limits.maxTotalExecutionMs

  // FASE 2 — orçamento por NÍVEL da versão ativa (ALS do run > env):
  // limita tool calls, steps, timeout e contexto por agente.
  const levelBudget = budgetFor(requestPoskliVersion() ?? STUDIO_CONFIG.router.poskliVersion)

  // AGENT POOL — perfil da tarefa (TOON): dificuldade → seleção de
  // modelos por papel + orçamento ELÁSTICO dos subagentes
  const taskProfile = requestPoskliTaskProfile() ?? undefined

  const ctx: PoskliContext = {
    runId,
    projectId: run.projectId,
    userId: run.userId,
    request: run.request,
    deadline: started + effectiveBudgetMs,
    stages: (run.stages as unknown as StageEntry[]) ?? [],
    tokens: { in: 0, out: 0 },
    executions: 0,
    iteration: 0,
    maxIterations: run.maxIterations,
    evidence: [],
    plan: { architecture: '', stack: [], tasks: [] },
    budget: levelBudget,
    taskProfile,
    testRecords: [],
    corrections: [],
    review: { status: 'NOT_RUN', attempts: 0 },
    agentRunIds: [],
  }

  try {
    await db.project.update({ where: { id: ctx.projectId }, data: { status: 'RUNNING' } }).catch(() => {})

    // FASE VISÍVEL — análise (AGENT POOL): o usuário vê a classificação
    // TOON do pedido, os agentes selecionados e o orçamento elástico
    // ANTES do plano ("A analisar o pedido…" → "Plano: …")
    if (ctx.taskProfile) {
      const agents = agentsForProfile({ difficulty: ctx.taskProfile.difficulty, kind: ctx.taskProfile.kind })
      const elastic = getBudgetForTask(ctx.taskProfile.difficulty)
      await emitEvent({
        type: 'run.analyzed', // evento informativo (não muda estado)
        projectId: ctx.projectId,
        runId: ctx.runId,
        agent: 'master',
        message:
          `A analisar o pedido — ${ctx.taskProfile.toon} → agentes: ` +
          `programação ${agents.coding}, revisão ${agents.review} · orçamento elástico ` +
          `${Math.round(elastic.coding / 1000)}k tokens`,
        data: {
          toon: ctx.taskProfile.toon,
          difficulty: ctx.taskProfile.difficulty,
          kind: ctx.taskProfile.kind,
          agents,
          budget: elastic,
        },
      })
    }

    // snapshot pré-execução (restaurável via Workspace Snapshots)
    await workspaceProvider.snapshot(ctx.projectId, `Poskli: ${ctx.request.slice(0, 60)}`, 'poskli').catch(() => {})

    // 1) ANALYZING — Planejador analisa o pedido
    if (!(await setState(ctx, 'ANALYZING'))) return
    ctx.plan = await stage(ctx, 'ANALYZING', () => analyzeStage(ctx))
    ctx.evidence.push(`Plano: ${ctx.plan.tasks.length} tarefas (${ctx.plan.architecture.slice(0, 100)})`)

    // 2) PLANNING — grafo de tarefas persistido
    if (!(await setState(ctx, 'PLANNING'))) return
    let totalTasks = 0
    await stage(ctx, 'PLANNING', async () => {
      await db.task.updateMany({
        where: { projectId: ctx.projectId, status: { in: ['PENDING', 'BLOCKED', 'FAILED', 'RUNNING'] } },
        data: { status: 'CANCELLED', error: null },
      }).catch(() => {})
      const ids = await createTasksFromPlan(ctx.projectId, ctx.plan)
      totalTasks = ids.length
      await db.poskliRun.update({ where: { id: runId }, data: { plan: { tasks: ctx.plan.tasks, architecture: ctx.plan.architecture } as object } })
      return `Grafo pronto: ${totalTasks} tarefa(s) · loop agêntico (teto de ${agenticFixBudget(ctx.maxIterations, STUDIO_CONFIG.agentic.maxFixAttempts)} edições)`
    })

    // 3) IMPLEMENTING — Engenheiro executa as tarefas (com retry interno limitado)
    if (!(await setState(ctx, 'IMPLEMENTING'))) return
    await stage(ctx, 'IMPLEMENTING', async () => {
      let guard = 0
      let completed = 0
      while (guard++ < 24) {
        if (Date.now() > ctx.deadline) throw new Error(`TIMEOUT: orçamento de ${(effectiveBudgetMs / 1000).toFixed(0)}s esgotado na implementação`)
        const ready = await readyTasks(ctx.projectId)
        if (ready.length === 0) break
        const fresh = await db.task.findUnique({ where: { id: ready[0].id } })
        if (!fresh) continue
        if (fresh.attempts >= fresh.maxAttempts + 1) {
          await transitionTask(fresh.id, 'FAILED', { error: 'MAX_TASK_ATTEMPTS excedido' })
          continue
        }

        const exec = await implementTask(ctx, fresh)
        if (exec.status === 'COMPLETED') {
          await transitionTask(fresh.id, 'COMPLETED', { result: { output: exec.result.slice(0, 3000) } as object, error: null })
          completed++
          ctx.evidence.push(`✔ ${fresh.title}: ${exec.result.slice(0, 140)}`)
          // checkpoint git por ação (reversível — estilo Codex)
          await checkpointWorkspace(ctx, `task-${completed}`)
        } else {
          const classified = classifyError(exec.result)
          if (classified.code === 'QUOTA_EXHAUSTED') {
            // Tarefa C §3a: cota esgotada → tarefa FAILED + run ABORTADO
            // honestamente (nunca correção para erro de quota)
            await transitionTask(fresh.id, 'FAILED', { error: `${classified.friendly} [${classified.code}]` })
            ctx.errorCode = classified.code
            ctx.evidence.push(`✘ ${fresh.title}: QUOTA_EXHAUSTED — run interrompido`)
            throw new QuotaExhaustedAbort('implementação interrompida por cota esgotada')
          }
          if (classified.code === 'PROVIDER_RATE_LIMIT') {
            // sem retry para rate limit (política) — tarefa FAILED com causa real
            await transitionTask(fresh.id, 'FAILED', { error: `${classified.friendly} [${classified.code}]` })
            ctx.errorCode = classified.code
            ctx.evidence.push(`✘ ${fresh.title}: ${classified.code}`)
            continue
          }
          const fixed = await implementTask(ctx, {
            ...fresh,
            description: fresh.description + `\n\n[CORREÇÃO] Tentativa anterior falhou (${exec.status}). Resultado:\n${exec.result.slice(0, 900)}`,
          })
          if (fixed.status === 'COMPLETED') {
            await transitionTask(fresh.id, 'COMPLETED', { result: { output: fixed.result.slice(0, 3000) } as object, error: null })
            completed++
            ctx.evidence.push(`✔ (após retry) ${fresh.title}`)
          } else {
            await transitionTask(fresh.id, 'FAILED', { error: exec.result.slice(0, 900) })
            ctx.evidence.push(`✘ ${fresh.title}: ${exec.status}`)
          }
        }
      }
      return `${completed}/${totalTasks} tarefas implementadas`
    })

    // 4) TESTING — testes REAIS no Execution Engine (registro com identidade)
    if (!(await setState(ctx, 'TESTING'))) return
    let tests = await stage(ctx, 'TESTING', () => runTestsStage(ctx, 'INITIAL'))
    let testPassed = tests.passed

    // 5) LOOP AGÊNTICO (reconstrução — sem etapas "Corrigindo"/"Revisando"):
    //    se os testes falharam, o MESMO agente vê o erro e edita os
    //    arquivos DIRETAMENTE (estilo Claude Code/Codex). O estado
    //    visível alterna IMPLEMENTING ⇄ TESTING — nunca entra em
    //    CORRECTING/REVIEWING. Teto: 2 rodadas de edição + loop-guard
    //    (mesma assinatura de falha / repo sem mudanças) + orçamento.
    const failureSignatures: string[] = []
    if (!tests.passed) failureSignatures.push(failureSignature(tests.stdout, tests.stderr))
    const fixBudget = agenticFixBudget(ctx.maxIterations, STUDIO_CONFIG.agentic.maxFixAttempts)
    let repoChangedAfterFix: boolean | null = null
    while (!testPassed && Date.now() < ctx.deadline - 15_000) {
      const decision = agenticFixDecision({
        fixAttempts: ctx.iteration,
        fixBudget,
        sameSignatures: failureSignatures,
        repoChangedAfterFix,
      })
      if (!decision.continueFix) {
        ctx.evidence.push(decision.message)
        await emitEvent({
          type: 'correction.stopped',
          projectId: ctx.projectId,
          runId: ctx.runId,
          status: 'BLOCKED',
          message:
            decision.reason === 'FIX_BUDGET_EXHAUSTED'
              ? `O agente parou após ${ctx.iteration} rodada(s) de edição (teto ${fixBudget}) — reportando o estado real`
              : 'Loop detectado — edições interrompidas para poupar tokens',
          data: { reason: decision.reason ?? 'LOOP_GUARD', fixAttempts: ctx.iteration, fixBudget },
        })
        break
      }
      ctx.iteration++
      // o agente EDITA arquivos diretamente → estado visível IMPLEMENTING
      if (!(await setState(ctx, 'IMPLEMENTING'))) return
      const record = await startCorrection(ctx, 'TEST_FAILURE')
      let repoChanged: boolean | null = null
      await stage(ctx, 'IMPLEMENTING', async () => {
        // Tarefa C §3e: correção via DIFF + erro resumido — nunca o código
        // completo (builder PURO testável em correction-context.ts)
        const failureHints = clipToolOutput(extractFailureHints(tests.stdout, tests.stderr))
        const diff = await workspaceDiffSummary(ctx)
        const correctionCtx = buildCorrectionContext({
          command: tests.command,
          failureHints,
          diff,
        })
        await applyCorrection(ctx, record, async () => correctionCtx)
        // LOOP-GUARD: a edição alterou o repositório?
        repoChanged = await workspaceHasChanges(ctx)
        repoChangedAfterFix = repoChanged
        const rec = ctx.corrections.find((c) => c.id === record.id)
        // checkpoint da edição aplicada (reversível)
        if (rec?.state === 'COMPLETED') await checkpointWorkspace(ctx, `fix-${record.attempt}`)
        return rec ? `Edição agêntica #${record.attempt}: ${rec.state}` : `Edição agêntica #${record.attempt}`
      })
      await db.poskliRun.update({ where: { id: runId }, data: { iteration: ctx.iteration } }).catch(() => {})

      // edição sem mudanças no repo → parar honestamente
      if (repoChanged === false) {
        const guardMsg = 'LOOP_DETECTADO: a edição não alterou nenhum arquivo — o agente está repetindo raciocínio sem produzir mudanças.'
        ctx.evidence.push(guardMsg)
        await emitEvent({
          type: 'correction.stopped',
          projectId: ctx.projectId,
          runId: ctx.runId,
          status: 'BLOCKED',
          message: 'Loop detectado: a edição não alterou nenhum arquivo — interrompido',
          data: { reason: 'NO_REPO_CHANGE', correctionId: record.id },
        })
        break
      }

      if (!(await setState(ctx, 'TESTING'))) return
      tests = await stage(ctx, 'TESTING', () => runTestsStage(ctx, 'AFTER_CORRECTION'))
      testPassed = tests.passed
      if (!testPassed) failureSignatures.push(failureSignature(tests.stdout, tests.stderr))
    }

    // (6) SEM etapa REVIEWING — modo agêntico: a verificação de
    // qualidade vem dos TESTES REAIS + checklist determinístico.
    // A derivação final recebe reviewRequired=false.

    // checkpoint final antes da verificação (estado completo é reversível)
    await checkpointWorkspace(ctx, 'final')

    // 7) VERIFYING — checklist determinístico (preview + build + artefatos)
    if (!(await setState(ctx, 'VERIFYING'))) return
    let previewOk = false
    let verification: VerificationResult | null = null
    await stage(ctx, 'VERIFYING', async () => {
      // FASE 2 — REMOVIDO o re-teste FINAL: re-executar `npm test` sem
      // NENHUMA edição desde o último teste produzia exatamente o mesmo
      // resultado (até 180s desperdiçados por run, medido em auditoria).
      // O último TestRecord (INITIAL/AFTER_CORRECTION) é a verdade.
      const projectType = (await db.project.findUnique({ where: { id: ctx.projectId }, select: { type: true } }))?.type ?? 'EMPTY_PROJECT'
      // Projetos Godot: preview web NÃO se aplica (jogo nativo — a
      // validação real é godot_check/testes estruturais)
      const godotProject = await workspaceProvider.readFile(ctx.projectId, 'project.godot').then((f) => Boolean(f)).catch(() => false)
      const previewRequired = projectType !== 'API' && projectType !== 'EMPTY_PROJECT' && !godotProject
      previewOk = previewRequired ? await verifyPreview(ctx) : true
      const buildCommand = await buildCommandFor(ctx.projectId)
      let buildOk: boolean | null = null
      if (buildCommand && Date.now() < ctx.deadline - 45_000) {
        ctx.executions++
        const buildRes = await runExecution({
          projectId: ctx.projectId,
          command: buildCommand,
          userId: ctx.userId,
          source: 'poskli',
          trigger: 'verifier',
          timeoutMs: Math.min(90_000, Math.max(10_000, ctx.deadline - Date.now() - 10_000)),
        })
        buildOk = buildRes.status === 'SUCCESS' && buildRes.exitCode === 0
      }
      const artifactsProduced = await auditArtifacts(ctx)
      verification = {
        ran: true,
        checks: buildVerificationChecks({ previewRequired, previewOk: previewRequired ? previewOk : null, buildRequired: Boolean(buildCommand), buildOk, artifactsProduced }),
      }
      await db.poskliRun.update({
        where: { id: runId },
        data: { testsPassed: testPassed, previewOk, reviewResult: ctx.review as unknown as object },
      })
      const required = verification.checks.filter((c) => c.required)
      return `Verificação: ${required.filter((c) => c.status === 'PASS').length}/${required.length} checagens obrigatórias OK`
    })

    // 8) FINAL — deriveFinalStatus() é a FONTE DA VERDADE (nunca um boolean único)
    const derivation = deriveFinalStatus({
      cancelled: false,
      interrupted: false,
      tasks: await taskSnapshots(ctx.projectId),
      tests: ctx.testRecords,
      review: ctx.review,
      corrections: ctx.corrections,
      verification,
      testsRequired: true,
      // modo agêntico: sem etapa de revisão dedicada — a qualidade
      // é verificada pelos TESTES REAIS + checklist determinístico
      reviewRequired: false,
    } satisfies DeriveFinalStatusInput)
    await persistFinalResult(ctx, derivation, started)
  } catch (e) {
    // ---- ERRO: CLASSIFICAR → DERIVAR CONSERVADORAMENTE (nunca sucesso) ----
    const classified = classifyError(e)
    const row = await db.poskliRun.findUnique({ where: { id: runId }, select: { state: true } }).catch(() => null)
    const cancelled = row?.state === 'CANCELLED'
    try {
      const derivation = deriveFinalStatus({
        cancelled,
        interrupted: true, // fluxo não percorrido até o fim → nunca CONCLUÍDO
        tasks: await taskSnapshots(ctx.projectId).catch(() => [] as TaskSnapshot[]),
        tests: ctx.testRecords,
        review: ctx.review,
        corrections: ctx.corrections,
        verification: null,
        testsRequired: true,
        reviewRequired: false, // modo agêntico (sem revisão dedicada)
      } satisfies DeriveFinalStatusInput)
      await persistFinalResult(ctx, derivation, started, classified)
    } catch {
      // derivação falhou (DB?) — fallback honesto: FAILED com erro real
      await db.poskliRun.update({
        where: { id: runId },
        data: {
          state: 'FAILED',
          error: classified.detail.slice(0, 800),
          errorCode: classified.code,
          outcomeReason: 'ERRO_NA_EXECUÇÃO',
          tokensIn: ctx.tokens.in,
          tokensOut: ctx.tokens.out,
          finishedAt: new Date(),
        },
      }).catch(() => {})
    }
  } finally {
    // sync final + memória do projeto (best-effort)
    await syncBackToDb(ctx.projectId).catch(() => {})
    await updateProjectMemory(ctx.projectId, {
      completedTaskSummaries: [{ taskId: runId, title: `Poskli: ${ctx.request.slice(0, 80)}`, summary: (await db.poskliRun.findUnique({ where: { id: runId }, select: { result: true } }))?.result?.slice(0, 400) ?? '' }],
    }).catch(() => {})
  }
}

/** Persiste a derivação final — backend e UI consomem o MESMO objeto. */
async function persistFinalResult(
  ctx: PoskliContext,
  derivation: DeriveFinalStatusResult,
  started: number,
  classifiedError?: ReturnType<typeof classifyError>
): Promise<void> {
  const terminal = displayFromGlobal(derivation.state)
  const resultMd = deriveResultMarkdown(derivation, {
    request: ctx.request,
    tokens: ctx.tokens.in + ctx.tokens.out,
    iterations: `${ctx.iteration}/${ctx.maxIterations}`,
    evidence: ctx.evidence,
  })
  const lastTest = ctx.testRecords[ctx.testRecords.length - 1]

  await db.poskliRun.update({
    where: { id: ctx.runId },
    data: {
      state: terminal,
      derived: derivation as unknown as object,
      outcomeReason: derivation.reason,
      errorCode: classifiedError?.code ?? ctx.errorCode ?? null,
      result: resultMd,
      testsPassed: lastTest ? lastTest.status === 'PASS' : false,
      tokensIn: ctx.tokens.in,
      tokensOut: ctx.tokens.out,
      error: classifiedError ? classifiedError.detail.slice(0, 800) : derivation.state === 'SUCCESS' ? null : derivation.summary.slice(0, 800),
      finishedAt: new Date(),
    },
  })

  const projectStatus =
    derivation.state === 'SUCCESS' ? 'COMPLETED'
      : derivation.state === 'PARTIAL' ? 'PARTIAL'
        : derivation.state === 'BLOCKED' ? 'BLOCKED'
          : derivation.state === 'CANCELLED' ? 'CANCELLED'
            : 'FAILED'
  await db.project.update({ where: { id: ctx.projectId }, data: { status: projectStatus } }).catch(() => {})

  await emitEvent({
    type: derivation.state === 'SUCCESS' ? 'pipeline.completed' : 'pipeline.failed',
    projectId: ctx.projectId,
    runId: ctx.runId,
    status: terminal,
    message: `Poskli ${STATE_LABELS[terminal]} — ${derivation.summary.slice(0, 200)}`,
    durationMs: Date.now() - started,
    data: {
      finalState: derivation.state,
      reason: derivation.reason,
      criteria: derivation.criteria.map((c) => ({ id: c.id, status: c.status })),
      tasks: `${derivation.counters.tasks.completed}/${derivation.counters.tasks.total}`,
      corrections: derivation.counters.corrections.applied,
      tokens: ctx.tokens.in + ctx.tokens.out,
    },
  })
}

// ---------- RECUPERAÇÃO DE RUNS TRAVADOS (spec §12: interrompido ≠ concluído) ----------

/** Run ativo sem atividade (stale/freeze) → derivação conservadora honesta. */
export async function recoverStaleRun(runId: string): Promise<void> {
  const run = await db.poskliRun.findUnique({ where: { id: runId } })
  if (!run) return
  if (!['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING'].includes(run.state)) return

  const classified = run.error ? classifyError(run.error) : undefined
  const reviewSnapshot: ReviewSnapshot = (run.reviewResult as unknown as ReviewSnapshot) ?? { status: 'NOT_RUN', attempts: 0 }
  const derivation = deriveFinalStatus({
    cancelled: false,
    interrupted: true,
    tasks: await taskSnapshots(run.projectId).catch(() => [] as TaskSnapshot[]),
    tests: (run.testRecords as unknown as TestRecordSnapshot[]) ?? [],
    review: reviewSnapshot,
    corrections: (run.corrections as unknown as CorrectionSnapshot[]) ?? [],
    verification: null,
    testsRequired: true,
    // modo agêntico (sem revisão dedicada) — consistente com o fluxo vivo
    reviewRequired: false,
  } satisfies DeriveFinalStatusInput)

  const terminal = displayFromGlobal(derivation.state)
  const resultMd = deriveResultMarkdown(derivation, {
    request: run.request,
    tokens: run.tokensIn + run.tokensOut,
    iterations: `${run.iteration}/${run.maxIterations}`,
    evidence: ['Execução interrompida (run travado recuperado automaticamente)'],
  })
  const lastTest = ((run.testRecords as unknown as TestRecordSnapshot[]) ?? []).slice(-1)[0]

  await db.poskliRun.update({
    where: { id: runId },
    data: {
      state: terminal,
      derived: derivation as unknown as object,
      outcomeReason: derivation.reason,
      errorCode: classified?.code ?? 'BUDGET_TIMEOUT',
      error: (run.error ?? 'Run anterior travou (inatividade) — recuperado automaticamente').slice(0, 800),
      // relatório e snapshot efetivo: UI mostra a MESMA verdade da derivação
      result: resultMd,
      reviewResult: (run.reviewResult as unknown as object) ?? (reviewSnapshot as unknown as object),
      testsPassed: lastTest ? lastTest.status === 'PASS' : false,
      finishedAt: new Date(),
    },
  }).catch(() => {})
  const projectStatus =
    derivation.state === 'SUCCESS' ? 'COMPLETED'
      : derivation.state === 'PARTIAL' ? 'PARTIAL'
        : derivation.state === 'BLOCKED' ? 'BLOCKED'
          : derivation.state === 'CANCELLED' ? 'CANCELLED'
            : 'FAILED'
  await db.project.update({ where: { id: run.projectId }, data: { status: projectStatus } }).catch(() => {})
  await emitEvent({
    type: 'pipeline.failed',
    projectId: run.projectId,
    runId,
    status: terminal,
    message: `Poskli ${STATE_LABELS[terminal]} — execução interrompida recuperada com estado honesto`,
    data: { finalState: derivation.state, reason: derivation.reason, recovered: true },
  })
}

// ---------- BOOTSTRAP ----------

export interface StartPoskliOptions {
  projectId: string
  userId: string
  request: string
  maxIterations?: number
  /** versão do Poskli escolhida na UI (seletor) — registrada no evento de início */
  poskliVersion?: string
}

export async function startPoskli(opts: StartPoskliOptions): Promise<{ runId: string }> {
  const version =
    opts.poskliVersion && (POSKLI_VERSIONS as readonly string[]).includes(opts.poskliVersion.trim())
      ? opts.poskliVersion.trim()
      : undefined
  const run = await db.poskliRun.create({
    data: {
      projectId: opts.projectId,
      userId: opts.userId,
      request: opts.request.slice(0, 2000),
      state: 'ANALYZING',
      maxIterations: Math.min(Math.max(opts.maxIterations ?? 3, 1), 5),
      stages: [] as unknown as object,
    },
  })
  await emitEvent({
    type: 'pipeline.started',
    projectId: opts.projectId,
    runId: run.id,
    message: `Poskli iniciado: "${opts.request.slice(0, 120)}"`,
    data: { poskliVersion: version ?? 'env-default' },
  })
  return { runId: run.id }
}
