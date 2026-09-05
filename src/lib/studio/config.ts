// ============================================================
// AI DEVELOPMENT STUDIO — Configuração central (server-side only)
// Todos os limites do sistema são definidos aqui.
// Secrets NUNCA são expostos ao frontend (sem NEXT_PUBLIC_*).
// ============================================================

function num(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback
  return v === 'true' || v === '1'
}

export const STUDIO_CONFIG = {
  // ---------- MODELOS (roteamento lógico) ----------
  models: {
    master: process.env.MODEL_MASTER ?? 'glm-5.3-flash',
    coding: process.env.MODEL_CODING ?? 'qwen3.8-flash',
    review: process.env.MODEL_REVIEW ?? 'hy3',
    deepseek: 'deepseek-v4-flash',
    // DeepSeek DESATIVADO POR PADRÃO — somente fallback configurável
    enableDeepseek: bool(process.env.ENABLE_DEEPSEEK, false),
    deepseekMaxDailyRequests: num(process.env.DEEPSEEK_MAX_DAILY_REQUESTS, 10),
    requestTimeoutMs: num(process.env.MODEL_REQUEST_TIMEOUT_MS, 180_000),
  },

  // ---------- LIMITES DO LOOP (nunca loop infinito) ----------
  limits: {
    maxAgentSteps: num(process.env.AGENT_MAX_STEPS, 30),
    maxTaskAttempts: num(process.env.AGENT_MAX_RETRIES, 3),
    maxReviewCycles: num(process.env.MAX_REVIEW_CYCLES, 5),
    maxToolCalls: num(process.env.MAX_TOOL_CALLS, 60),
    maxTotalExecutionMs: num(process.env.MAX_TOTAL_EXECUTION_TIME, 900_000), // 15 min
    // Detecção de loop: mesma assinatura de erro+ação repetida N vezes
    repeatedFailureThreshold: num(process.env.REPEATED_FAILURE_THRESHOLD, 3),
  },

  // ---------- EXECUÇÃO / SANDBOX ----------
  executor: {
    provider: (process.env.EXECUTION_PROVIDER ?? 'local') as 'local' | 'docker' | 'remote',
    workspacesRoot: process.env.WORKSPACES_ROOT ?? '/home/z/my-project/workspaces',
    maxCommandTimeoutMs: num(process.env.MAX_COMMAND_TIMEOUT, 120_000),
    maxProcessCount: num(process.env.MAX_PROCESS_COUNT, 50),
    maxOutputBytes: num(process.env.MAX_OUTPUT_BYTES, 200_000),
  },

  // ---------- ARQUIVOS ----------
  files: {
    maxFileSize: num(process.env.MAX_FILE_SIZE, 2_000_000), // 2 MB por arquivo
    maxProjectSize: num(process.env.MAX_PROJECT_SIZE, 100_000_000), // 100 MB
    maxFileReadBytes: num(process.env.MAX_FILE_READ_BYTES, 400_000),
    blockedExtensions: ['.exe', '.dll', '.so', '.bin', '.sh', '.bat', '.cmd', '.env', '.pem', '.key'],
    blockedPaths: ['node_modules', '.git/objects', '.next', 'dist', '.cache', '__pycache__'],
  },

  // ---------- GITHUB ----------
  github: {
    token: process.env.GITHUB_TOKEN ?? '', // server-side apenas
    apiBase: 'https://api.github.com',
    defaultBranch: 'main',
    maxRepoMb: num(process.env.GITHUB_MAX_REPO_MB, 200),
  },

  // ---------- SEGURANÇA ----------
  security: {
    sessionSecret: process.env.AUTH_SECRET ?? 'dev-only-secret-change-me',
    sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 168), // 7 dias
    rateLimitWindowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMaxRequests: num(process.env.RATE_LIMIT_MAX_REQUESTS, 120),
    runRateLimitPerMin: num(process.env.RUN_RATE_LIMIT_PER_MIN, 6),
  },

  // ---------- EVENTOS / OBSERVABILIDADE ----------
  events: {
    port: num(process.env.EVENTS_PORT, 3003),
    ingestPort: num(process.env.EVENTS_INGEST_PORT, 3004),
    maxEventDataChars: 4000,
  },

  // ---------- CONTEXTO (economia de tokens) ----------
  context: {
    maxFilesInContext: num(process.env.CONTEXT_MAX_FILES, 12),
    maxFileCharsInContext: num(process.env.CONTEXT_MAX_FILE_CHARS, 6000),
    maxHistorySteps: num(process.env.CONTEXT_MAX_HISTORY_STEPS, 10),
    maxTestOutputChars: num(process.env.CONTEXT_MAX_TEST_OUTPUT_CHARS, 3000),
  },
} as const

export type StudioConfig = typeof STUDIO_CONFIG
