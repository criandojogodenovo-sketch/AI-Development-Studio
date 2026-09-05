// ============================================================
// ORCHESTRATOR / TASK GRAPH — Grafo de tarefas
// Uma tarefa só começa quando suas dependências estão
// COMPLETED. Estados: PENDING RUNNING BLOCKED FAILED
// REVIEWING COMPLETED CANCELLED.
// ============================================================

import { db } from '@/lib/db'
import { emitEvent } from '../events/bus'

export const TASK_STATUSES = ['PENDING', 'RUNNING', 'BLOCKED', 'FAILED', 'REVIEWING', 'COMPLETED', 'CANCELLED'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export interface PlannedTask {
  title: string
  description: string
  agentRole: string
  priority: string
  dependsOn: number[] // índices 0-based
}

/** Cria tarefas do plano no banco (grafo).
 *  dependsOn vem com ÍNDICES (0-based) do plano — são convertidos
 *  para IDs reais das tarefas criadas (readyTasks compara com IDs). */
export async function createTasksFromPlan(
  projectId: string,
  plan: { tasks: PlannedTask[] }
): Promise<string[]> {
  const ids: string[] = []
  const validRoles = new Set(['coding', 'testing', 'review', 'github'])
  const validPriorities = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])

  const planTasks = plan.tasks.slice(0, 20)
  // 1) cria todas as tarefas (dependencies vazias por ora)
  for (const t of planTasks) {
    const task = await db.task.create({
      data: {
        projectId,
        order: ids.length,
        title: String(t.title).slice(0, 200),
        description: String(t.description).slice(0, 4000),
        status: 'PENDING',
        priority: validPriorities.has(t.priority) ? t.priority : 'MEDIUM',
        agentRole: validRoles.has(t.agentRole) ? t.agentRole : 'coding',
        dependencies: [] as unknown as object,
        input: {} as object,
        result: {} as object,
      },
    })
    ids.push(task.id)
  }
  // 2) resolve dependsOn (índices → IDs reais)
  for (let i = 0; i < planTasks.length; i++) {
    const raw = planTasks[i].dependsOn
    const dependsOn = Array.isArray(raw)
      ? raw
          .map((idx) => (Number.isInteger(idx) && idx >= 0 && idx < ids.length ? ids[Number(idx)] : null))
          .filter((x): x is string => Boolean(x) && x !== ids[i])
      : []
    if (dependsOn.length > 0) {
      await db.task.update({ where: { id: ids[i] }, data: { dependencies: dependsOn as unknown as object } })
    }
  }
  return ids
}

/** Tarefas prontas para execução (deps concluídas). */
export async function readyTasks(projectId: string): Promise<Array<{ id: string; dependencies: string[] } & Record<string, unknown>>> {
  const tasks = await db.task.findMany({
    where: { projectId, status: { in: ['PENDING', 'BLOCKED'] } },
    orderBy: [{ order: 'asc' }],
  })
  const completed = new Set(
    (await db.task.findMany({ where: { projectId, status: 'COMPLETED' }, select: { id: true } })).map((t) => t.id)
  )
  const ready: Array<{ id: string; dependencies: string[] } & Record<string, unknown>> = []
  for (const t of tasks) {
    const deps = (t.dependencies as unknown as string[]) ?? []
    const unmet = deps.filter((d) => !completed.has(d))
    if (unmet.length === 0) {
      ready.push({ ...t, dependencies: deps })
    } else {
      if (t.status !== 'BLOCKED') {
        await db.task.update({ where: { id: t.id }, data: { status: 'BLOCKED' } })
      }
    }
  }
  // Ordem de prioridade
  const prio: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
  return ready.sort((a, b) => prio[a.priority as string] - prio[b.priority as string])
}

/** Progresso consolidado do projeto (para UI e para o pipeline).
 *  Tarefas CANCELLED (grafos anteriores encerrados por novo pedido) ficam
 *  fora do progresso e da lista — o histórico vive em runs + eventos. */
export async function projectProgress(projectId: string) {
  const allTasks = await db.task.findMany({ where: { projectId }, orderBy: { order: 'asc' } })
  const tasks = allTasks.filter((t) => t.status !== 'CANCELLED')
  const byStatus: Record<string, number> = {}
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
  const completed = byStatus.COMPLETED ?? 0
  const total = tasks.length
  return {
    total,
    completed,
    percent: total ? Math.round((completed / total) * 100) : 0,
    byStatus,
    tasks: tasks.map((t) => {
      const resultJson = t.result as { output?: unknown } | null
      return {
        id: t.id,
        order: t.order,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        agentRole: t.agentRole,
        attempts: t.attempts,
        maxAttempts: t.maxAttempts,
        dependencies: (t.dependencies as unknown as string[]) ?? [],
        error: t.error,
        // Saída final do agente (resumo/evidências) — renderizada como Markdown na UI
        result:
          resultJson && typeof resultJson === 'object' && typeof resultJson.output === 'string'
            ? resultJson.output.slice(0, 4000)
            : undefined,
      }
    }),
  }
}

export async function transitionTask(taskId: string, status: TaskStatus, extra?: Record<string, unknown>) {
  await db.task.update({ where: { id: taskId }, data: { status, ...extra } })
  await emitEvent({
    type: status === 'COMPLETED' ? 'task.completed' : status === 'FAILED' ? 'task.failed' : 'task.started',
    taskId,
    status,
    message: `Tarefa ${taskId.slice(-6)} → ${status}`,
  })
}
