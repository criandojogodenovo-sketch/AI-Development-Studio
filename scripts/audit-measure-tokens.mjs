// ============================================================
// AUDITORIA — medição REAL de tokens/tempo/tool-calls por run
// Lê o Postgres local (:5433) com os runs reais do Poskli.
// Uso: node /home/z/my-project/scripts/audit/measure-tokens.mjs
// (rodar de dentro de /home/z/my-project/ai-dev-studio p/ prisma)
// ============================================================
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const fmt = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`)

console.log('================ POSKLI RUNS (todos) ================')
const runs = await db.poskliRun.findMany({
  orderBy: { startedAt: 'asc' },
  select: {
    id: true, request: true, state: true, startedAt: true, finishedAt: true,
    tokensIn: true, tokensOut: true, iteration: true, maxIterations: true,
    outcomeReason: true, errorCode: true,
    testRecords: true, corrections: true, stages: true, lastExecId: true,
  },
})

for (const r of runs) {
  const tests = Array.isArray(r.testRecords) ? r.testRecords.length : 0
  const corrections = Array.isArray(r.corrections) ? r.corrections.length : 0
  const stages = Array.isArray(r.stages) ? r.stages : []
  const wall = r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null
  const stageSummary = stages.map((s) => {
    const st = s
    const dur = st.durationMs ? `${(st.durationMs / 1000).toFixed(0)}s` : '?'
    const tok = st.tokensIn || st.tokensOut ? ` ${(st.tokensIn ?? 0) + (st.tokensOut ?? 0)}t` : ''
    return `${st.stage}:${String(st.state).toLowerCase()}(${dur}${tok})`
  }).join(' ')
  console.log(`\nRUN ${r.id.slice(0, 12)} [${r.state}] "${String(r.request).slice(0, 60)}"`)
  console.log(`  tokens: in=${r.tokensIn ?? 0} out=${r.tokensOut ?? 0} total=${(r.tokensIn ?? 0) + (r.tokensOut ?? 0)}`)
  console.log(`  wall: ${fmt(wall)} | started=${r.startedAt?.toISOString()} finished=${r.finishedAt?.toISOString() ?? '—'}`)
  console.log(`  iter: ${r.iteration}/${r.maxIterations} | testRecords=${tests} | corrections=${corrections} | reason=${r.outcomeReason ?? '—'} | err=${r.errorCode ?? '—'}`)
  if (stageSummary) console.log(`  stages: ${stageSummary}`)
}

console.log('\n================ AGENT RUNS (por agente) ================')
const agentRuns = await db.agentRun.findMany({
  orderBy: { startedAt: 'asc' },
  select: {
    id: true, agentId: true, model: true, runType: true, status: true,
    steps: true, tokensIn: true, tokensOut: true, durationMs: true, startedAt: true,
  },
})
for (const a of agentRuns) {
  console.log(
    `${String(a.startedAt?.toISOString()).slice(11, 19)} ${String(a.agentId).padEnd(8)} ${String(a.runType).padEnd(6)} ${String(a.status).padEnd(16)} steps=${String(a.steps).padStart(3)} in=${String(a.tokensIn).padStart(7)} out=${String(a.tokensOut).padStart(6)} ${fmt(a.durationMs)} model=${a.model}`
  )
}

console.log('\n================ TOOL CALLS (agregado por tool) ================')
const toolsRaw = await db.toolCall.groupBy({
  by: ['tool', 'status'],
  _count: { _all: true },
  _avg: { durationMs: true },
})
const byTool = new Map()
for (const t of toolsRaw) {
  const cur = byTool.get(t.tool) ?? { count: 0, avgMs: 0 }
  cur.count += t._count._all
  cur.avgMs = Math.max(cur.avgMs, t._avg.durationMs ?? 0)
  byTool.set(t.tool, cur)
}
for (const [tool, v] of [...byTool.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`${tool.padEnd(22)} count=${String(v.count).padStart(4)} avgMs=${(v.avgMs ?? 0).toFixed(0)}`)
}

console.log('\n================ MODEL USAGE (diário) ================')
const usage = await db.modelUsage.findMany({ orderBy: { day: 'asc' } })
for (const u of usage) {
  console.log(`${u.day} ${String(u.model).padEnd(22)} req=${String(u.requests).padStart(4)} in=${String(u.promptTokens).padStart(9)} out=${String(u.completionTokens).padStart(8)} total=${String(u.totalTokens).padStart(9)} err=${u.errors}`)
}

console.log('\n================ EXECUÇÕES (comandos) ================')
const execs = await db.execution.findMany({
  orderBy: { startedAt: 'asc' },
  take: 60,
  select: { command: true, status: true, durationMs: true, exitCode: true, source: true, trigger: true, startedAt: true },
})
for (const e of execs) {
  console.log(`${String(e.startedAt?.toISOString()).slice(11, 19)} [${String(e.trigger).padEnd(14)}] ${String(e.command).slice(0, 70).padEnd(70)} exit=${String(e.exitCode).padStart(3)} ${fmt(e.durationMs)}`)
}

// ---- Distribuição por trigger (overhead de checkpoints/diff/status) ----
const execByTrigger = await db.execution.groupBy({
  by: ['trigger'],
  _count: { _all: true },
  _sum: { durationMs: true },
})
console.log('\n---- Execuções agregadas por trigger ----')
for (const t of execByTrigger.sort((a, b) => (b._sum.durationMs ?? 0) - (a._sum.durationMs ?? 0))) {
  console.log(`${String(t.trigger).padEnd(16)} count=${String(t._count._all).padStart(3)} tempoTotal=${fmt(t._sum.durationMs ?? 0)}`)
}

// ---- Tokens por passo do agente (contexto reenviado por passo?) ----
console.log('\n---- Tokens IN por passo (contexto reenviado a cada chamada) ----')
const runsWithLogs = await db.agentRun.findMany({
  where: { steps: { gt: 0 }, tokensIn: { gt: 0 } },
  select: { agentId: true, steps: true, tokensIn: true, tokensOut: true, runType: true },
  take: 40,
})
let totalIn = 0, totalSteps = 0
for (const r of runsWithLogs) {
  totalIn += r.tokensIn
  totalSteps += r.steps
}
console.log(`AgentRuns com passos: ${runsWithLogs.length} | total tokensIn=${totalIn} | total passos=${totalSteps} | MÉDIA tokensIn/passo=${(totalIn / Math.max(1, totalSteps)).toFixed(0)}`)

await db.$disconnect()
