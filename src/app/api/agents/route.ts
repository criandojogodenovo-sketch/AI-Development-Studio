import { NextResponse } from 'next/server'
import { agentSummaries } from '@/lib/studio/agents/definitions'
import { listTools } from '@/lib/studio/tools'
import { toolToSchema } from '@/lib/studio/tools/types'
import { getSessionUser } from '@/lib/studio/security/auth'

export const dynamic = 'force-dynamic'

/** GET /api/agents — registro de agentes + catálogo de tools (sem secrets). */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })
  return NextResponse.json({
    agents: agentSummaries(),
    tools: listTools().map((t) => ({
      ...toolToSchema(t),
      category: t.category,
      permissions: t.permissions,
    })),
  })
}
