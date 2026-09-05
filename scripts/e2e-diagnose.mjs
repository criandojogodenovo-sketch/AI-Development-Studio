// Diagnóstico do pipeline E2E — consulta eventos/runs/tasks no PostgreSQL
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  const project = await db.project.findFirst({ orderBy: { createdAt: 'desc' } })
  console.log(`Projeto: ${project?.name} (${project?.id}) — status ${project?.status}\n`)

  const tasks = await db.task.findMany({ where: { projectId: project.id }, orderBy: { order: 'asc' } })
  for (const t of tasks) {
    console.log(`#${t.order + 1} [${t.status}] ${t.title} — tentativa ${t.attempts}/${t.maxAttempts}`)
    if (t.error) console.log(`   erro: ${t.error.slice(0, 220)}`)
  }

  console.log('\n--- RUNS recentes ---')
  const runs = await db.agentRun.findMany({ where: { projectId: project.id }, orderBy: { startedAt: 'desc' }, take: 8 })
  for (const r of runs) {
    console.log(`${r.agentId} (${r.model}) ${r.runType} ${r.status} steps=${r.steps} tokens=${r.tokensIn}/${r.tokensOut} ${(r.durationMs / 1000).toFixed(0)}s`)
    if (r.error) console.log(`   erro: ${r.error.slice(0, 260)}`)
  }

  console.log('\n--- Últimos eventos ---')
  const events = await db.activityEvent.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 18 })
  for (const e of events.reverse()) {
    console.log(`${e.type.padEnd(22)} ${e.status ?? ''} ${e.message.slice(0, 110)}`)
  }

  console.log('\n--- Uso de modelos (hoja) ---')
  const day = new Date().toISOString().slice(0, 10)
  const usage = await db.modelUsage.findMany({ where: { day } })
  for (const u of usage) console.log(`${u.model}: ${u.requests} req, ${u.totalTokens} tokens, ${u.errors} erros`)
}

main().catch((e) => console.error(e.message)).finally(() => db.$disconnect())
