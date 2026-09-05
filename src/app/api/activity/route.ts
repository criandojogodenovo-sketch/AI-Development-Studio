import { NextResponse } from 'next/server'
import { listEvents } from '@/lib/studio/events/bus'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'

export const dynamic = 'force-dynamic'

/** GET /api/activity?project=<id>&type=<tipo>&take=<n> — feed de eventos. */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const url = new URL(req.url)
  const projectId = url.searchParams.get('project') ?? undefined
  const type = url.searchParams.get('type') ?? undefined
  const take = Number(url.searchParams.get('take') ?? 50)

  // Isolamento: se projeto especificado, verifica posse
  if (projectId) {
    const owns = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
    if (!owns) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })
  }

  const events = await listEvents({ projectId, type, take })
  return NextResponse.json({
    events: events.map((e) => ({
      id: e.id,
      projectId: e.projectId,
      taskId: e.taskId,
      type: e.type,
      agent: e.agent,
      tool: e.tool,
      status: e.status,
      message: e.message,
      data: e.data,
      durationMs: e.durationMs,
      createdAt: e.createdAt,
    })),
  })
}
