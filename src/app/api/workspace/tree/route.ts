import { workspaceProvider } from '@/lib/studio/workspace/db-provider'
import { guard, domainError } from '@/lib/studio/workspace/guards'

export const dynamic = 'force-dynamic'

/** GET /api/workspace/tree?project=&max= — árvore persistida (DB). */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const g = await guard(req, url.searchParams.get('project') ?? '')
  if (g.status) return Response.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })
  const ctx = g.ctx!

  try {
    const tree = await workspaceProvider.tree(ctx.projectId, {
      maxEntries: Number(url.searchParams.get('max') ?? 500),
    })
    return Response.json({ tree })
  } catch (e) {
    return domainError(e)
  }
}
