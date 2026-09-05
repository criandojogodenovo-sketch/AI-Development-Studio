// ============================================================
// EXECUTION ENGINE — Execução REAL de comandos no workspace
//
// Fluxo: QUEUED → (materializa workspace do DB) → RUNNING
//   → spawn SEM shell (allowlist binária+args) → streaming
//   → timeout/kill → sync disco→DB (persiste artefatos) →
//   SUCCESS | FAILED | CANCELLED | TIMEOUT
//
// Segurança:
//   - allowlist de binários + argumentos (security/commands)
//   - sem shell: spawn direto, metacaracteres proibidos
//   - env MÍNIMO do processo (nunca repassa secrets da função)
//   - masking de tokens no output capturado
//   - cap de output (200KB), timeout com SIGKILL
//   - serialização por projeto (sem execuções concorrentes no mesmo disco)
//   - registry em processo p/ cancelamento
//
// Honestidade serverless: cada comando vive dentro de UMA invocação
// (maxDuration 300s). Comandos que excedem → TIMEOUT honesto com
// output parcial persistido. Builds longos exigiriam executor
// dedicado (DockerExecutionProvider/RemoteSandboxProvider —
// interface já preparada).
// ============================================================

import { spawn, type ChildProcess } from 'child_process'
import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { checkCommand } from '../security/commands'
import { emitEvent } from '../events/bus'
import { ensureMaterialized, syncBackToDb } from '../workspace/sync'

export type ExecutionStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'TIMEOUT'

export interface ExecutionEvent {
  type: 'start' | 'stdout' | 'stderr' | 'status' | 'exit'
  executionId?: string
  command?: string
  chunk?: string
  status?: ExecutionStatus
  exitCode?: number
  durationMs?: number
  syncedFiles?: number
  message?: string
}

export interface RunExecutionOptions {
  projectId: string
  command: string
  userId?: string
  runId?: string
  source?: 'terminal' | 'poskli' | 'pipeline'
  trigger?: string
  timeoutMs?: number
  /** streaming em tempo real (SSE do terminal) */
  onEvent?: (e: ExecutionEvent) => void
  /** cancelamento externo (abort do request) */
  signal?: AbortSignal
  /** não sincronizar disco→DB no fim (default: sync) */
  skipSync?: boolean
}

export interface RunExecutionResult {
  executionId: string
  status: ExecutionStatus
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  syncedFiles: number
}

/** Registry de processos vivos (cancelamento best-effort em processo). */
const liveProcesses = new Map<string, ChildProcess>()

/** Fila por projeto — comandos do mesmo workspace nunca correm em paralelo. */
const projectQueues = new Map<string, Promise<unknown>>()

function enqueue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const prev = projectQueues.get(projectId) ?? Promise.resolve()
  const next = prev.then(task, task)
  projectQueues.set(projectId, next.catch(() => {}))
  next.finally(() => {
    // limpa a fila quando esvazia
    if (projectQueues.get(projectId) === next) projectQueues.delete(projectId)
  }).catch(() => {})
  return next
}

/** Masking de secrets em qualquer output capturado. */
export function maskSecrets(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[TOKEN_REDACTED]')
    .replace(/vcp_[A-Za-z0-9]{20,}/g, '[TOKEN_REDACTED]')
    .replace(/npg_[A-Za-z0-9]{20,}/g, '[TOKEN_REDACTED]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[TOKEN_REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9-_.]{20,}/g, 'Bearer [REDACTED]')
    .replace(/postgresql:\/\/[^\s'"]+/g, '[DATABASE_URL_REDACTED]')
}

/** Timeout efetivo: clamp serverless (deixa margem p/ sync + resposta). */
function effectiveTimeout(requestedMs?: number): number {
  const def = STUDIO_CONFIG.executor.maxCommandTimeoutMs
  const max = process.env.VERCEL ? 240_000 : def
  const t = requestedMs ?? def
  return Math.max(5_000, Math.min(t, max))
}

/** Executa um comando no workspace do projeto (fila + registro + sync). */
export function runExecution(opts: RunExecutionOptions): Promise<RunExecutionResult> {
  return enqueue(opts.projectId, () => doRunExecution(opts))
}

async function doRunExecution(opts: RunExecutionOptions): Promise<RunExecutionResult> {
  const { projectId, command, onEvent } = opts
  const started = Date.now()

  // 1) validação dura (allowlist binária + args)
  const check = checkCommand(command)
  const exec = await db.execution.create({
    data: {
      projectId,
      userId: opts.userId ?? null,
      runId: opts.runId ?? null,
      source: opts.source ?? 'terminal',
      trigger: opts.trigger ?? null,
      command: command.slice(0, 500),
      cwd: 'workspace:/',
      status: 'QUEUED',
    },
  })
  const execId = exec.id
  const emit = (e: ExecutionEvent) => {
    try { onEvent?.({ ...e, executionId: execId }) } catch { /* stream fechado */ }
  }

  if (!check.allowed) {
    const stderr = `COMANDO_NEGADO: ${check.reason}`
    await finishExecution(execId, 'FAILED', 126, '', stderr, 0, false, 0)
    emit({ type: 'exit', exitCode: 126, status: 'FAILED', durationMs: 0, message: stderr })
    await emitEvent({
      type: 'tool.denied',
      projectId,
      tool: 'execution',
      action: command.slice(0, 120),
      status: 'DENIED',
      message: `Comando negado pela política de segurança: ${command.slice(0, 100)}`,
    })
    return { executionId: execId, status: 'FAILED', exitCode: 126, stdout: '', stderr, durationMs: 0, timedOut: false, syncedFiles: 0 }
  }

  await db.execution.update({ where: { id: execId }, data: { status: 'RUNNING' } })
  emit({ type: 'start', command, status: 'RUNNING' })

  // 2) materializa workspace (DB → disco; instância fria serverless)
  let root = ''
  try {
    root = await ensureMaterialized(projectId)
  } catch (e) {
    const stderr = `WORKSPACE_INACESSÍVEL: ${(e as Error).message}`
    await finishExecution(execId, 'FAILED', 125, '', stderr, Date.now() - started, false, 0)
    emit({ type: 'exit', exitCode: 125, status: 'FAILED', message: stderr, durationMs: Date.now() - started })
    return { executionId: execId, status: 'FAILED', exitCode: 125, stdout: '', stderr, durationMs: Date.now() - started, timedOut: false, syncedFiles: 0 }
  }

  // 3) spawn SEM shell, env mínimo, timeout, caps de output
  const maxOut = STUDIO_CONFIG.executor.maxOutputBytes
  const timeoutMs = effectiveTimeout(opts.timeoutMs)
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let cancelled = false
  let truncated = false

  const append = (buf: Buffer, target: 'out' | 'err') => {
    let text = ''
    try { text = buf.toString('utf8') } catch { text = buf.toString('latin1') }
    text = maskSecrets(text)
    if (target === 'out') {
      if (stdout.length < maxOut) stdout += text.slice(0, maxOut - stdout.length)
      else truncated = true
      emit({ type: 'stdout', chunk: text })
    } else {
      if (stderr.length < maxOut) stderr += text.slice(0, maxOut - stderr.length)
      else truncated = true
      emit({ type: 'stderr', chunk: text })
    }
  }

  const result = await new Promise<{ exitCode: number; signal?: string }>((resolve) => {
    const child = spawn(check.cmd, check.args, {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root, // HOME = workspace: isola configs do usuário
        TMPDIR: '/tmp',
        CI: 'true',
        NODE_ENV: 'development',
        npm_config_yes: 'true',
        npm_config_cache: '/tmp/.npm',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    liveProcesses.set(execId, child)

    child.stdout?.on('data', (d: Buffer) => append(d, 'out'))
    child.stderr?.on('data', (d: Buffer) => append(d, 'err'))

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* já morto */ }
    }, timeoutMs)

    const onAbort = () => {
      cancelled = true
      try { child.kill('SIGKILL') } catch { /* já morto */ }
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      liveProcesses.delete(execId)
      stderr += `\nEXEC_ERROR: ${maskSecrets(err.message)}`
      resolve({ exitCode: 127 })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      liveProcesses.delete(execId)
      resolve({ exitCode: code ?? (signal ? 137 : 1), signal: signal ?? undefined })
    })
  })

  const durationMs = Date.now() - started
  if (truncated) stdout += `\n...[saída truncada em ${maxOut} bytes]`

  // 4) status final honesto
  let status: ExecutionStatus
  if (cancelled) status = 'CANCELLED'
  else if (timedOut) status = 'TIMEOUT'
  else if (result.exitCode === 0) status = 'SUCCESS'
  else status = 'FAILED'

  // 5) sync disco→DB (persiste arquivos criados pelo comando)
  let syncedFiles = 0
  if (!opts.skipSync) {
    try {
      const sync = await syncBackToDb(projectId)
      syncedFiles = sync.synced + sync.removed
    } catch { /* best-effort */ }
  }

  await finishExecution(execId, status, result.exitCode, stdout, stderr, durationMs, timedOut, syncedFiles)
  emit({ type: 'exit', exitCode: result.exitCode, status, durationMs, syncedFiles })

  await emitEvent({
    type: 'tool.completed',
    projectId,
    runId: opts.runId ?? null,
    tool: 'execution',
    agent: opts.trigger ?? 'terminal',
    action: command.slice(0, 120),
    status: status === 'SUCCESS' ? 'OK' : status,
    message: `${command.slice(0, 80)} → ${status} (exit ${result.exitCode}, ${(durationMs / 1000).toFixed(1)}s${syncedFiles ? `, ${syncedFiles} arquivo(s) sincronizado(s)` : ''})`,
    durationMs,
  })

  return {
    executionId: execId,
    status,
    exitCode: result.exitCode,
    stdout,
    stderr,
    durationMs,
    timedOut,
    syncedFiles,
  }
}

async function finishExecution(
  id: string,
  status: ExecutionStatus,
  exitCode: number,
  stdout: string,
  stderr: string,
  durationMs: number,
  timedOut: boolean,
  syncedFiles: number
): Promise<void> {
  await db.execution.update({
    where: { id },
    data: {
      status,
      exitCode,
      stdout: stdout.slice(0, 200_000),
      stderr: stderr.slice(0, 60_000),
      durationMs,
      timedOut,
      syncedFiles,
      finishedAt: new Date(),
    },
  }).catch(() => {})
}

/** Cancela uma execução viva (best-effort — mesmo processo/invocação). */
export function cancelExecution(executionId: string): boolean {
  const child = liveProcesses.get(executionId)
  if (!child) return false
  try {
    child.kill('SIGKILL')
    return true
  } catch {
    return false
  }
}

/** Histórico de execuções do projeto. */
export async function listExecutions(projectId: string, take = 30) {
  return db.execution.findMany({
    where: { projectId },
    orderBy: { startedAt: 'desc' },
    take: Math.min(take, 100),
    select: {
      id: true, command: true, source: true, trigger: true, status: true,
      exitCode: true, durationMs: true, timedOut: true, syncedFiles: true,
      startedAt: true, finishedAt: true,
    },
  })
}
