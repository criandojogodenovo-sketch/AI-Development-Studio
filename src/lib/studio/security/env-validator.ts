// ============================================================
// VALIDAÇÃO DE AMBIENTE — server-side only
// Cada variável é validada PELO CONSUMIDOR que realmente a usa:
//   DATABASE_URL      → Prisma (prisma/schema.prisma + src/lib/db.ts)
//   BAI_API_KEY_1/2   → BAIKeyManager / BAIProvider
//   EXECUTION_PROVIDER→ config.ts → executor/provider.ts
//   numéricos         → config.ts (num() substitui silenciosamente
//                       valores inválidos pelo default — o validador
//                       AVISA quando isso aconteceria)
//   ENABLE_DEEPSEEK   → config.ts → ModelRouter (gate triplo)
// REGRAS INVIOLÁVEIS:
//   1. NUNCA imprimir valor de secret (apenas nome + diagnóstico)
//   2. NUNCA inventar valor de secret ausente
//   3. Erros CLAROS, com variável, consumidor e correção
// ============================================================

export interface EnvIssue {
  level: 'error' | 'warn'
  varName: string
  consumer: string
  message: string
}

export interface EnvValidationResult {
  ok: boolean
  errors: EnvIssue[]
  warnings: EnvIssue[]
}

const POSTGRES_URL_RE = /^postgres(ql)?:\/\/.+/i

/** Protocols proibidos de vazarem no frontend (auditoria de prefixo). */
export const SERVER_ONLY_VARS = [
  'DATABASE_URL',
  'BAI_API_KEY_1',
  'BAI_API_KEY_2',
  'NVIDIA_API_KEY',
  'EXPLABS_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'AUTH_SECRET',
] as const

/** Variáveis numéricas opcionais consumidas por config.ts (num()).
 *  Se o valor definido não for número positivo, config.ts trocaria
 *  silenciosamente pelo default — aqui avisamos ANTES. */
const NUMERIC_VARS: Array<{ name: string; consumer: string; min?: number; max?: number }> = [
  { name: 'DEEPSEEK_MAX_DAILY_REQUESTS', consumer: 'ModelRouter (limite diário DeepSeek)' },
  { name: 'MODEL_REQUEST_TIMEOUT_MS', consumer: 'providers (timeout por request LLM)' },
  { name: 'BAI_FAILURES_BEFORE_COOLDOWN', consumer: 'BAIKeyManager (cooldown)' },
  { name: 'BAI_KEY_COOLDOWN_MS', consumer: 'BAIKeyManager (cooldown)' },
  { name: 'AGENT_MAX_STEPS', consumer: 'agent loop (limite de passos)' },
  { name: 'AGENT_MAX_RETRIES', consumer: 'pipeline (MAX_TASK_ATTEMPTS absoluto)' },
  { name: 'MAX_REVIEW_CYCLES', consumer: 'pipeline (ciclos de review)' },
  { name: 'MAX_TOOL_CALLS', consumer: 'agent loop (orçamento de tools)' },
  { name: 'MAX_TOTAL_EXECUTION_TIME', consumer: 'pipeline (tempo total)' },
  { name: 'REPEATED_FAILURE_THRESHOLD', consumer: 'RepeatedFailureDetector' },
  { name: 'MAX_COMMAND_TIMEOUT', consumer: 'executor/commands (timeout)' },
  { name: 'MAX_PROCESS_COUNT', consumer: 'executor/commands (processos)' },
  { name: 'MAX_OUTPUT_BYTES', consumer: 'executor/commands (output)' },
  { name: 'MAX_FILE_SIZE', consumer: 'fs-tools (tamanho de escrita)' },
  { name: 'MAX_PROJECT_SIZE', consumer: 'path/workspace (cota)' },
  { name: 'MAX_FILE_READ_BYTES', consumer: 'fs-tools (tamanho de leitura)' },
  { name: 'SESSION_TTL_HOURS', consumer: 'auth route (cookie maxAge)' },
  { name: 'RATE_LIMIT_WINDOW_MS', consumer: 'rate-limit (janela)' },
  { name: 'RATE_LIMIT_MAX_REQUESTS', consumer: 'rate-limit (teto)' },
  { name: 'RUN_RATE_LIMIT_PER_MIN', consumer: 'rate-limit (runs/min)' },
  { name: 'GITHUB_MAX_REPO_MB', consumer: 'github-tools (teto de repo)' },
  { name: 'CONTEXT_MAX_FILES', consumer: 'ContextManager (arquivos)' },
  { name: 'CONTEXT_MAX_FILE_CHARS', consumer: 'ContextManager (chars/arquivo)' },
  { name: 'CONTEXT_MAX_HISTORY_STEPS', consumer: 'ContextManager (histórico)' },
  { name: 'CONTEXT_MAX_TEST_OUTPUT_CHARS', consumer: 'ContextManager (saída de testes)' },
  { name: 'EVENTS_PORT', consumer: 'events-service (socket)', min: 1, max: 65535 },
  { name: 'EVENTS_INGEST_PORT', consumer: 'events-service (ingest)', min: 1, max: 65535 },
]

function issue(level: EnvIssue['level'], varName: string, consumer: string, message: string): EnvIssue {
  return { level, varName, consumer, message }
}

/**
 * Valida o ambiente do servidor. Não lança — retorna issues para o
 * chamador decidir (instrumentation.ts lança em produção).
 * Nenhum valor de variável é incluído no resultado.
 */
export function validateEnvironment(nodeEnv?: string): EnvValidationResult {
  const errors: EnvIssue[] = []
  const warnings: EnvIssue[] = []
  const isProd = (nodeEnv ?? process.env.NODE_ENV ?? '') === 'production'

  // ---------- 1. DATABASE_URL (OBRIGATÓRIA) ----------
  // Consumidor: prisma/schema.prisma (env("DATABASE_URL")) + src/lib/db.ts
  const dbUrl = (process.env.DATABASE_URL ?? '').trim()
  if (!dbUrl) {
    errors.push(issue('error', 'DATABASE_URL', 'Prisma (schema.prisma / db.ts)',
      'AUSENTE — connection string do PostgreSQL (Neon) é obrigatória. ' +
      'Defina no .env (dev) ou Environment Variables (Vercel). NUNCA use NEXT_PUBLIC_DATABASE_URL.'))
  } else if (!POSTGRES_URL_RE.test(dbUrl)) {
    const proto = dbUrl.split('://')[0]?.slice(0, 24) ?? '(sem protocolo)'
    errors.push(issue('error', 'DATABASE_URL', 'Prisma (provider=postgresql)',
      `protocolo inválido "${proto}://" — o schema exige postgres:// ou postgresql://. ` +
      '(SQLite file:/ não é suportado desde a migração para Neon.)'))
  } else if (dbUrl.includes('channel_binding=require')) {
    errors.push(issue('error', 'DATABASE_URL', 'Prisma (engine node)',
      'contém "channel_binding=require" — parâmetro libpq não suportado pelo engine do Prisma. ' +
      'Remova-o da query string (sslmode=require já garante TLS).'))
  }

  // ---------- 2. AUTH_SECRET ----------
  // Consumidor declarado: config.ts (security.sessionSecret).
  // AUDITORIA HONESTA: a variável é lida pelo config.ts, mas o auth real
  // usa tokens opacos aleatórios com hash no DB (crypto.randomBytes) —
  // AUTH_SECRET NÃO é consumido pelo fluxo de sessão atual. Reservada.
  const authSecret = (process.env.AUTH_SECRET ?? '').trim()
  if (!authSecret) {
    warnings.push(issue('warn', 'AUTH_SECRET', 'config.ts (security.sessionSecret — reservada)',
      'ausente. O auth atual usa tokens opacos no DB (não depende deste secret); ' +
      'definir AUTH_SECRET forte é recomendado para usos futuros de assinatura.'))
  } else if (authSecret.length < 16) {
    warnings.push(issue('warn', 'AUTH_SECRET', 'config.ts (security.sessionSecret)',
      `curta (${authSecret.length} caracteres) — recomenda-se >= 32 aleatórios.`))
  } else if (authSecret === 'dev-only-secret-change-me' || authSecret === 'troque-por-um-segredo-forte-aleatorio') {
    if (isProd) {
      errors.push(issue('error', 'AUTH_SECRET', 'config.ts (security.sessionSecret)',
        'valor DEFAULT de exemplo em produção — troque por um segredo forte e aleatório.'))
    } else {
      warnings.push(issue('warn', 'AUTH_SECRET', 'config.ts (security.sessionSecret)',
        'valor default de exemplo — troque antes de produção.'))
    }
  }

  // ---------- 3. BAI_API_KEY_1 / BAI_API_KEY_2 ----------
  // Consumidor: BAIKeyManager + BAIProvider + ModelRouter (provider físico).
  // Opcionais: sem chaves, o sistema usa o SDK do sandbox (zai).
  const k1 = (process.env.BAI_API_KEY_1 ?? '').trim()
  const k2 = (process.env.BAI_API_KEY_2 ?? '').trim()
  if (!k1 && !k2) {
    warnings.push(issue('warn', 'BAI_API_KEY_1 / BAI_API_KEY_2', 'BAIKeyManager / ModelRouter',
      isProd
        ? 'nenhuma chave B.AI configurada em PRODUÇÃO — o fallback do SDK do sandbox NÃO existe fora dele. Configure ao menos uma.'
        : 'nenhuma chave B.AI configurada — provider físico será o SDK do sandbox (z-ai-web-dev-sdk).'))
  } else if (!k1 || !k2) {
    warnings.push(issue('warn', k1 ? 'BAI_API_KEY_2' : 'BAI_API_KEY_1', 'BAIKeyManager (failover)',
      'apenas uma chave configurada — sem failover de disponibilidade.'))
  }
  if (k1 && k2 && k1 === k2) {
    warnings.push(issue('warn', 'BAI_API_KEY_1 / BAI_API_KEY_2', 'BAIKeyManager (failover)',
      'chaves idênticas — o failover KEY1→KEY2 não terá efeito prático.'))
  }

  // ---------- 4. EXECUTION_PROVIDER ----------
  // Consumidor: config.ts → executor/provider.ts
  const execProvider = (process.env.EXECUTION_PROVIDER ?? 'local').trim().toLowerCase()
  if (!['local', 'docker', 'remote'].includes(execProvider)) {
    warnings.push(issue('warn', 'EXECUTION_PROVIDER', 'executor/provider.ts',
      `valor "${execProvider.slice(0, 20)}" não reconhecido — esperado local | docker | remote. Usando local.`))
  } else if (execProvider === 'docker' || execProvider === 'remote') {
    warnings.push(issue('warn', 'EXECUTION_PROVIDER', 'executor/provider.ts',
      `"${execProvider}" não implementado — o sistema é honesto: apenas local executa de verdade. Defina local.`))
  }

  // ---------- 5. WORKSPACES_ROOT ----------
  // Consumidor: config.ts → projects/workspace.ts (isolamento por projeto)
  const wsRoot = (process.env.WORKSPACES_ROOT ?? '').trim()
  if (wsRoot && !wsRoot.startsWith('/')) {
    errors.push(issue('error', 'WORKSPACES_ROOT', 'projects/workspace.ts (isolamento)',
      `deve ser caminho ABSOLUTO — recebido relativo "${wsRoot.slice(0, 30)}".`))
  }

  // ---------- 6. ENABLE_DEEPSEEK ----------
  // Consumidor: config.ts → ModelRouter (gate triplo: chat/isAvailable/fallback)
  const ds = (process.env.ENABLE_DEEPSEEK ?? '').trim().toLowerCase()
  if (ds && !['true', 'false', '1', '0'].includes(ds)) {
    warnings.push(issue('warn', 'ENABLE_DEEPSEEK', 'ModelRouter (gate triplo)',
      `valor "${ds.slice(0, 12)}" inválido — interpretado como false (DeepSeek permanece DESATIVADO). Use true/false.`))
  } else if (ds === 'true' || ds === '1') {
    warnings.push(issue('warn', 'ENABLE_DEEPSEEK', 'ModelRouter (gate triplo)',
      'habilitado — DeepSeek continuará protegido por limite diário e só como fallback de problemas difíceis.'))
  }

  // ---------- 7. GITHUB_TOKEN (opcional) ----------
  // Consumidor: github-tools.ts (Authorization: Bearer — nunca exposto; só last-4 no status)
  const ghToken = (process.env.GITHUB_TOKEN ?? '').trim()
  if (ghToken && !/^(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(ghToken)) {
    warnings.push(issue('warn', 'GITHUB_TOKEN', 'github-tools.ts (Bearer header)',
      'formato não reconhecido (esperado ghp_… ou github_pat_…). A integração pode falhar por 401.'))
  }

  // ---------- 8. GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET (reservadas) ----------
  // AUDITORIA HONESTA: nenhuma linha de código as consome hoje (OAuth futuro).
  const gcId = (process.env.GITHUB_CLIENT_ID ?? '').trim()
  const gcSecret = (process.env.GITHUB_CLIENT_SECRET ?? '').trim()
  if (gcId || gcSecret) {
    warnings.push(issue('warn', 'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET', '(reservadas — OAuth futuro)',
      'definidas mas NÃO consumidas pelo código atual. Manter em segredo mesmo assim: são server-only por design.'))
  }

  // ---------- 9. Numéricos (config.ts num()) ----------
  for (const spec of NUMERIC_VARS) {
    const raw = (process.env[spec.name] ?? '').trim()
    if (!raw) continue
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) {
      warnings.push(issue('warn', spec.name, spec.consumer,
        `valor inválido — config.ts usará o default no lugar (não numérico ou <= 0).`))
    } else if (spec.min !== undefined && n < spec.min) {
      warnings.push(issue('warn', spec.name, spec.consumer, `abaixo do mínimo ${spec.min}.`))
    } else if (spec.max !== undefined && n > spec.max) {
      warnings.push(issue('warn', spec.name, spec.consumer, `acima do máximo ${spec.max}.`))
    }
  }

  // ---------- 10. Modelos (nomes) ----------
  // Consumidor: config.ts (defaults se vazios)
  for (const [name, consumer] of [
    ['GLM_MODEL', 'ModelRouter (master)'],
    ['QWEN_MODEL', 'ModelRouter (coding)'],
    ['HY3_MODEL', 'ModelRouter (review)'],
    ['DEEPSEEK_MODEL', 'ModelRouter (deepseek)'],
  ] as const) {
    const raw = (process.env[name] ?? '').trim()
    if (raw === '') {
      if (process.env[name] !== undefined) {
        warnings.push(issue('warn', name, consumer, 'definida como string vazia — config.ts usará o default.'))
      }
    } else if (/\s/.test(raw)) {
      warnings.push(issue('warn', name, consumer, 'contém espaços — provavelmente inválido como id de modelo.'))
    }
  }

  // ---------- 10b. CHAIN DE PROVIDERS (POSKLI_VERSION + NVIDIA + EXPLABS) ----------
  // Consumidor: chain.ts / ModelRouter (roteamento por versão do Poskli)
  const chainVersion = (process.env.POSKLI_VERSION ?? '').trim()
  if (chainVersion && !['0.1', '0.2', '0.3.1', '1.0-flash'].includes(chainVersion)) {
    errors.push(issue('error', 'POSKLI_VERSION', 'chain.ts / ModelRouter (roteamento de providers)',
      `valor "${chainVersion.slice(0, 12)}" inválido — esperado 0.1 | 0.2 | 0.3.1 | 1.0-flash (default 0.2).`))
  }
  const nvKey = (process.env.NVIDIA_API_KEY ?? '').trim()
  const xlKey = (process.env.EXPLABS_API_KEY ?? '').trim()
  const activeVer = chainVersion || '0.2'
  if (!nvKey && ['0.2', '0.3.1', '1.0-flash'].includes(activeVer) && isProd) {
    warnings.push(issue('warn', 'NVIDIA_API_KEY', 'NVIDIAProvider (chain do ModelRouter)',
      `ausente em produção com POSKLI_VERSION=${activeVer} — o chain seguirá sem o provider NVIDIA (failover adicional indisponível).`))
  }
  if (!xlKey && ['0.3.1', '1.0-flash'].includes(activeVer) && isProd) {
    warnings.push(issue('warn', 'EXPLABS_API_KEY', 'ExperientialProvider (chain do ModelRouter)',
      `ausente em produção com POSKLI_VERSION=${activeVer} — o chain seguirá sem o provider Experiential.`))
  }
  for (const [name, consumer] of [
    ['NVIDIA_BASE_URL', 'NVIDIAProvider (endpoint)'],
    ['EXPLABS_BASE_URL', 'ExperientialProvider (endpoint)'],
  ] as const) {
    const raw = (process.env[name] ?? '').trim()
    if (raw && !/^https:\/\//.test(raw)) {
      warnings.push(issue('warn', name, consumer, 'valor não é https:// — endpoints de LLM devem usar TLS.'))
    }
  }
  for (const [name, consumer] of [
    ['NVIDIA_MODEL_MASTER', 'ModelRouter (master/nvidia)'],
    ['NVIDIA_MODEL_CODING', 'ModelRouter (coding/nvidia)'],
    ['NVIDIA_MODEL_REVIEW', 'ModelRouter (review/nvidia)'],
    ['EXPLABS_MODEL_MASTER', 'ModelRouter (master/explabs)'],
    ['EXPLABS_MODEL_MASTER_FALLBACK', 'ExperientialProvider (fallback regional)'],
    ['EXPLABS_MODEL_CODING', 'ModelRouter (coding/explabs)'],
    ['EXPLABS_MODEL_REVIEW', 'ModelRouter (review/explabs)'],
  ] as const) {
    const raw = (process.env[name] ?? '').trim()
    if (raw && /\s/.test(raw)) {
      warnings.push(issue('warn', name, consumer, 'contém espaços — provavelmente inválido como id de modelo.'))
    }
  }

  // ---------- 11. Negação NEXT_PUBLIC_* de secrets ----------
  // Auditoria: NENHUM uso de NEXT_PUBLIC_ existe no código; se alguém
  // definir estas variantes, o bundler as exporia ao frontend.
  for (const base of SERVER_ONLY_VARS) {
    const pubVar = `NEXT_PUBLIC_${base}`
    if ((process.env[pubVar] ?? '').trim() !== '') {
      errors.push(issue('error', pubVar, 'bundler do Next.js (frontend)',
        'PROIBIDO — secret com prefixo NEXT_PUBLIC_ é embutido no bundle do cliente. Remova-o.'))
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** Formata issues para log — SEM valores de variáveis. */
export function formatIssues(result: EnvValidationResult): string {
  const lines: string[] = []
  for (const e of result.errors) {
    lines.push(`  ❌ ${e.varName} [${e.consumer}]: ${e.message}`)
  }
  for (const w of result.warnings) {
    lines.push(`  ⚠  ${w.varName} [${w.consumer}]: ${w.message}`)
  }
  return lines.join('\n')
}

/** Resumo seguro (sem valores) — pode ser logado sem risco. */
export function environmentSummary(): Record<string, unknown> {
  const k1 = (process.env.BAI_API_KEY_1 ?? '').trim()
  const k2 = (process.env.BAI_API_KEY_2 ?? '').trim()
  const gh = (process.env.GITHUB_TOKEN ?? '').trim()
  const nv = (process.env.NVIDIA_API_KEY ?? '').trim()
  const xl = (process.env.EXPLABS_API_KEY ?? '').trim()
  return {
    nodeEnv: process.env.NODE_ENV ?? '(unset)',
    database: POSTGRES_URL_RE.test((process.env.DATABASE_URL ?? '').trim()) ? 'postgresql ok' : 'INVÁLIDA/AUSENTE',
    baiKeys: { key1: Boolean(k1), key2: Boolean(k2), provider: k1 || k2 ? 'bai' : 'zai-sandbox' },
    nvidiaKey: nv ? `configurada (…${nv.slice(-4)})` : 'não configurada',
    explabsKey: xl ? `configurada (…${xl.slice(-4)})` : 'não configurada',
    poskliVersion: (process.env.POSKLI_VERSION ?? '0.2').trim() || '0.2',
    githubToken: gh ? `configurado (…${gh.slice(-4)})` : 'não configurado',
    deepseekEnabled: (process.env.ENABLE_DEEPSEEK ?? 'false') === 'true',
    executionProvider: (process.env.EXECUTION_PROVIDER ?? 'local').trim(),
  }
}
