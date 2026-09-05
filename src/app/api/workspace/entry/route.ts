import { workspaceProvider } from '@/lib/studio/workspace/db-provider'
import { guard, domainError } from '@/lib/studio/workspace/guards'

export const dynamic = 'force-dynamic'

/** DELETE /api/workspace/entry?project=&path= — remove arquivo/pasta (recursivo). */
export async function DELETE(req: Request) {
  const url = new URL(req.url)
  const g = await guard(req, url.searchParams.get('project') ?? '')
  if (g.status) return Response.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })
  const ctx = g.ctx!

  const path = url.searchParams.get('path') ?? ''
  if (!path) return Response.json({ error: 'PATH_OBRIGATÓRIO' }, { status: 400 })

  try {
    const { removed } = await workspaceProvider.deleteEntry(ctx.projectId, path)
    return Response.json({ ok: true, path, removed })
  } catch (e) {
    return domainError(e)
  }
}
