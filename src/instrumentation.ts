// ============================================================
// INSTRUMENTATION — hook de inicialização do Next.js (server).
// Roda UMA vez quando o servidor sobe (dev e produção), ANTES de
// qualquer request. Aqui validamos o ambiente com erros claros.
// REGRA: NUNCA imprimir valores de secrets — o validador garante.
// Em PRODUÇÃO: ambiente inválido (ex.: DATABASE_URL ausente) derruba
// o servidor com mensagem clara (fail-fast > erro críptico do Prisma).
// Em DEV: apenas loga em destaque (permite continuar inspecionando).
// ============================================================

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return // só no runtime Node

  const { validateEnvironment, formatIssues, environmentSummary } =
    await import('./lib/studio/security/env-validator')

  const result = validateEnvironment()
  const isProd = process.env.NODE_ENV === 'production'

  console.log('\n══════ VALIDAÇÃO DE AMBIENTE (server-side) ══════')
  console.log(JSON.stringify(environmentSummary(), null, 2))
  if (result.errors.length || result.warnings.length) {
    console.log(formatIssues(result))
  }
  if (result.ok) {
    console.log('✅ Variáveis obrigatórias presentes e válidas.\n')
  } else {
    console.log(`❌ ${result.errors.length} ERRO(S) de configuração — variáveis listadas acima.\n`)
    if (isProd) {
      // Fail-fast: não subir servidor mal configurado em produção.
      throw new Error(
        'AMBIENTE INVÁLIDO: variáveis obrigatórias ausentes/incorretas (ver log acima). ' +
        'Corrija antes de subir em produção. Nenhum valor de secret foi impresso.'
      )
    }
  }
}
