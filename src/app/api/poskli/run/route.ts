import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { rateLimitAgentRun, rateLimitApi, clientIp } from '@/lib/studio/security/rate-limit'
import { startPoskli, runPoskli } from '@/lib/studio/poskli/orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/poskli/run { project, request } — inicia o ORQUESTRADOR
 * POSKLI (resposta imediata 202; execução via after() — sobrevive ao
 * serverless dentro do maxDuration). Estados visíveis + testes reais.
 */
export async function POST(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const rl = rateLimitAgentRun(clientIp(req), user.id)
  if (!rl.allowed) return NextResponse.json({ error: 'RATE_LIMIT_RUN (aguarde antes de novo run)' }, { status: 429 })

  const rlApi = rateLimitApi(clientIp(req) + ':poskli')
  if (!rlApi.allowed) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 })

  const body = await req.json().catch(() => ({}))
  const projectId = String(body.project ?? '')
  const request = String(body.request ?? '').trim()

  if (request.length < 5) {
    return NextResponse.json({ error: 'PEDIDO_INVÁLIDO (descreva o que deseja, mín 5 caracteres)' }, { status: 400 })
  }

  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  // um Poskli ativo por projeto (com recuperação de run travado > 10min)
  const activeStates = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING']
  const active = await db.poskliRun.findFirst({
    where: { projectId, state: { in: activeStates } },
    orderBy: { startedAt: 'desc' },
  })
  if (active) {
    const staleMs = 10 * 60 * 1000
    const lastActivity = Math.max(
      new Date(active.startedAt).getTime(),
      new Date(active.startedAt).getTime()
    )
    if (Date.now() - lastActivity < staleMs) {
      return NextResponse.json({ error: 'POSKLI_JÁ_ATIVO neste projeto', runId: active.id }, { status: 409 })
    }
    await db.poskliRun.update({
      where: { id: active.id },
      data: { state: 'FAILED', error: 'Run anterior travou (inatividade) — recuperado automaticamente', finishedAt: new Date() },
    }).catch(() => {})
  }

  const { runId } = await startPoskli({ projectId, userId: user.id, request, maxIterations: Number(body.maxIterations) || 3 })

  after(async () => {
    await runPoskli(runId)
  })

  return NextResponse.json({ ok: true, runId, message: 'Poskli iniciado — acompanhe os estágios no painel' }, { status: 202 })
}

/** GET /api/poskli/run?project= — sessões Poskli do projeto. */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const url = new URL(req.url)
  const projectId = url.searchParams.get('project') ?? ''
  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  const runs = await db.poskliRun.findMany({
    where: { projectId },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: {
      id: true, request: true, state: true, iteration: true, maxIterations: true,
      testsPassed: true, previewOk: true, tokensIn: true, tokensOut: true,
      startedAt: true, finishedAt: true, error: true,
    },
  })
  return NextResponse.json({ runs })
}
