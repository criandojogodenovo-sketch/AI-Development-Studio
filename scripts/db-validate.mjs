// ============================================================
// VALIDAÇÃO DE BANCO — CRUD real contra PostgreSQL
// (mesmo protocolo do Neon; sandbox usa PG embutido :5433)
// Executar: DATABASE_URL=postgresql://... node scripts/db-validate.mjs
// Cria, lê, atualiza e remove entidades REAIS via Prisma.
// ============================================================

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
let passed = 0, failed = 0
const assert = (c, m) => { if (c) { passed++; console.log(`  ✅ ${m}`) } else { failed++; console.error(`  ❌ ${m}`) } }

async function main() {
  console.log('\n[1] conexão com PostgreSQL')
  await db.$connect()
  const raw = await db.$queryRaw`SELECT version()`
  const version = String(raw[0].version ?? '')
  assert(version.includes('PostgreSQL'), `servidor respondeu: ${version.split(',')[0]}`)

  console.log('\n[2] tabelas criadas pela migration')
  const tables = (await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)
  const names = tables.map((t) => t.tablename)
  for (const expected of ['User', 'Session', 'Project', 'ProjectSettings', 'Task', 'AgentRun', 'ToolCall', 'ActivityEvent', 'GithubConnection', 'ModelUsage']) {
    assert(names.includes(expected), `tabela ${expected}`)
  }

  console.log('\n[3] CRUD real — User + Session')
  const email = `dbval-${Date.now()}@test.local`
  const user = await db.user.create({
    data: { email, name: 'DB Val', passwordHash: 'x', role: 'user' },
  })
  assert(!!user.id, 'user.create')
  const session = await db.session.create({
    data: { userId: user.id, token: `tok-${Date.now()}`, expiresAt: new Date(Date.now() + 3600_000) },
  })
  assert(!!session.id, 'session.create')

  console.log('\n[4] CRUD real — Project + Settings (campos Json/JSONB)')
  const project = await db.project.create({
    data: {
      userId: user.id,
      name: 'Projeto Validação',
      description: 'CRUD de validação PostgreSQL',
      type: 'MINI_GAME',
      status: 'CREATED',
      rootPath: '/tmp/val',
      gitBranch: 'main',
      memory: { architecture: 'canvas-2d', decisions: [], knownIssues: [] },
    },
  })
  assert(!!project.id, 'project.create com memory JSONB')
  const settings = await db.projectSettings.create({
    data: { projectId: project.id, approvalMode: 'ASSISTED', maxAgentSteps: 30 },
  })
  assert(settings.approvalMode === 'ASSISTED', 'projectSettings.create')

  console.log('\n[5] CRUD real — Task (grafo com dependências JSONB)')
  const t1 = await db.task.create({
    data: {
      projectId: project.id, order: 0, title: 'setup', description: 'setup',
      status: 'PENDING', priority: 'HIGH', agentRole: 'coding',
      dependencies: [], input: { requirements: 'x' }, result: {},
    },
  })
  const t2 = await db.task.create({
    data: {
      projectId: project.id, order: 1, title: 'implement', description: 'impl',
      status: 'PENDING', agentRole: 'coding',
      dependencies: [t1.id], input: {}, result: {},
    },
  })
  assert(t2.dependencies.length === 1, 'task.create com dependencies JSONB')

  console.log('\n[6] CRUD real — AgentRun + ToolCall + ActivityEvent')
  const run = await db.agentRun.create({
    data: {
      projectId: project.id, taskId: t1.id, agentId: 'coding',
      model: 'qwen3.8-flash', runType: 'TASK', status: 'STARTED',
      log: [{ thought: 'início', action: 'list_files' }],
    },
  })
  const call = await db.toolCall.create({
    data: { runId: run.id, projectId: project.id, tool: 'list_files', args: { path: '.' }, status: 'OK', output: '[]', durationMs: 12 },
  })
  const ev = await db.activityEvent.create({
    data: { projectId: project.id, taskId: t1.id, runId: run.id, type: 'tool.called', tool: 'list_files', message: 'ok', data: { n: 1 }, durationMs: 12 },
  })
  assert(!!call.id && !!ev.id, 'agentRun/toolCall/activityEvent create')

  console.log('\n[7] CRUD real — ModelUsage (upsert agregado, economia de créditos)')
  const day = new Date().toISOString().slice(0, 10)
  const testModel = 'dbval-test-model' // id único: isolamento de dados reais
  await db.modelUsage.deleteMany({ where: { day, model: testModel } })
  await db.modelUsage.upsert({
    where: { day_model: { day, model: testModel } },
    create: { day, model: testModel, requests: 1, promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    update: { requests: { increment: 1 }, totalTokens: { increment: 150 } },
  })
  await db.modelUsage.upsert({
    where: { day_model: { day, model: testModel } },
    create: { day, model: testModel, requests: 1 },
    update: { requests: { increment: 1 }, totalTokens: { increment: 150 } },
  })
  const usage = await db.modelUsage.findUnique({ where: { day_model: { day, model: testModel } } })
  assert(usage?.requests === 2 && usage?.totalTokens === 300, 'upsert + increment (requests=2, tokens=300)')
  await db.modelUsage.deleteMany({ where: { day, model: testModel } })

  console.log('\n[8] update + query com filtro (isolamento por usuário)')
  await db.project.update({ where: { id: project.id }, data: { status: 'RUNNING' } })
  const mine = await db.project.findMany({ where: { userId: user.id } })
  const otherUser = await db.user.create({ data: { email: `o-${Date.now()}@t.local`, name: 'O', passwordHash: 'x' } })
  const notMine = await db.project.findMany({ where: { userId: otherUser.id } })
  assert(mine.length === 1 && mine[0].status === 'RUNNING', 'update + filtro por dono (isolamento)')
  assert(notMine.length === 0, 'usuário outro não vê projetos alheios')

  console.log('\n[9] cascade delete (projeto → tasks/runs/calls)')
  await db.user.delete({ where: { id: user.id } })
  const tasksLeft = await db.task.count({ where: { projectId: project.id } })
  const runsLeft = await db.agentRun.count({ where: { projectId: project.id } })
  const sessionsLeft = await db.session.count({ where: { userId: user.id } })
  assert(tasksLeft === 0 && runsLeft === 0 && sessionsLeft === 0, 'cascade funcionou em cascata completa')
  await db.user.delete({ where: { id: otherUser.id } }).catch(() => {})

  console.log('\n[10] GithubConnection (token somente last-4, nunca completo)')
  const guser = await db.user.create({ data: { email: `g-${Date.now()}@t.local`, name: 'G', passwordHash: 'x' } })
  const gc = await db.githubConnection.create({
    data: { userId: guser.id, login: 'octocat', tokenLast4: 'abcd', scopes: ['repo'], active: true },
  })
  assert(gc.tokenLast4 === 'abcd' && !('token' in gc), 'apenas last4 armazenado')
  await db.user.delete({ where: { id: guser.id } })

  console.log(`\n========================================`)
  console.log(`VALIDAÇÃO DATABASE: ${passed} passaram, ${failed} falharam`)
}

main()
  .catch((e) => { console.error('FALHA:', e.message); process.exitCode = 1 })
  .finally(async () => { await db.$disconnect() })
