import { NextResponse } from 'next/server'
import { modelRouter } from '@/lib/studio/models/router'
import { STUDIO_CONFIG } from '@/lib/studio/config'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { withPoskliVersion } from '@/lib/studio/models/version-context.ts'
import { POSKLI_VERSIONS } from '@/lib/studio/models/chain'

export const dynamic = 'force-dynamic'

/**
 * GET /api/models[?version=] — visão geral de modelos e uso (economia
 * de tokens). `version` (query ou header x-poskli-version) reflete o
 * SELETOR DE MODELOS da UI: o snapshot (chain + disponibilidade) é
 * calculado para a versão selecionada; ausente → env POSKLI_VERSION.
 */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const url = new URL(req.url)
  const version =
    (url.searchParams.get('version') ?? req.headers.get('x-poskli-version') ?? '').trim() || undefined
  if (version && !(POSKLI_VERSIONS as readonly string[]).includes(version)) {
    return NextResponse.json(
      { error: `VERSAO_POSKLI_INVALIDA: "${version.slice(0, 24)}" — válidas: ${POSKLI_VERSIONS.join(', ')}` },
      { status: 400 }
    )
  }

  const overview = await withPoskliVersion(version, () => modelRouter.overview())
  const history = await db.modelUsage.findMany({ orderBy: { day: 'desc' }, take: 14 })

  return NextResponse.json({
    ...overview,
    history,
    versions: { available: POSKLI_VERSIONS, selected: version ?? null },
    limits: {
      maxAgentSteps: STUDIO_CONFIG.limits.maxAgentSteps,
      maxTaskAttempts: STUDIO_CONFIG.limits.maxTaskAttempts,
      maxReviewCycles: STUDIO_CONFIG.limits.maxReviewCycles,
      maxToolCalls: STUDIO_CONFIG.limits.maxToolCalls,
      maxTotalExecutionMs: STUDIO_CONFIG.limits.maxTotalExecutionMs,
      repeatedFailureThreshold: STUDIO_CONFIG.limits.repeatedFailureThreshold,
    },
    deepseek: {
      enabled: STUDIO_CONFIG.models.enableDeepseek,
      maxDailyRequests: STUDIO_CONFIG.models.deepseekMaxDailyRequests,
      note: 'DeepSeek-V4-Flash desativado por padrão. Ative com ENABLE_DEEPSEEK=true (server-side).',
    },
  })
}
