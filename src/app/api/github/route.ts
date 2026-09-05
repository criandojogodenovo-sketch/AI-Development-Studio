import { NextResponse } from 'next/server'
import { githubStatus } from '@/lib/studio/tools/github-tools'
import { getRepositoryTool } from '@/lib/studio/tools/github-tools'
import { getSessionUser } from '@/lib/studio/security/auth'

export const dynamic = 'force-dynamic'

/** GET /api/github — status da integração (nunca expõe token). */
export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const url = new URL(req.url)
  const repo = url.searchParams.get('repo')
  if (repo) {
    const res = await getRepositoryTool.execute({ repo }, {
      projectId: '-', workspaceRoot: '-', runId: '-', agentId: 'api', permissions: ['github:read'],
    })
    return NextResponse.json({ repo: { ok: res.ok, info: res.output } })
  }

  return NextResponse.json({
    status: githubStatus(),
    workflow: {
      branches: 'agent/<task> — nunca push direto em main',
      flow: ['git_create_branch', 'git_commit', 'testes', 'review', 'create_pull_request', 'merge'],
    },
    setup: 'Defina GITHUB_TOKEN no .env (server-side) para push/PR reais.',
  })
}
