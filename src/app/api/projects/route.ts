import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { rateLimitApi, clientIp } from '@/lib/studio/security/rate-limit'
import { createWorkspace, newProjectId, deleteWorkspace } from '@/lib/studio/projects/workspace'
import { TEMPLATES, templateSummaries } from '@/lib/studio/projects/templates'
import { emitEvent } from '@/lib/studio/events/bus'
import { projectProgress } from '@/lib/studio/orchestrator/task-graph'

export const dynamic = 'force-dynamic'

/** GET /api/projects — lista projetos do usuário autenticado. */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const projects = await db.project.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    include: { settings: true },
  })

  const withProgress = await Promise.all(
    projects.map(async (p) => {
      const progress = await projectProgress(p.id).catch(() => ({ total: 0, completed: 0, percent: 0 }))
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        type: p.type,
        status: p.status,
        approvalMode: p.settings?.approvalMode ?? 'ASSISTED',
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        tasksTotal: progress.total,
        tasksCompleted: progress.completed,
        percent: progress.percent,
      }
    })
  )

  return NextResponse.json({ projects: withProgress, templates: templateSummaries() })
}

/** POST /api/projects — cria projeto com template real. */
export async function POST(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const rl = rateLimitApi(clientIp(req) + ':create')
  if (!rl.allowed) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 })

  const body = await req.json().catch(() => ({}))
  const name = String(body.name ?? '').trim()
  const type = String(body.type ?? 'EMPTY_PROJECT')
  const description = String(body.description ?? '').trim()

  if (name.length < 2) return NextResponse.json({ error: 'NOME_INVÁLIDO (mín 2)' }, { status: 400 })
  if (!TEMPLATES[type]) return NextResponse.json({ error: 'TEMPLATE_INVÁLIDO' }, { status: 400 })

  const projectId = newProjectId()
  try {
    const { rootPath, fileCount } = await createWorkspace(projectId, name, type, description || `Projeto ${type}`)
    const project = await db.project.create({
      data: {
        id: projectId,
        userId: user.id,
        name,
        description: description || TEMPLATES[type].description,
        type,
        rootPath,
        memory: {} as object,
        settings: {
          create: {
            approvalMode: ['MANUAL', 'ASSISTED', 'AUTONOMOUS'].includes(body.approvalMode)
              ? body.approvalMode
              : 'ASSISTED',
          },
        },
      },
    })
    await emitEvent({
      type: 'project.created',
      projectId,
      message: `Projeto criado: ${name} (${TEMPLATES[type]?.label ?? type}) com ${fileCount} arquivos`,
      data: { type, fileCount },
    })
    return NextResponse.json({ project: { id: project.id, name: project.name, type: project.type } }, { status: 201 })
  } catch (e) {
    await deleteWorkspace(projectId).catch(() => {})
    return NextResponse.json({ error: `FALHA_CRIAÇÃO: ${(e as Error).message}` }, { status: 500 })
  }
}
