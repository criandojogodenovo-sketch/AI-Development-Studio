import { workspaceProvider } from '@/lib/studio/workspace/db-provider'
import { guard, domainError } from '@/lib/studio/workspace/guards'

export const dynamic = 'force-dynamic'

/**
 * GET /api/workspace/snapshot?project= — lista snapshots.
 * POST /api/workspace/snapshot { project, label, reason } — cria snapshot.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const g = await guard(req, url.searchParams.get('project') ?? '')
  if (g.status) return Response.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })
  const ctx = g.ctx!

  const snapshots = await workspaceProvider.listSnapshots(ctx.projectId)
  return Response.json({ snapshots })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const g = await guard(req, String(body.project ?? ''))
  if (g.status) return Response.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })
  const ctx = g.ctx!

  const label = String(body.label ?? '').trim() || `snapshot ${new Date().toISOString().slice(0, 19)}`
  const reason = ['manual', 'poskli', 'pre-execution', 'pre-fix'].includes(String(body.reason)) ? String(body.reason) : 'manual'

  try {
    const snap = await workspaceProvider.snapshot(ctx.projectId, label, reason)
    return Response.json({ ok: true, ...snap }, { status: 201 })
  } catch (e) {
    return domainError(e)
  }
}
