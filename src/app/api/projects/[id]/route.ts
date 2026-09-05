import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { deleteWorkspace } from '@/lib/studio/projects/workspace'
import { workspaceProvider } from '@/lib/studio/workspace/db-provider'
import { projectProgress } from '@/lib/studio/orchestrator/task-graph'
import { readProjectMemory } from '@/lib/studio/context/context-manager'

export const dynamic = 'force-dynamic'

/** GET /api/projects/:id — detalhe + tasks + arquivos + memória. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })
  const { id } = await params

  const project = await db.project.findFirst({
    where: { id, userId: user.id }, // ISOLAMENTO: só o dono vê
    include: { settings: true },
  })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  const progress = await projectProgress(id)
  // Árvore PERSISTENTE (database — fonte da verdade)
  const tree = await workspaceProvider.tree(id, { maxEntries: 500 }).catch(() => [])
  const memory = await readProjectMemory(id)
  const runs = await db.agentRun.findMany({
    where: { projectId: id },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: {
      id: true, agentId: true, model: true, runType: true, status: true,
      steps: true, tokensIn: true, tokensOut: true, durationMs: true, startedAt: true,
    },
  })

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      type: project.type,
      status: project.status,
      approvalMode: project.settings?.approvalMode ?? 'ASSISTED',
      limits: {
        maxAgentSteps: project.settings?.maxAgentSteps,
        maxTaskAttempts: project.settings?.maxTaskAttempts,
        maxReviewCycles: project.settings?.maxReviewCycles,
      },
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    progress,
    files: tree,
    memory,
    runs,
  })
}

/** DELETE /api/projects/:id — remove projeto + workspace (ação crítica). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })
  const { id } = await params

  const project = await db.project.findFirst({ where: { id, userId: user.id }, include: { settings: true } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  // Ação crítica: em modo MANUAL exige confirmação explícita no body
  const confirm = new URL(req.url).searchParams.get('confirm')
  if (project.settings?.approvalMode === 'MANUAL' && confirm !== 'true') {
    return NextResponse.json({ error: 'CONFIRMAÇÃO_NECESSÁRIA', requiresConfirmation: true }, { status: 409 })
  }

  await deleteWorkspace(id).catch(() => {})
  await db.workspaceFile.deleteMany({ where: { projectId: id } }).catch(() => {})
  await db.workspaceSnapshot.deleteMany({ where: { projectId: id } }).catch(() => {})
  await db.execution.deleteMany({ where: { projectId: id } }).catch(() => {})
  await db.poskliRun.deleteMany({ where: { projectId: id } }).catch(() => {})
  await db.project.delete({ where: { id } }) // cascade: tasks, runs, tool_calls, settings
  return NextResponse.json({ ok: true })
}
