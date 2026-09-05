import { workspaceProvider } from '@/lib/studio/workspace/db-provider'
import { guard, domainError } from '@/lib/studio/workspace/guards'

export const dynamic = 'force-dynamic'

/** POST /api/workspace/dir { project, path } — cria diretório. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const g = await guard(req, String(body.project ?? ''))
  if (g.status) return Response.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })
  const ctx = g.ctx!

  const path = String(body.path ?? '')
  if (!path) return Response.json({ error: 'PATH_OBRIGATÓRIO' }, { status: 400 })

  try {
    await workspaceProvider.createDir(ctx.projectId, path)
    return Response.json({ ok: true, path, type: 'dir' })
  } catch (e) {
    return domainError(e)
  }
}
