import { workspaceProvider } from '@/lib/studio/workspace/db-provider'
import { guard, domainError } from '@/lib/studio/workspace/guards'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/workspace/file?project=&path= — lê arquivo (DB).
 * POST /api/workspace/file { project, path, content } — cria/atualiza (DB+disco).
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const g = await guard(req, url.searchParams.get('project') ?? '')
  if (g.status) return Response.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })
  const ctx = g.ctx!
  const path = url.searchParams.get('path') ?? ''

  try {
    const file = await workspaceProvider.readFile(ctx.projectId, path)
    if (!file) return Response.json({ error: 'ARQUIVO_NÃO_ENCONTRADO' }, { status: 404 })
    if (file.encoding === 'base64') {
      return Response.json({ error: 'ARQUIVO_BINÁRIO', path: file.path, size: file.size }, { status: 415 })
    }
    return Response.json({ path: file.path, content: file.content, size: file.size, updatedAt: 'persistido' })
  } catch (e) {
    return domainError(e)
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const g = await guard(req, String(body.project ?? ''))
  if (g.status) return Response.json({ error: g.status === 401 ? 'NÃO_AUTENTICADO' : 'PROJETO_NÃO_ENCONTRADO' }, { status: g.status })
  const ctx = g.ctx!

  const path = String(body.path ?? '')
  const content = String(body.content ?? '')
  if (!path) return Response.json({ error: 'PATH_OBRIGATÓRIO' }, { status: 400 })

  try {
    const { bytes } = await workspaceProvider.writeFile(ctx.projectId, path, content)
    await db.project.update({ where: { id: ctx.projectId }, data: { updatedAt: new Date() } }).catch(() => {})
    return Response.json({ ok: true, path, bytes })
  } catch (e) {
    return domainError(e)
  }
}
