import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { safeResolve } from '@/lib/studio/security/path'
import { mimeFor } from '@/lib/studio/projects/workspace'
import fs from 'fs/promises'

export const dynamic = 'force-dynamic'

/**
 * GET /api/preview/:projectId/<path> — serve arquivos do workspace
 * para PREVIEW real (jogo rodando em iframe). Isolado por posse.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string; path: string[] }> }
) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const { projectId, path: segments } = await params
  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  const relPath = (segments ?? []).join('/')
  // default: index.html
  const target = relPath || 'index.html'

  try {
    const abs = safeResolve(project.rootPath, target)
    const st = await fs.stat(abs)
    if (st.isDirectory()) {
      // tenta index.html dentro do diretório
      const index = await fs.stat(abs + '/index.html').catch(() => null)
      if (!index) return NextResponse.json({ error: 'SEM_INDEX_HTML' }, { status: 404 })
      const html = await fs.readFile(abs + '/index.html', 'utf8')
      return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    const contentType = mimeFor(target)
    if (contentType === 'application/octet-stream' && st.size > 1_000_000) {
      return NextResponse.json({ error: 'TIPO_NÃO_SERVIDO' }, { status: 415 })
    }
    const data = await fs.readFile(abs)
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'content-type': contentType,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (e) {
    return NextResponse.json({ error: `ARQUIVO_NÃO_ENCONTRADO: ${target}` }, { status: 404 })
  }
}
