import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { STUDIO_CONFIG } from '@/lib/studio/config'
import { workspaceProvider } from '@/lib/studio/workspace/db-provider'

export const dynamic = 'force-dynamic'

/**
 * GET /api/files?project=<id>&path=<rel>  — lê arquivo (painel EDITOR)
 * POST /api/files { project, path, content } — grava arquivo (editor manual)
 *
 * PERSISTENTE: lê/grava no DATABASE (fonte da verdade) — sobrevive a
 * instâncias serverless efêmeras. O disco é só materialização de execução.
 */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const url = new URL(req.url)
  const projectId = url.searchParams.get('project') ?? ''
  const filePath = url.searchParams.get('path') ?? ''

  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })
  if (!filePath) return NextResponse.json({ error: 'PATH_OBRIGATÓRIO' }, { status: 400 })

  try {
    const file = await workspaceProvider.readFile(projectId, filePath)
    if (!file) return NextResponse.json({ error: 'ARQUIVO_NÃO_ENCONTRADO' }, { status: 404 })
    if (file.encoding === 'base64') {
      return NextResponse.json({ error: 'ARQUIVO_BINÁRIO (não editável como texto)' }, { status: 415 })
    }
    return NextResponse.json({ path: file.path, content: file.content, size: file.size })
  } catch (e) {
    const msg = (e as Error).message
    const status = msg.includes('GRANDE') ? 413 : msg.includes('BLOCKED') ? 403 : 404
    return NextResponse.json({ error: msg }, { status })
  }
}

export async function POST(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const projectId = String(body.project ?? '')
  const filePath = String(body.path ?? '')
  const content = String(body.content ?? '')

  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })
  if (!filePath) return NextResponse.json({ error: 'PATH_OBRIGATÓRIO' }, { status: 400 })
  if (Buffer.byteLength(content) > STUDIO_CONFIG.files.maxFileSize) {
    return NextResponse.json({ error: 'ARQUIVO_GRANDE' }, { status: 413 })
  }

  try {
    const { bytes } = await workspaceProvider.writeFile(projectId, filePath, content)
    await db.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } })
    return NextResponse.json({ ok: true, path: filePath, bytes })
  } catch (e) {
    const msg = (e as Error).message
    const status = msg.includes('GRANDE') ? 413 : msg.includes('BLOCKED') ? 403 : 400
    return NextResponse.json({ error: msg }, { status })
  }
}
