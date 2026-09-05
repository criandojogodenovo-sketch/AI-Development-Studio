import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/studio/security/auth'
import { rateLimitApi, clientIp } from '@/lib/studio/security/rate-limit'
import { runExecution, listExecutions } from '@/lib/studio/execution/engine'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /api/executions { project, command } — EXECUÇÃO REAL com
 * STREAMING (SSE sobre fetch): stdout/stderr chegam em tempo real.
 * Cancelamento: DELETE /api/executions/:id ou fechar o stream.
 *
 * GET /api/executions?project=&take= — histórico persistido.
 */
export async function POST(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const rl = rateLimitApi(clientIp(req) + ':terminal')
  if (!rl.allowed) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 })

  const body = await req.json().catch(() => ({}))
  const projectId = String(body.project ?? '')
  const command = String(body.command ?? '').trim()
  const timeoutMs = Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : undefined

  if (!command) return NextResponse.json({ error: 'COMANDO_VAZIO' }, { status: 400 })

  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const send = (e: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
        } catch {
          closed = true
        }
      }

      runExecution({
        projectId,
        command,
        userId: user.id,
        source: 'terminal',
        trigger: `user:${user.name}`,
        timeoutMs,
        onEvent: (ev) => send(ev),
        signal: req.signal, // cliente abandonou o terminal → mata o processo
      })
        .catch(async (e) => {
          send({ type: 'exit', status: 'FAILED', exitCode: 1, message: `ERRO_EXECUÇÃO: ${(e as Error).message}` })
        })
        .finally(() => {
          send({ type: 'end' })
          try { controller.close() } catch { /* já fechado */ }
          closed = true
        })
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  })
}

export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })

  const url = new URL(req.url)
  const projectId = url.searchParams.get('project') ?? ''
  const take = Number(url.searchParams.get('take') ?? 30)

  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } })
  if (!project) return NextResponse.json({ error: 'PROJETO_NÃO_ENCONTRADO' }, { status: 404 })

  const executions = await listExecutions(projectId, take)
  return NextResponse.json({ executions })
}
