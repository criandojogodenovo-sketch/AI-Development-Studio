// ============================================================
// EVENTS — Sistema de eventos (observabilidade)
// Cada evento é: (1) persistido no DB (ActivityEvent),
// (2) retransmitido ao mini-service socket.io (tempo real na UI).
// NUNCA loga secrets, tokens, api keys.
// ============================================================

import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'

export type EventType =
  | 'project.created'
  | 'project.status'
  | 'pipeline.started'
  | 'pipeline.completed'
  | 'pipeline.failed'
  | 'agent.started'
  | 'agent.step'
  | 'agent.completed'
  | 'agent.failed'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.reviewing'
  | 'tool.called'
  | 'tool.completed'
  | 'tool.denied'
  | 'test.started'
  | 'test.passed'
  | 'test.failed'
  | 'review.started'
  | 'review.approved'
  | 'review.changes_requested'
  | 'review.failed'
  | 'fix.created'
  | 'repeated_failure.detected'
  | 'limits.reached'
  | 'github.commit.created'
  | 'github.branch.created'
  | 'github.push.completed'
  | 'github.push.failed'
  | 'github.pr.created'
  | 'memory.updated'
  | 'approval.required'
  | (string & {})

export interface EventPayload {
  type: EventType
  projectId?: string
  taskId?: string
  runId?: string
  agent?: string
  tool?: string
  action?: string
  status?: string
  message: string
  data?: Record<string, unknown>
  durationMs?: number
}

// Sanitização: remove qualquer valor que pareça secret
const SECRET_PATTERNS = [/api[_-]?key/i, /token/i, /password/i, /secret/i, /authorization/i]

function sanitize(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_PATTERNS.some((p) => p.test(k))) {
      clean[k] = '[REDACTED]'
      continue
    }
    if (typeof v === 'string' && v.length > STUDIO_CONFIG.events.maxEventDataChars) {
      clean[k] = v.slice(0, STUDIO_CONFIG.events.maxEventDataChars) + '...[truncado]'
    } else if (typeof v === 'string' && /sk-[a-zA-Z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}/.test(v)) {
      clean[k] = '[POSSÍVEL SECRET REDIGIDO]'
    } else {
      clean[k] = v
    }
  }
  return clean
}

/** Emite evento: DB + retransmissão websocket (fire-and-forget). */
export async function emitEvent(payload: EventPayload): Promise<void> {
  const safeData = sanitize(payload.data)
  let created: { id: string; createdAt: Date } | null = null
  try {
    created = await db.activityEvent.create({
      data: {
        projectId: payload.projectId ?? null,
        taskId: payload.taskId ?? null,
        runId: payload.runId ?? null,
        type: payload.type,
        agent: payload.agent ?? null,
        tool: payload.tool ?? null,
        action: payload.action ?? null,
        status: payload.status ?? null,
        message: payload.message.slice(0, 2000),
        data: (safeData ?? {}) as object,
        durationMs: payload.durationMs ?? null,
      },
      select: { id: true, createdAt: true },
    })
  } catch (e) {
    console.error('[events] falha ao persistir evento:', (e as Error).message)
  }

  // Retransmissão ao mini-service de tempo real (não bloqueia o pipeline).
  // Inclui id/createdAt do row persistido para a UI deduplicar e exibir horário.
  try {
    await fetch(`http://localhost:${STUDIO_CONFIG.events.ingestPort}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        data: safeData,
        ...(created ? { id: created.id, createdAt: created.createdAt } : {}),
      }),
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    // mini-service pode não estar rodando; evento já está no DB
  }

  // Higiene (amostragem leve): eventos de auditoria > 30 dias são removidos
  // para a tabela não crescer indefinidamente. Best-effort, sem bloquear.
  if (Math.random() < 0.05) {
    db.activityEvent.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
    }).catch(() => {})
  }
}

/** Consulta eventos para a UI. */
export async function listEvents(opts: {
  projectId?: string
  type?: string
  take?: number
  cursor?: string
}) {
  const take = Math.min(opts.take ?? 50, 200)
  return db.activityEvent.findMany({
    where: {
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.type ? { type: opts.type } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  })
}
