// Verifica colunas reais da tabela PoskliRun no Neon (com retry p/ wake)
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

for (let attempt = 1; attempt <= 8; attempt++) {
  try {
    const cols = await db.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'PoskliRun' ORDER BY ordinal_position`
    )
    const names = cols.map((c) => c.column_name)
    const needed = ['derived', 'testRecords', 'corrections', 'reviewResult', 'errorCode', 'outcomeReason', 'updatedAt']
    const missing = needed.filter((n) => !names.includes(n))
    console.log('total columns:', names.length)
    console.log(missing.length === 0 ? 'SCHEMA_OK — todas as colunas 0.2 presentes' : `MISSING: ${missing.join(', ')}`)
    process.exit(missing.length === 0 ? 0 : 2)
  } catch (e) {
    console.log(`attempt ${attempt} falhou: ${String(e && e.message ? e.message : e).slice(0, 100)}`)
    await new Promise((r) => setTimeout(r, 12000))
  }
}
process.exit(1)
