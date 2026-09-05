import { NextResponse } from 'next/server'
import { modelRouter } from '@/lib/studio/models/router'
import { STUDIO_CONFIG } from '@/lib/studio/config'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'

export const dynamic = 'force-dynamic'

/** GET /api/models — visão geral de modelos e uso (economia de tokens). */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const overview = await modelRouter.overview()
  const history = await db.modelUsage.findMany({ orderBy: { day: 'desc' }, take: 14 })

  return NextResponse.json({
    ...overview,
    history,
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
