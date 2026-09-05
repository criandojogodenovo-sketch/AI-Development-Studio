import { workspaceProvider } from '@/lib/studio/workspace/db-provider'
import { guard, domainError } from '@/lib/studio/workspace/guards'

export const dynamic = 'force-dynamic'

/** POST /api/workspace/rename { project, from, to } — renomeia/move arquivo ou pasta. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const g = await guard(req, String(body.project ?? ''))
  if (g.status) return Response.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })
  const ctx = g.ctx!

  const from = String(body.from ?? '')
  const to = String(body.to ?? '')
  if (!from || !to) return Response.json({ error: 'FROM_E_TO_OBRIGATÓRIOS' }, { status: 400 })

  try {
    const { moved } = await workspaceProvider.rename(ctx.projectId, from, to)
    return Response.json({ ok: true, from, to, moved })
  } catch (e) {
    return domainError(e)
  }
}
