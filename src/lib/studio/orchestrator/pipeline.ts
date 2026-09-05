// ============================================================
// ORCHESTRATOR / PIPELINE — ENGINEERING PERFECTION LOOP
//
// USER → MASTER(análise/plano) → TASK GRAPH →
// AGENTES ESPECIALIZADOS(tools) → IMPLEMENTAÇÃO →
// TESTES → REVIEW → CORREÇÕES → VALIDAÇÃO FINAL.
//
// Loop controlado (JAMAIS infinito):
//   IMPLEMENT → TEST → ANALYZE → FIX → TEST AGAIN →
//   REVIEW → (CHANGES? → CREATE_FIX_TASK → IMPLEMENT) →
//   APPROVE → DONE
// Limites: MAX_TASK_ATTEMPTS, MAX_REVIEW_CYCLES,
// MAX_AGENT_STEPS, MAX_TOOL_CALLS, MAX_TOTAL_EXECUTION_TIME.
// ============================================================

import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { getAgent, type AgentDefinition } from '../agents/definitions'
import { runAgent, extractJson, type AgentRunOutput } from '../agents/base'
import {
  selectRelevantFiles,
  readProjectMemory,
  memoryToPrompt,
  updateProjectMemory,
  clipTestOutput,
} from '../context/context-manager'
import { createTasksFromPlan, readyTasks, projectProgress, transitionTask } from './task-graph'
import { emitEvent } from '../events/bus'
import { projectRoot } from '../projects/workspace'
import { RepeatedFailureDetector } from './loop-detector'

export interface PipelineRequest {
  projectId: string
  userRequest: string
  userId: string
}

export interface PipelineSummary {
  projectId: string
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED'
  message: string
  progress: Awaited<ReturnType<typeof projectProgress>>
  tokens: { in: number; out: number }
  tasksCompleted: number
  tasksFailed: number
  reviewCycles: number
  evidence: string[]
}

// ---------- PLANNER (Master Agent) ----------

async function runPlanner(req: PipelineRequest): Promise<{ plan: { architecture: string; stack: string[]; tasks: Array<{ title: string; description: string; agentRole: string; priority: string; dependsOn: number[] }> }; raw: string }> {
  const master = getAgent('master')!
  const root = projectRoot(req.projectId)
  const project = await db.project.findUnique({ where: { id: req.projectId } })
  const memory = await readProjectMemory(req.projectId)
  const files = await selectRelevantFiles(root, [], req.userRequest)

  const fileBlock = files
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 2500)}\n\`\`\``)
    .join('\n')
    .slice(0, 24000)

  const contextBlock = [
    `## PROJETO: ${project?.name} (tipo: ${project?.type})`,
    `## DESCRIÇÃO: ${project?.description}`,
    `## MEMÓRIA DO PROJETO\n${memoryToPrompt(memory)}`,
    fileBlock ? `## ARQUIVOS RELEVANTES\n${fileBlock}` : '(workspace vazio ou sem arquivos relevantes)',
  ].join('\n\n')

  const out = await runAgent(
    {
      agent: master,
      projectId: req.projectId,
      workspaceRoot: root,
      runType: 'PLAN',
      objective: `Pedido do usuário: "${req.userRequest}"\n\nAnalise o estado atual do projeto, planeje a arquitetura e produza o plano de tarefas (JSON conforme protocolo).`,
      contextBlock,
    },
    15
  )

  const planJson = extractJson(out.result)
  let plan = (planJson?.plan as typeof plan) ?? null
  if (!plan && planJson?.tasks) plan = planJson as never

  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    // Plano de fallback determinístico (o pipeline NUNCA morre sem plano)
    plan = {
      architecture: plan?.architecture ?? 'Arquitetura definida pelo pipeline de fallback',
      stack: plan?.stack ?? [],
      tasks: fallbackPlan(req.userRequest),
    }
  }

  await updateProjectMemory(req.projectId, {
    architecture: plan.architecture,
    stack: plan.stack,
    decisions: [
      { at: new Date().toISOString(), decision: 'Plano criado pelo Master Agent', reason: req.userRequest.slice(0, 200) },
    ],
  })

  return { plan, raw: out.result }
}

function fallbackPlan(userRequest: string) {
  const isGame = /game|jogo|sobreviv|plataforma|arcade/i.test(userRequest)
  const isLanding = /landing|página|site|website/i.test(userRequest)
  const isApi = /api|backend|servidor/i.test(userRequest)
  if (isGame) {
    return [
      { title: 'Estrutura e game loop', description: 'Configure o game loop com delta time, canvas responsivo e entrada touch/teclado conforme o pedido: ' + userRequest, agentRole: 'coding', priority: 'HIGH', dependsOn: [] },
      { title: 'Mecânica principal e player', description: 'Implemente o player, controles touch mobile-first e a mecânica principal do jogo pedida.', agentRole: 'coding', priority: 'HIGH', dependsOn: [0] },
      { title: 'Desafios, colisão e pontuação', description: 'Implemente inimigos/obstáculos/itens, sistema de colisão e pontuação com HUD.', agentRole: 'coding', priority: 'HIGH', dependsOn: [1] },
      { title: 'Testes automatizados', description: 'Crie testes node:test cobrindo game loop, controles, colisão e pontuação; execute e reporte evidências.', agentRole: 'testing', priority: 'HIGH', dependsOn: [2] },
      { title: 'Revisão final de qualidade', description: 'Revise requisitos, bugs, performance mobile e segurança. APPROVE ou CHANGES_REQUESTED.', agentRole: 'review', priority: 'HIGH', dependsOn: [3] },
    ]
  }
  if (isLanding) {
    return [
      { title: 'Estrutura da página', description: 'Crie a estrutura HTML mobile-first da landing page conforme o pedido: ' + userRequest, agentRole: 'coding', priority: 'HIGH', dependsOn: [] },
      { title: 'Conteúdo, estilo e responsividade', description: 'Implemente seções, estilos modernos e responsividade completa (mobile → desktop).', agentRole: 'coding', priority: 'HIGH', dependsOn: [0] },
      { title: 'Testes estruturais', description: 'Testes node:test para estrutura, acessibilidade e responsividade; execute e reporte.', agentRole: 'testing', priority: 'MEDIUM', dependsOn: [1] },
      { title: 'Revisão final', description: 'Revise requisitos, qualidade visual e semântica. APPROVE ou CHANGES_REQUESTED.', agentRole: 'review', priority: 'MEDIUM', dependsOn: [2] },
    ]
  }
  if (isApi) {
    return [
      { title: 'Estrutura e modelo de dados', description: 'Implemente a estrutura da API e modelo de dados conforme: ' + userRequest, agentRole: 'coding', priority: 'HIGH', dependsOn: [] },
      { title: 'Rotas e validação', description: 'Implemente endpoints REST com validação de input e tratamento de erros.', agentRole: 'coding', priority: 'HIGH', dependsOn: [0] },
      { title: 'Testes da API', description: 'Testes node:test para rotas, validações e erros; execute e reporte.', agentRole: 'testing', priority: 'HIGH', dependsOn: [1] },
      { title: 'Revisão final', description: 'Revise requisitos, segurança e robustez. APPROVE ou CHANGES_REQUESTED.', agentRole: 'review', priority: 'MEDIUM', dependsOn: [2] },
    ]
  }
  return [
    { title: 'Implementação principal', description: 'Implemente o pedido do usuário: ' + userRequest, agentRole: 'coding', priority: 'HIGH', dependsOn: [] },
    { title: 'Testes', description: 'Crie e execute testes relevantes; reporte evidências.', agentRole: 'testing', priority: 'HIGH', dependsOn: [0] },
    { title: 'Revisão', description: 'Revise requisitos e qualidade. APPROVE ou CHANGES_REQUESTED.', agentRole: 'review', priority: 'HIGH', dependsOn: [1] },
  ]
}

// ---------- EXECUÇÃO DE TAREFA (com Perfection Loop por tarefa) ----------

interface TaskExecution {
  status: 'COMPLETED' | 'FAILED' | 'REPEATED_FAILURE' | 'MAX_LIMITS_REACHED' | 'TIMEOUT'
  result: string
  review?: { verdict: string; issues: unknown[] }
  attempts: number
}

async function executeTask(
  req: PipelineRequest,
  task: { id: string; title: string; description: string; agentRole: string; attempts: number },
  totalDeadline: number,
  reviewCycle: { count: number },
  pipelineTokens: { in: number; out: number },
  detector: RepeatedFailureDetector
): Promise<TaskExecution> {
  const agent = getAgent(task.agentRole) ?? getAgent('coding')!
  const root = projectRoot(req.projectId)
  const memory = await readProjectMemory(req.projectId)
  const files = await selectRelevantFiles(root, [], task.title + ' ' + task.description)
  const fileBlock = files
    .map((f) => `### ${f.path} (${f.reason})\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``)
    .join('\n')
    .slice(0, 20000)

  const contextBlock = [
    `## MEMÓRIA DO PROJETO\n${memoryToPrompt(memory)}`,
    fileBlock ? `## ARQUIVOS ATUAIS RELEVANTES\n${fileBlock}` : '(workspace sem arquivos relevantes ainda)',
  ].join('\n\n')

  await transitionTask(task.id, 'RUNNING', { attempts: { increment: 1 }, input: { description: task.description, agentRole: task.agentRole } as object })
  await emitEvent({ type: 'task.started', projectId: req.projectId, taskId: task.id, agent: agent.id, message: `Executando: ${task.title}` })

  const out = await runAgent(
    {
      agent,
      projectId: req.projectId,
      workspaceRoot: root,
      taskId: task.id,
      runType: task.agentRole === 'review' ? 'REVIEW' : task.agentRole === 'testing' ? 'TEST' : 'TASK',
      objective: `TAREFA: ${task.title}\n\nDESCRIÇÃO:\n${task.description}\n\nComplete a tarefa com código real e verificação. Ao final, cite evidências.`,
      contextBlock,
    },
    STUDIO_CONFIG.limits.maxToolCalls
  )
  pipelineTokens.in += out.tokensIn
  pipelineTokens.out += out.tokensOut

  // ---------- REVIEW (se a tarefa não for de review) ----------
  if (task.agentRole !== 'review' && out.status === 'COMPLETED') {
    const reviewResult = await runReviewCycle(req, task, out, reviewCycle, pipelineTokens, detector)
    if (reviewResult.verdict === 'CHANGES_REQUESTED') {
      return { status: 'FAILED', result: `REVIEW reprovou: ${reviewResult.summary}`, review: reviewResult, attempts: task.attempts + 1 }
    }
    return { status: 'COMPLETED', result: out.result, review: reviewResult, attempts: task.attempts + 1 }
  }

  return {
    status: out.status === 'COMPLETED' ? 'COMPLETED' : out.status,
    result: out.result,
    attempts: task.attempts + 1,
  }
}

async function runReviewCycle(
  req: PipelineRequest,
  task: { id: string; title: string; description: string; agentRole: string },
  implementationOutput: AgentRunOutput,
  reviewCycle: { count: number },
  pipelineTokens: { in: number; out: number },
  detector: RepeatedFailureDetector
): Promise<{ verdict: string; issues: unknown[]; summary: string }> {
  reviewCycle.count++
  if (reviewCycle.count > STUDIO_CONFIG.limits.maxReviewCycles) {
    await emitEvent({
      type: 'limits.reached',
      projectId: req.projectId,
      taskId: task.id,
      message: `MAX_REVIEW_CYCLES (${STUDIO_CONFIG.limits.maxReviewCycles}) atingido — parando para intervenção`,
    })
    return { verdict: 'MAX_CYCLES', issues: [], summary: 'limite de ciclos de review atingido' }
  }

  const reviewAgent = getAgent('review')!
  const root = projectRoot(req.projectId)
  await emitEvent({ type: 'review.started', projectId: req.projectId, taskId: task.id, agent: 'review', message: `Revisão de: ${task.title}` })

  const out = await runAgent(
    {
      agent: reviewAgent,
      projectId: req.projectId,
      workspaceRoot: root,
      taskId: task.id,
      runType: 'REVIEW',
      objective: `Revise a implementação da tarefa: "${task.title}".\n\nDESCRIÇÃO DA TAREFA:\n${task.description}\n\nRESULTADO REPORTADO PELO AGENTE IMPLEMENTADOR:\n${clipTestOutput(implementationOutput.result).slice(0, 2000)}\n\nVerifique com evidências (git_diff, run_tests) e emita veredito.`,
      contextBlock: '',
    },
    20
  )
  pipelineTokens.in += out.tokensIn
  pipelineTokens.out += out.tokensOut

  const verdictJson = extractJson(out.result)
  const verdict = String(verdictJson?.verdict ?? (out.result.includes('APPROVE') ? 'APPROVE' : 'CHANGES_REQUESTED'))
  const issues = (verdictJson?.issues as unknown[]) ?? []

  await emitEvent({
    type: verdict === 'APPROVE' ? 'review.approved' : 'review.changes_requested',
    projectId: req.projectId,
    taskId: task.id,
    agent: 'review',
    status: verdict,
    message: verdict === 'APPROVE' ? `Aprovado: ${task.title}` : `Correções solicitadas (${(issues as unknown[]).length} issues)`,
    data: { verdict, issues: issues.slice(0, 10) },
  })

  return { verdict, issues, summary: out.result.slice(0, 600) }
}

// ---------- PIPELINE PRINCIPAL ----------

export async function runPipeline(req: PipelineRequest): Promise<PipelineSummary> {
  const started = Date.now()
  // No serverless (Vercel) a invocação vive no máximo maxDuration (300s aqui);
  // clamp do orçamento total para 270s evita tarefas RUNNING órfãs quando a
  // função é suspensa. Fora do serverless, usa o orçamento configurado.
  const effectiveBudgetMs = process.env.VERCEL
    ? Math.min(STUDIO_CONFIG.limits.maxTotalExecutionMs, 270_000)
    : STUDIO_CONFIG.limits.maxTotalExecutionMs
  const totalDeadline = started + effectiveBudgetMs
  const tokens = { in: 0, out: 0 }
  const evidence: string[] = []
  const reviewCycle = { count: 0 }
  const detector = new RepeatedFailureDetector(STUDIO_CONFIG.limits.repeatedFailureThreshold)

  await db.project.update({ where: { id: req.projectId }, data: { status: 'PLANNING' } })
  await emitEvent({ type: 'pipeline.started', projectId: req.projectId, message: `Pipeline iniciado: "${req.userRequest.slice(0, 150)}"` })

  // 1) PLANEJAMENTO
  const { plan } = await runPlanner(req)
  const taskIds = await createTasksFromPlan(req.projectId, plan)
  evidence.push(`Plano criado com ${taskIds.length} tarefas (arquitetura: ${plan.architecture?.slice(0, 100)})`)
  await db.project.update({ where: { id: req.projectId }, data: { status: 'RUNNING' } })

  // 2) EXECUÇÃO DO GRAFO (com retries por tarefa)
  let guard = 0
  const maxGuard = 200 // proteção estrutural absoluta
  while (guard++ < maxGuard) {
    if (Date.now() > totalDeadline) {
      evidence.push(`TOTAL_DEADLINE excedido (${effectiveBudgetMs}ms) — parando com diagnóstico`)
      break
    }
    const ready = await readyTasks(req.projectId)
    if (ready.length === 0) {
      const progress = await projectProgress(req.projectId)
      const stuck = progress.byStatus.FAILED ?? 0
      if (stuck > 0 && (progress.byStatus.PENDING ?? 0) + (progress.byStatus.BLOCKED ?? 0) > 0) {
        // TODAS prontas falharam (dependências insatisfeitas) → para
        evidence.push(`${stuck} tarefas falharam bloqueando o grafo — parando com diagnóstico`)
        break
      }
      break // concluído ou nada mais a fazer
    }

    const task = ready[0]
    const freshTask = await db.task.findUnique({ where: { id: task.id } })
    if (!freshTask) continue
    // LIMITE RÍGIDO: maxAttempts é ABSOLUTO por tarefa. Ciclos de review
    // têm orçamento próprio (MAX_REVIEW_CYCLES, aplicado em runReviewCycle)
    // e NÃO ampliam as tentativas da tarefa (limite único e honesto).
    if (freshTask.attempts >= freshTask.maxAttempts) {
      await transitionTask(freshTask.id, 'FAILED', {
        error: `MAX_TASK_ATTEMPTS (${freshTask.maxAttempts}) excedido — estado preservado para diagnóstico`,
      })
      await emitEvent({
        type: 'limits.reached',
        projectId: req.projectId,
        taskId: freshTask.id,
        message: `MAX_TASK_ATTEMPTS (${freshTask.maxAttempts}) excedido para "${freshTask.title}" — tarefa interrompida com diagnóstico`,
      })
      continue
    }

    const exec = await executeTask(req, { ...freshTask, agentRole: freshTask.agentRole } as never, totalDeadline, reviewCycle, tokens, detector)

    // Cooldown honesto: se falhou por rate limit, pausa antes de retentar
    if (exec.status !== 'COMPLETED' && /RATE_LIMIT|429|Too many requests/i.test(exec.result)) {
      await emitEvent({
        type: 'limits.reached',
        projectId: req.projectId,
        taskId: freshTask.id,
        message: 'Rate limit do provedor LLM — aguardando 60s antes de nova tentativa',
      })
      await new Promise((r) => setTimeout(r, 60_000))
    }

    if (exec.status === 'COMPLETED') {
      await transitionTask(freshTask.id, 'COMPLETED', { result: { output: exec.result.slice(0, 4000), review: exec.review } as object, error: null })
      evidence.push(`✔ ${freshTask.title}: ${exec.result.slice(0, 200)}`)
      await updateProjectMemory(req.projectId, {
        completedTaskSummaries: [
          { taskId: freshTask.id, title: freshTask.title, summary: exec.result.slice(0, 300) },
        ],
      })
    } else {
      // CREATE_FIX_TASK → volta para IMPLEMENT (nova tentativa)
      // A descrição é RECONSTRUÍDA (não acumulada) — acumular correções
      // antigas envenena o agente com searchText obsoletos
      const fixInstructions = buildFixInstructions(exec)
      const baseDescription = extractBaseDescription(freshTask.description)
      await db.task.update({
        where: { id: freshTask.id },
        data: {
          status: 'PENDING',
          error: `Tentativa ${freshTask.attempts}: ${exec.status}`,
          description: (baseDescription + `\n\n[CORREÇÃO — tentativa ${freshTask.attempts + 1}]\n${fixInstructions}`).slice(0, 4000),
        },
      })
      await emitEvent({
        type: 'fix.created',
        projectId: req.projectId,
        taskId: freshTask.id,
        message: `Correção agendada para: ${freshTask.title} (${exec.status})`,
        data: { fix: fixInstructions.slice(0, 500) },
      })
      if (exec.status === 'REPEATED_FAILURE') {
        detector.record('pipeline', {}, exec.result)
        if (detector.isRepeating()) {
          evidence.push(`REPEATED_FAILURE no nível do pipeline — parando: ${detector.report()}`)
          break
        }
      }
    }
  }

  // 3) VALIDAÇÃO FINAL (progresso + testes finais)
  // Reconciliação: nenhuma tarefa pode permanecer RUNNING após o fim do loop
  // (run encerrado — por conclusão, deadline ou falha estrutural)
  const orphan = await db.task.updateMany({
    where: { projectId: req.projectId, status: 'RUNNING' },
    data: { status: 'FAILED', error: 'Execução interrompida antes do fim do run (reconciliação final)' },
  }).catch(() => null)
  if (orphan?.count) {
    evidence.push(`${orphan.count} tarefa(s) em execução órfã(s) encerrada(s) na reconciliação final`)
  }

  const progress = await projectProgress(req.projectId)
  const finalStatus: PipelineSummary['status'] =
    progress.percent === 100 ? 'COMPLETED' : progress.completed > 0 ? 'PARTIAL' : 'FAILED'

  await db.project.update({
    where: { id: req.projectId },
    data: { status: finalStatus === 'COMPLETED' ? 'COMPLETED' : finalStatus === 'PARTIAL' ? 'REVIEW' : 'FAILED' },
  })

  await emitEvent({
    type: finalStatus === 'COMPLETED' ? 'pipeline.completed' : 'pipeline.failed',
    projectId: req.projectId,
    status: finalStatus,
    message: `Pipeline ${finalStatus}: ${progress.completed}/${progress.total} tarefas (${progress.percent}%) em ${((Date.now() - started) / 1000).toFixed(0)}s`,
    durationMs: Date.now() - started,
    data: { percent: progress.percent, tokens: tokens.in + tokens.out },
  })

  return {
    projectId: req.projectId,
    status: finalStatus,
    message:
      finalStatus === 'COMPLETED'
        ? `Projeto concluído: ${progress.total} tarefas, ${tokens.in + tokens.out} tokens`
        : `Pipeline terminou ${finalStatus}: ${progress.completed}/${progress.total} tarefas`,
    progress,
    tokens,
    tasksCompleted: progress.completed,
    tasksFailed: progress.byStatus.FAILED ?? 0,
    reviewCycles: reviewCycle.count,
    evidence,
  }
}

function buildFixInstructions(exec: TaskExecution): string {
  const parts = [
    'IMPORTANTE: PRIMEIRO execute read_file no arquivo que precisa corrigir — o conteúdo atual pode ser DIFERENTE do que você lembra (foi modificado em tentativas anteriores). Use o conteúdo REAL lido para montar searchText/replaceText EXATOS.',
    `Status da tentativa anterior: ${exec.status}`,
  ]
  parts.push(`Resultado/erro reportado:\n${exec.result.slice(0, 1200)}`)
  if (exec.review?.issues?.length) {
    parts.push(`Issues do Review Agent:\n${JSON.stringify(exec.review.issues.slice(0, 4), null, 1).slice(0, 1200)}`)
    parts.push('Corrija CADA issue listada. Mude de estratégia se a anterior falhou.')
  }
  if (exec.status === 'REPEATED_FAILURE') {
    parts.push('ATENÇÃO: a mesma edição falhou repetidas vezes (trecho não encontrado). O arquivo MUDOU. Leia o arquivo atual e edite por trechos que EXISTEM no conteúdo lido, ou reescreva o arquivo via content completo.')
  }
  return parts.join('\n\n')
}

/** Extrai a descrição ORIGINAL da tarefa (remove blocos de correção acumulados). */
function extractBaseDescription(description: string): string {
  const idx = description.indexOf('\n\n[CORREÇÃO')
  return idx === -1 ? description : description.slice(0, idx)
}
