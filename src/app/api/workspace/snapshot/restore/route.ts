import { workspaceProvider } from '@/lib/studio/workspace/db-provider'
import { guard, domainError } from '@/lib/studio/workspace/guards'

export const dynamic = 'force-dynamic'

/** POST /api/workspace/snapshot/restore { project, snapshotId } — restaura versão. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const g = await guard(req, String(body.project ?? ''))
  if (g.status) return Response.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })
  const ctx = g.ctx!

  const snapshotId = String(body.snapshotId ?? '')
  if (!snapshotId) return Response.json({ error: 'SNAPSHOT_ID_OBRIGATÓRIO' }, { status: 400 })

  try {
    const { restored } = await workspaceProvider.restoreSnapshot(ctx.projectId, snapshotId)
    return Response.json({ ok: true, snapshotId, restored })
  } catch (e) {
    return domainError(e)
  }
}
