import { NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { rateLimitAgentRun, rateLimitApi, clientIp } from '@/lib/studio/security/rate-limit'
import { startPoskli, runPoskli, recoverStaleRun } from '@/lib/studio/poskli/orchestrator'
import { POSKLI_VERSIONS, normalizeVersion } from '@/lib/studio/models/chain'
import { STUDIO_CONFIG } from '@/lib/studio/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Janela de run travado (stale): o HEARTBEAT do watchdog atualiza
 *  run.updatedAt a cada 15s enquanto o processo vive — logo >2 min
 *  sem update num estado ATIVO significa função serverless MORTA a
 *  meio do run (fix do congelamento em IMPLEMENTING: era 10 min).
 *  Runs recuperáveis são detetados TAMBÉM no GET (polling da UI),
 *  sem esperar o usuário criar um novo run. */
const STALE_RUN_MS = 2 * 60 * 1000

/** Recupera runs ativos e sem heartbeat (função morta) — usado pelo
 *  POST (antes de criar novo run) e pelo GET (polling da UI). */
async function recoverIfStale(
  active: { id: string; startedAt: Date; updatedAt: Date } | null
): Promise<boolean> {
  if (!active) return false
  const lastActivity = Math.max(
    new Date(active.startedAt).getTime(),
    new Date(active.updatedAt).getTime()
  )
  if (Date.now() - lastActivity < STALE_RUN_MS) return false
  // recuperação HONESTA: deriva estado conservador (interrompido ≠ concluído)
  await recoverStaleRun(active.id).catch(() => {})
  return true
}

/**
 * POST /api/poskli/run { project, request, poskliVersion? } — inicia o
 * ORQUESTRADOR POSKLI (resposta imediata 202; execução via after() —
 * sobrevive ao serverless dentro do maxDuration). Estados visíveis +
 * testes reais.
 *
 * poskliVersion: versão escolhida no SELETOR DE MODELOS da UI — também
 * aceita via header x-poskli-version. Ausente/inválido → env POSKLI_VERSION
 * (fallback padrão). Valor EXPLÍCITO inválido → 400 honesto (sem silêncio).
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
    // última atividade REAL (updatedAt muda a cada estágio/persistência —
    // antes usava startedAt duas vezes, bug que marcava runs vivos como travados)
    if (!(await recoverIfStale(active))) {
      return NextResponse.json({ error: 'POSKLI_JÁ_ATIVO neste projeto', runId: active.id }, { status: 409 })
    }
  }

  const { runId } = await startPoskli({
    projectId,
    userId: user.id,
    request,
    maxIterations: Number(body.maxIterations) || 3,
    poskliVersion,
  })

  after(async () => {
    await runPoskli(runId, poskliVersion)
  })

  return NextResponse.json({ ok: true, runId, message: 'Poskli iniciado — acompanhe os estágios no painel' }, { status: 202 })
}

/** GET /api/poskli/run?project= — sessões Poskli do projeto +
 *  catálogo de versões do seletor de modelos (versões válidas + default).
 *  AUTO-RECOVERY: o polling da UI deteta runs ativos sem heartbeat
 *  (função serverless morta) e recupera com estado honesto — o
 *  usuário vê "Falhou (interrompido)" em ≤2 min em vez de um run
 *  "Implementando" congelado para sempre. */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const url = new URL(req.url)
  const projectId = url.searchParams.get('project') ?? ''
  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  // auto-recovery no polling: run ativo sem heartbeat > 2 min = morto
  const activeStates = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING']
  const active = await db.poskliRun.findFirst({
    where: { projectId, state: { in: activeStates } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, startedAt: true, updatedAt: true },
  }).catch(() => null)
  if (active && Date.now() - Math.max(active.startedAt.getTime(), active.updatedAt.getTime()) >= STALE_RUN_MS) {
    after(async () => {
      await recoverStaleRun(active.id).catch(() => {})
    })
  }

  const runs = await db.poskliRun.findMany({
    where: { projectId },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: {
      id: true, request: true, state: true, iteration: true, maxIterations: true,
      testsPassed: true, previewOk: true, tokensIn: true, tokensOut: true,
      errorCode: true, outcomeReason: true,
      startedAt: true, finishedAt: true, updatedAt: true, error: true,
    },
  })
  return NextResponse.json({
    runs,
    poskliVersions: {
      versions: POSKLI_VERSIONS,
      default: normalizeVersion(STUDIO_CONFIG.router.poskliVersion),
    },
  })
}
