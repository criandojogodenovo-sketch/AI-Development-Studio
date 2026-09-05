import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { validateEnvironment, environmentSummary } from '@/lib/studio/security/env-validator'
import { agentSummaries } from '@/lib/studio/agents/definitions'
import { listTools } from '@/lib/studio/tools'

export const dynamic = 'force-dynamic'

/**
 * GET /api/diagnostics — área técnica (Diagnostics view).
 * Ambiente, agentes, ferramentas, execuções agregadas, eventos de erro.
 * Nenhum secret é exposto (summary já é sanitizado).
 */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const validation = validateEnvironment(process.env.NODE_ENV)
  const summary = environmentSummary() as Record<string, unknown>

  const [execStats, errorEvents] = await Promise.all([
    db.execution.groupBy({
      by: ['status'],
      _count: { status: true },
      _avg: { durationMs: true },
    }).catch(() => []),
    db.activityEvent.findMany({
      where: { type: { in: ['agent.failed', 'pipeline.failed', 'tool.denied'] } },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { type: true, message: true, createdAt: true, projectId: true },
    }).catch(() => []),
  ])

  return NextResponse.json({
    validation: summary,
    validationIssues: [...validation.errors, ...validation.warnings].slice(0, 5).map((i) => ({ varName: i.varName, level: i.level })),
    agents: agentSummaries().map((a) => ({ id: a.id, name: a.name, enabled: a.enabled, future: a.future })),
    tools: listTools().map((t) => ({ name: t.name, category: t.category })),
    executions: execStats.map((s: { status: string; _count: { status: number }; _avg: { durationMs: number | null } }) => ({
      status: s.status,
      count: s._count.status,
      avgDurationMs: s._avg.durationMs ? Math.round(s._avg.durationMs) : null,
    })),
    recentErrors: errorEvents.map((e: { type: string; message: string; createdAt: Date }) => ({
      type: e.type,
      message: e.message.slice(0, 200),
      at: e.createdAt,
    })),
  })
}
