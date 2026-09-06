import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { rateLimitApi, clientIp } from '@/lib/studio/security/rate-limit'
import { startPoskli, runPoskli, recoverStaleRun } from '@/lib/studio/poskli/orchestrator'
import { POSKLI_VERSIONS } from '@/lib/studio/models/chain'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/poskli/:id/fix { message, poskliVersion? } — "Pedir
 * correção ao Poskli": cria um NOVO run focado em corrigir (usa o
 * contexto do run origem + mensagem de erro, ex: preview error).
 * poskliVersion: seletor de modelos da UI (body ou header
 * x-poskli-version); ausente → env POSKLI_VERSION.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const rl = rateLimitApi(clientIp(req) + ':poskli-fix')
  if (!rl.allowed) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 })

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const message = String(body.message ?? '').trim()
  const rawVersion =
    body.poskliVersion !== undefined && body.poskliVersion !== null
      ? String(body.poskliVersion).trim()
      : (req.headers.get('x-poskli-version') ?? '').trim()
  if (rawVersion && !(POSKLI_VERSIONS as readonly string[]).includes(rawVersion)) {
    return NextResponse.json(
      { error: `VERSAO_POSKLI_INVALIDA: "${rawVersion.slice(0, 24)}" — válidas: ${POSKLI_VERSIONS.join(', ')}` },
      { status: 400 }
    )
  }
  const poskliVersion = rawVersion || undefined

  const run = await db.poskliRun.findUnique({ where: { id } })
  if (!run) return NextResponse.json({ error: 'RUN_NÃO_ENCONTRADO' }, { status: 404 })
  const project = await db.project.findFirst({ where: { id: run.projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  const request = message.length >= 5
    ? `Corrija o problema relatado: ${message.slice(0, 600)}`
    : `Corrija os problemas do run anterior (${run.state}${run.error ? `: ${run.error.slice(0, 200)}` : ''})`

  // evita empilhar correções sobre um run ativo
  const activeStates = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING']
  const active = await db.poskliRun.findFirst({
    where: { projectId: run.projectId, state: { in: activeStates } },
    orderBy: { startedAt: 'desc' },
  })
  if (active) {
    const lastActivity = Math.max(
      new Date(active.startedAt).getTime(),
      new Date(active.updatedAt).getTime()
    )
    if (Date.now() - lastActivity < 10 * 60 * 1000) {
      return NextResponse.json({ error: 'POSKLI_JÁ_ATIVO', runId: active.id }, { status: 409 })
    }
    await recoverStaleRun(active.id).catch(() => {})
  }

  const { runId } = await startPoskli({ projectId: run.projectId, userId: user.id, request, maxIterations: 2, poskliVersion })

  after(async () => {
    await runPoskli(runId, poskliVersion)
  })

  return NextResponse.json({ ok: true, runId, message: 'Correção Poskli iniciada' }, { status: 202 })
}
