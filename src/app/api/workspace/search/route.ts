import { workspaceProvider } from '@/lib/studio/workspace/db-provider'
import { guard, domainError } from '@/lib/studio/workspace/guards'

export const dynamic = 'force-dynamic'

/** GET /api/workspace/search?project=&q= — busca textual nos arquivos. */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const g = await guard(req, url.searchParams.get('project') ?? '')
  if (g.status) return Response.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })
  const ctx = g.ctx!

  const q = url.searchParams.get('q') ?? ''
  try {
    const results = await workspaceProvider.search(ctx.projectId, q)
    return Response.json({ results, query: q })
  } catch (e) {
    return domainError(e)
  }
}
