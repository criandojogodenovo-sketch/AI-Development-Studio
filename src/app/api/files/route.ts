import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { safeResolve } from '@/lib/studio/security/path'
import { STUDIO_CONFIG } from '@/lib/studio/config'
import fs from 'fs/promises'
import path from 'path'

export const dynamic = 'force-dynamic'

/**
 * GET /api/files?project=<id>&path=<rel>  — lê arquivo (painel EDITOR)
 * POST /api/files { project, path, content } — grava arquivo (editor manual)
 */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const url = new URL(req.url)
  const projectId = url.searchParams.get('project') ?? ''
  const filePath = url.searchParams.get('path') ?? ''

  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  try {
    const abs = safeResolve(project.rootPath, filePath || '.')
    const st = await fs.stat(abs)
    if (st.isDirectory()) return NextResponse.json({ error: 'É diretório' }, { status: 400 })
    if (st.size > STUDIO_CONFIG.files.maxFileReadBytes) {
      return NextResponse.json({ error: 'ARQUIVO_GRANDE' }, { status: 413 })
    }
    const ext = path.extname(abs).toLowerCase()
    if (STUDIO_CONFIG.files.blockedExtensions.includes(ext)) {
      return NextResponse.json({ error: 'EXTENSÃO_BLOQUEADA' }, { status: 403 })
    }
    const content = await fs.readFile(abs, 'utf8')
    return NextResponse.json({ path: filePath, content, size: st.size })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 })
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
    const abs = safeResolve(project.rootPath, filePath)
    // valida extensão via reuso da validação de tools
    const { validateFilePath } = await import('@/lib/studio/security/path')
    validateFilePath(abs)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
    await db.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } })
    return NextResponse.json({ ok: true, path: filePath, bytes: Buffer.byteLength(content) })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
