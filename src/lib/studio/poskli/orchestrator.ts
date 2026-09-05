// ============================================================
// POSKLI 0.1 — ORQUESTRADOR DE AGENTES
//
// USER → POSKLI ORCHESTRATOR → PLANNER → ENGINEER → TESTER
//      → REVIEWER → CORRECTION → FINAL VERIFICATION
//
// Estados visíveis ao usuário:
//   ANALYZING → PLANNING → IMPLEMENTING → TESTING →
//   (CORRECTING → TESTING)* → REVIEWING → VERIFYING →
//   COMPLETED | FAILED | CANCELLED
//
// DIFERENCIAL REAL:
//   - TESTES rodam no EXECUTION ENGINE (comandos de verdade,
//     registrados em Execution com stdout/stderr completos)
//   - CORREÇÃO alimenta o Engineer com a SAÍDA REAL dos testes
//     (arquivo/linha/erro), não com autodiagnóstico do modelo
//   - VERIFICAÇÃO FINAL: testes verdes + preview servindo
//   - Limites duros: MAX_ITERATIONS, MAX_TASKS, MAX_EXECUTIONS,
//     TIMEOUT (clamp serverless 270s) — NUNCA loop infinito
//   - Sem chain-of-thought: progresso operacional + resultados
// ============================================================

import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { getAgent } from '../agents/definitions'
import { runAgent, extractJson } from '../agents/base'
import {
  readProjectMemory, memoryToPrompt, updateProjectMemory, selectRelevantFiles,
} from '../context/context-manager'
import { createTasksFromPlan, projectProgress, transitionTask, readyTasks } from '../orchestrator/task-graph'
import { emitEvent } from '../events/bus'
import { ensureMaterialized, syncBackToDb } from '../workspace/sync'
import { workspaceProvider } from '../workspace/db-provider'
import { runExecution } from '../execution/engine'
import { getTemplate } from '../projects/templates'

// ---------- TIPOS ----------

export type PoskliState =
  | 'ANALYZING' | 'PLANNING' | 'IMPLEMENTING' | 'TESTING'
  | 'REVIEWING' | 'CORRECTING' | 'VERIFYING'
  | 'COMPLETED' | 'FAILED' | 'CANCELLED'

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
}

const MAX_TASKS = 8

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
    entry.summary = (e as Error).message.slice(0, 400)
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

/** Extrai pistas de arquivo/linha da saída REAL dos testes. */
function extractFailureHints(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`.split('\n')
  const hints = lines
    .filter((l) => /error|fail|assert|expected|actual|✖|not ok|throw/i.test(l))
    .slice(0, 12)
  return hints.join('\n').slice(0, 2200) || '(sem detalhes de falha no output)'
}

// ---------- ESTÁGIOS ----------

async function analyzeStage(ctx: PoskliContext): Promise<Plan> {
  const master = getAgent('master')!
  const project = await db.project.findUnique({ where: { id: ctx.projectId } })
  const memory = await readProjectMemory(ctx.projectId)
  const root = await ensureMaterialized(ctx.projectId)
  const files = await selectRelevantFiles(root, [], ctx.request)
  const fileBlock = files
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 2200)}\n\`\`\``)
    .join('\n')
    .slice(0, 20000)

  const out = await runAgent(
    {
      agent: master,
      projectId: ctx.projectId,
      workspaceRoot: root,
      runType: 'PLAN',
      objective: [
        `Pedido do usuário: "${ctx.request}"`,
        '',
        'Analise o estado atual do projeto e produza um plano JSON:',
        '{"plan": {"architecture": "...", "stack": [...], "tasks": [{"title": "...", "description": "...", "agentRole": "coding|testing|review", "priority": "HIGH|MEDIUM|LOW", "dependsOn": [índices]}]}}',
        'MÁXIMO 4 tarefas. Cada tarefa concreta e verificável por testes.',
      ].join('\n'),
      contextBlock: [
        `## PROJETO: ${project?.name} (tipo: ${project?.type})`,
        `## DESCRIÇÃO: ${project?.description}`,
        `## MEMÓRIA DO PROJETO\n${memoryToPrompt(memory)}`,
        fileBlock ? `## ARQUIVOS RELEVANTES\n${fileBlock}` : '(workspace vazio ou sem arquivos relevantes)',
      ].join('\n\n'),
    },
    12
  )
  ctx.tokens.in += out.tokensIn
  ctx.tokens.out += out.tokensOut

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
  plan.tasks = plan.tasks.slice(0, MAX_TASKS)
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
  const files = await selectRelevantFiles(root, [], task.title + ' ' + task.description)
  const fileBlock = files
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 2500)}\n\`\`\``)
    .join('\n')
    .slice(0, 16000)

  await transitionTask(task.id, 'RUNNING', { attempts: { increment: 1 }, input: { description: task.description, agentRole: task.agentRole, poskli: ctx.runId } as object })
  await emitEvent({ type: 'task.started', projectId: ctx.projectId, taskId: task.id, agent: agent.id, message: `Poskli — implementando: ${task.title}` })

  const out = await runAgent(
    {
      agent,
      projectId: ctx.projectId,
      workspaceRoot: root,
      taskId: task.id,
      runType: task.agentRole === 'review' ? 'REVIEW' : task.agentRole === 'testing' ? 'TEST' : 'TASK',
      objective: [
        `TAREFA: ${task.title}`,
        '',
        `DESCRIÇÃO:\n${task.description}`,
        extraContext ? `\n## CONTEXTO ADICIONAL\n${extraContext}` : '',
        '',
        'Complete a tarefa com código real. Ao final, cite evidências.',
      ].filter(Boolean).join('\n'),
      contextBlock: [`## MEMÓRIA DO PROJETO\n${memoryToPrompt(memory)}`, fileBlock ? `## ARQUIVOS ATUAIS\n${fileBlock}` : ''].filter(Boolean).join('\n\n'),
    },
    Math.min(STUDIO_CONFIG.limits.maxToolCalls, 40)
  )
  ctx.tokens.in += out.tokensIn
  ctx.tokens.out += out.tokensOut
  return { status: out.status, result: out.result }
}

async function runTestsStage(ctx: PoskliContext, label: string): Promise<TestOutcome> {
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

  await emitEvent({
    type: passed ? 'test.passed' : 'test.failed',
    projectId: ctx.projectId,
    runId: ctx.runId,
    agent: 'testing',
    tool: 'execution',
    status: passed ? 'OK' : 'ERROR',
    message: `Poskli — testes ${passed ? 'PASSARAM' : 'FALHARAM'} (${label}): exit ${res.exitCode}`,
    durationMs: res.durationMs,
  })
  return { passed, executionId: res.executionId, command, stdout: res.stdout, stderr: res.stderr }
}

async function reviewStage(ctx: PoskliContext): Promise<{ verdict: string; issues: unknown[]; summary: string }> {
  const reviewAgent = getAgent('review')!
  const root = await ensureMaterialized(ctx.projectId)
  const out = await runAgent(
    {
      agent: reviewAgent,
      projectId: ctx.projectId,
      workspaceRoot: root,
      runType: 'REVIEW',
      objective: [
        `Revise a implementação do pedido: "${ctx.request.slice(0, 300)}"`,
        '',
        `Evidências coletadas:\n${ctx.evidence.slice(-6).map((e) => `- ${e}`).join('\n')}`,
        '',
        'Verifique com evidências reais (git_diff, run_tests, leitura de arquivos) e emita veredito JSON:',
        '{"verdict": "APPROVE" | "CHANGES_REQUESTED", "issues": [...], "summary": "..."}',
      ].join('\n'),
      contextBlock: '',
    },
    16
  )
  ctx.tokens.in += out.tokensIn
  ctx.tokens.out += out.tokensOut

  const verdictJson = extractJson(out.result)
  const verdict = String(verdictJson?.verdict ?? (out.result.includes('APPROVE') ? 'APPROVE' : 'CHANGES_REQUESTED'))
  const issues = (verdictJson?.issues as unknown[]) ?? []
  return { verdict, issues, summary: out.result.slice(0, 600) }
}

async function verifyPreview(ctx: PoskliContext): Promise<boolean> {
  const project = await db.project.findUnique({ where: { id: ctx.projectId }, select: { type: true } })
  const type = project?.type ?? 'EMPTY_PROJECT'
  if (type === 'API' || type === 'EMPTY_PROJECT') return true
  const index = await workspaceProvider.readFile(ctx.projectId, 'index.html').catch(() => null)
  return Boolean(index)
}

// ---------- ORQUESTRADOR PRINCIPAL ----------

export async function runPoskli(runId: string): Promise<void> {
  const run = await db.poskliRun.findUnique({ where: { id: runId } })
  if (!run || run.state === 'CANCELLED') return

  const project = await db.project.findUnique({ where: { id: run.projectId } })
  if (!project) return

  const started = Date.now()
  const effectiveBudgetMs = process.env.VERCEL
    ? Math.min(STUDIO_CONFIG.limits.maxTotalExecutionMs, 270_000)
    : STUDIO_CONFIG.limits.maxTotalExecutionMs

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
  }

  try {
    await db.project.update({ where: { id: ctx.projectId }, data: { status: 'RUNNING' } }).catch(() => {})

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
      return `Grafo pronto: ${totalTasks} tarefa(s)`
    })

    // 3) IMPLEMENTING — Engenheiro executa as tarefas (com retry interno)
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
        } else {
          const fixed = await implementTask(ctx, {
            ...fresh,
            description: fresh.description + `\n\n[CORREÇÃO] Tentativa anterior falhou (${exec.status}). Resultado:\n${exec.result.slice(0, 900)}`,
          })
          if (fixed.status === 'COMPLETED') {
            await transitionTask(fresh.id, 'COMPLETED', { result: { output: fixed.result.slice(0, 3000) } as object, error: null })
            completed++
            ctx.evidence.push(`✔ (após correção) ${fresh.title}`)
          } else {
            await transitionTask(fresh.id, 'FAILED', { error: exec.result.slice(0, 900) })
            ctx.evidence.push(`✘ ${fresh.title}: ${exec.status}`)
          }
        }
      }
      return `${completed}/${totalTasks} tarefas implementadas`
    })

    // 4) TESTING — testes REAIS no Execution Engine
    if (!(await setState(ctx, 'TESTING'))) return
    let tests = await stage(ctx, 'TESTING', () => runTestsStage(ctx, 'primeira execução'))
    let testPassed = tests.passed

    // 5) CORRECTING ← TESTING (loop limitado por maxIterations)
    while (!testPassed && ctx.iteration < ctx.maxIterations && Date.now() < ctx.deadline - 15_000) {
      ctx.iteration++
      if (!(await setState(ctx, 'CORRECTING'))) return
      const failureHints = extractFailureHints(tests.stdout, tests.stderr)
      await stage(ctx, 'CORRECTING', async () => {
        const target = (await db.task.findFirst({ where: { projectId: ctx.projectId, status: 'COMPLETED' }, orderBy: { order: 'desc' } }))
          ?? (await db.task.findFirst({ where: { projectId: ctx.projectId }, orderBy: { order: 'asc' } }))
        if (!target) return 'nenhuma tarefa para corrigir'
        const fix = await implementTask(
          ctx,
          target,
          [
            '## FALHA REAL DOS TESTES (Execution Engine — saída do comando)',
            `Comando: ${tests.command}`,
            '',
            failureHints,
            '',
            'Corrija o código para que os testes passem. LEIA os arquivos citados antes de editar.',
          ].join('\n')
        )
        await transitionTask(target.id, 'COMPLETED', { result: { output: fix.result.slice(0, 3000), correctedIn: ctx.iteration } as object, error: null })
        return `Correção #${ctx.iteration} aplicada: ${fix.status}`
      })
      ctx.evidence.push(`Correção #${ctx.iteration} (falha real: ${tests.stderr.split('\n').filter(Boolean).slice(0, 1).join(' ').slice(0, 100) || 'exit != 0'})`)

      if (!(await setState(ctx, 'TESTING'))) return
      tests = await stage(ctx, 'TESTING', () => runTestsStage(ctx, `após correção ${ctx.iteration}`))
      testPassed = tests.passed
    }
    await db.poskliRun.update({ where: { id: runId }, data: { testsPassed: testPassed, iteration: ctx.iteration } })

    // 6) REVIEWING — Revisor de Qualidade
    if (!(await setState(ctx, 'REVIEWING'))) return
    const review = await stage(ctx, 'REVIEWING', () => reviewStage(ctx))

    // Revisor pediu mudanças → última correção honesta (se houver orçamento)
    if (review.verdict === 'CHANGES_REQUESTED' && Date.now() < ctx.deadline - 40_000 && ctx.iteration < ctx.maxIterations) {
      ctx.iteration++
      if (await setState(ctx, 'CORRECTING')) {
        await stage(ctx, 'CORRECTING', async () => {
          const target = await db.task.findFirst({ where: { projectId: ctx.projectId, status: { in: ['COMPLETED', 'RUNNING', 'FAILED', 'PENDING'] } }, orderBy: { order: 'desc' } })
          if (!target) return 'nada a corrigir'
          const fix = await implementTask(
            ctx,
            target,
            `## REVISÃO SOLICITOU MUDANÇAS\n${review.summary.slice(0, 700)}\n\nAplique as correções apontadas.`
          )
          // transição final SEMPRE (bugfix: tarefa não podia ficar RUNNING)
          await transitionTask(
            target.id,
            fix.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
            { result: { output: fix.result.slice(0, 3000), correctedIn: ctx.iteration } as object, error: fix.status === 'COMPLETED' ? null : fix.result.slice(0, 800) }
          )
          return `Correção pós-revisão: ${fix.status}`
        })
        if (await setState(ctx, 'TESTING')) {
          tests = await stage(ctx, 'TESTING', () => runTestsStage(ctx, 'pós-revisão'))
          testPassed = tests.passed
        }
      }
    }

    // 7) VERIFYING — testes + preview de verdade
    if (!(await setState(ctx, 'VERIFYING'))) return
    let previewOk = false
    await stage(ctx, 'VERIFYING', async () => {
      if (!testPassed && Date.now() < ctx.deadline - 20_000) {
        tests = await runTestsStage(ctx, 'verificação final')
        testPassed = tests.passed
      }
      previewOk = await verifyPreview(ctx)
      await db.poskliRun.update({ where: { id: runId }, data: { testsPassed: testPassed, previewOk } })
      return `Testes: ${testPassed ? 'OK' : 'FALHARAM'} · Preview: ${previewOk ? 'OK' : 'sem entrypoint web'}`
    })

    // 8) FINAL — estado honesto + relatório
    const progress = await projectProgress(ctx.projectId)
    const finalState: PoskliState = testPassed ? 'COMPLETED' : 'FAILED'
    const resultMd = [
      '## Resultado do Poskli',
      '',
      `**Pedido:** ${ctx.request.slice(0, 300)}`,
      `**Estado:** ${testPassed ? 'CONCLUÍDO' : 'FALHOU'} — testes ${testPassed ? 'verdes' : 'vermelhos'}${previewOk ? ', preview pronto' : ''}`,
      `**Tarefas:** ${progress.completed}/${progress.total} concluídas`,
      `**Iterações de correção:** ${ctx.iteration}/${ctx.maxIterations}`,
      `**Testes (última execução):** ${tests.passed ? 'PASS' : 'FAIL'} — \`${tests.command}\``,
      `**Tokens:** ${ctx.tokens.in + ctx.tokens.out}`,
      '',
      '### Evidências',
      ...ctx.evidence.slice(-10).map((e) => `- ${e}`),
      testPassed ? '' : `\n### Causa da falha\n${extractFailureHints(tests.stdout, tests.stderr).slice(0, 1200)}`,
    ].join('\n')

    await db.poskliRun.update({
      where: { id: runId },
      data: {
        state: finalState,
        result: resultMd,
        tokensIn: ctx.tokens.in,
        tokensOut: ctx.tokens.out,
        finishedAt: new Date(),
      },
    })
    await db.project.update({
      where: { id: ctx.projectId },
      data: { status: finalState === 'COMPLETED' ? 'COMPLETED' : 'FAILED' },
    }).catch(() => {})
    await emitEvent({
      type: finalState === 'COMPLETED' ? 'pipeline.completed' : 'pipeline.failed',
      projectId: ctx.projectId,
      runId,
      status: finalState,
      message: `Poskli ${finalState === 'COMPLETED' ? 'concluiu' : 'não conseguiu concluir'} o pedido — testes ${testPassed ? 'OK' : 'FALHARAM'}`,
      durationMs: Date.now() - started,
      data: { tokens: ctx.tokens.in + ctx.tokens.out, testsPassed: testPassed, previewOk },
    })

    // sync final + memória do projeto
    await syncBackToDb(ctx.projectId).catch(() => {})
    await updateProjectMemory(ctx.projectId, {
      completedTaskSummaries: [{ taskId: runId, title: `Poskli: ${ctx.request.slice(0, 80)}`, summary: resultMd.slice(0, 400) }],
    }).catch(() => {})
  } catch (e) {
    const msg = (e as Error).message
    const row = await db.poskliRun.findUnique({ where: { id: runId }, select: { state: true } }).catch(() => null)
    const cancelled = row?.state === 'CANCELLED'
    await db.poskliRun.update({
      where: { id: runId },
      data: {
        state: cancelled ? 'CANCELLED' : 'FAILED',
        error: msg.slice(0, 800),
        tokensIn: ctx.tokens.in,
        tokensOut: ctx.tokens.out,
        finishedAt: new Date(),
      },
    }).catch(() => {})
    await db.project.update({ where: { id: ctx.projectId }, data: { status: 'FAILED' } }).catch(() => {})
    await emitEvent({
      type: 'pipeline.failed',
      projectId: ctx.projectId,
      runId,
      message: 'Poskli não concluiu — abra a execução para ver a causa real',
      data: { error: msg.slice(0, 300) },
    })
  }
}

// ---------- BOOTSTRAP ----------

export interface StartPoskliOptions {
  projectId: string
  userId: string
  request: string
  maxIterations?: number
}

export async function startPoskli(opts: StartPoskliOptions): Promise<{ runId: string }> {
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
  })
  return { runId: run.id }
}
