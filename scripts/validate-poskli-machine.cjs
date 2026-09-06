// Valida invariantes da máquina Poskli 0.2 direto do DB (produção)
const { PrismaClient } = require('@prisma/client')

function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) process.exitCode = 1
}

async function main() {
  const db = new PrismaClient()
  const runId = process.argv[2]
  const run = await db.poskliRun.findUnique({ where: { id: runId } })
  if (!run) { console.error('run não encontrado'); process.exit(1) }

  const derived = run.derived
  const d = derived ?? {}
  const displayOf = (g) => (g === 'SUCCESS' ? 'COMPLETED' : g)

  console.log(`\n[VALIDAÇÃO DA MÁQUINA — run ${runId.slice(-8)}]`)
  console.log(`  state=${run.state} · derived.state=${d.state} · errorCode=${run.errorCode} · reason=${d.outcomeReason ?? run.outcomeReason}`)
  ok('run em estado terminal', ['COMPLETED', 'FAILED', 'BLOCKED', 'PARTIAL', 'CANCELLED'].includes(run.state))
  ok('derivação persistida (fonte da verdade)', Boolean(derived && d.state))
  if (!derived) return
  ok('estado exibido = derivação (backend=frontend)', run.state === displayOf(d.state))
  ok('derivação conservadora', d.conservative === true)

  const criteria = d.criteria ?? []
  ok('6 critérios avaliados', criteria.length === 6, criteria.map((c) => `${c.id}:${c.status}`).join(' '))
  const allPass = criteria.every((c) => c.status === 'PASS')
  const anyFail = criteria.some((c) => c.status === 'FAIL')
  if (d.state === 'SUCCESS') ok('SUCCESS exige TODOS os critérios PASS', allPass)
  if (d.state === 'FAILED') ok('FAILED tem ≥1 critério FAIL (justificado)', anyFail)
  if (d.state === 'BLOCKED' || d.state === 'PARTIAL') ok('BLOCKED/PARTIAL sem todos-PASS', !allPass)

  // INVARIANTE: run COMPLETED ⇔ derived SUCCESS
  ok('COMPLETED ⇔ SUCCESS derivado', (run.state === 'COMPLETED') === (d.state === 'SUCCESS'))
  ok('COMPLETED exige testes verdes', run.state !== 'COMPLETED' || run.testsPassed === true)

  const c = d.counters
  if (c) {
    ok('contadores de tarefas coerentes', c.tasks.completed <= c.tasks.total, `${c.tasks.completed}/${c.tasks.total} concluídas, ${c.tasks.failed} falharam, ${c.tasks.blocked} bloqueadas`)
    ok('0/N concluídas JAMAIS gera SUCCESS', !(c.tasks.completed < c.tasks.total && d.state === 'SUCCESS'))
  }

  const tr = run.testRecords ?? []
  ok('registros de teste com identidade única', new Set(tr.map((t) => t.id)).size === tr.length, `${tr.length} registro(s)`)
  const corr = run.corrections ?? []
  ok('correções com estado individual válido', corr.every((x) => ['PLANNED', 'STARTED', 'COMPLETED', 'FAILED', 'BLOCKED'].includes(x.state)), `${corr.length} correção(ões): ${corr.map((x) => `${x.attempt}:${x.state}`).join(' ')}`)
  ok('snapshot de revisão persistido', Boolean(run.reviewResult && run.reviewResult.status), `status=${run.reviewResult?.status} motivo=${run.reviewResult?.blockedReason ?? '—'}`)
  ok('relatório markdown presente', Boolean(run.result && run.result.includes('Resultado do Poskli')))
  ok('markdown reflete estado real', !run.result || run.result.includes('**Estado:**') === true)

  console.log(`\n  resumo da derivação: ${d.summary}`)
  await db.$disconnect()
}

main().catch((e) => { console.error('ERRO:', e); process.exit(1) })
