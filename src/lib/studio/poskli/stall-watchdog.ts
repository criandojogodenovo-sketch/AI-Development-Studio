// ============================================================
// POSKLI / STALL WATCHDOG — runtime (heartbeat + kill por run)
// ============================================================
// FIX do congelamento em IMPLEMENTING (10+ min sem execução):
//   Causa raiz — quando a função serverless morre a meio de uma
//   chamada de modelo pendente (timeout por request era 180s), o
//   run ficava no estado IMPLEMENTING PARA SEMPRE: nada atualizava
//   o DB, a recuperação de run travado demorava 10 min e só
//   disparava quando o usuário criava um NOVO run.
//
//   Watchdog (este módulo), por run ativo:
//     1. HEARTBEAT a cada 15s — atualiza run.updatedAt no DB
//        (mantém a recuperação de stale honesta: heartbeat morre
//        junto com a função → updatedAt congela → recovery atua).
//     2. ATIVIDADE — todo passo significativo chama touch():
//        início/fim de estágio, transições, chamadas de modelo
//        (AgentRunner, via registry por poskliRunId), execuções.
//     3. KILL — >30s sem atividade (default RUN_STALL_TIMEOUT_MS)
//        → o run é morto com TIMEOUT honesto: estado FAILED,
//        errorCode TIMEOUT, evento no chat, projeto FAILED. O fluxo
//        assíncrono sobrevivente (se houver) encontra ctx.killed e
//        NÃO sobrescreve a decisão do watchdog.
//
//   A decisão pura + registry vivem em stall-watchdog-core.ts
//   (testável com node:test, sem imports de runtime).
// ============================================================

import { db } from '@/lib/db'
import { emitEvent } from '../events/bus'
import { registerTouch, unregisterTouch, stallWatchdogDecision } from './stall-watchdog-core.ts'

export { stallWatchdogDecision, touchPoskliActivity } from './stall-watchdog-core.ts'

export interface RunWatchdogOptions {
  runId: string
  projectId: string
  /** intervalo do heartbeat (default STUDIO_CONFIG.stall.heartbeatMs) */
  heartbeatMs: number
  /** inatividade máxima antes do kill (default stallTimeoutMs) */
  stallTimeoutMs: number
  /** chamado quando o run é morto (o orquestrador arma ctx.killed). */
  onStall?: (info: { silentMs: number; stallTimeoutMs: number }) => void
}

export interface RunWatchdog {
  /** Registra atividade real (estágio/modelo/execução). */
  touch(): void
  /** Para o watchdog (fim normal do run — finally). */
  stop(): void
}

/**
 * Inicia o watchdog de um run. O heartbeat atualiza updatedAt no DB
 * (Prisma @updatedAt); a verificação de inatividade corre no MESMO
 * intervalo. O kill marca o run FAILED/TIMEOUT no DB e emite o
 * evento honesto — idempotente (run já terminal → não toca).
 */
export function startRunWatchdog(opts: RunWatchdogOptions): RunWatchdog {
  let lastActivityAtMs = Date.now()
  let stopped = false
  let killed = false

  const touch = () => {
    lastActivityAtMs = Date.now()
  }
  registerTouch(opts.runId, touch)

  const kill = async (silentMs: number): Promise<void> => {
    if (killed || stopped) return
    killed = true
    unregisterTouch(opts.runId)
    opts.onStall?.({ silentMs, stallTimeoutMs: opts.stallTimeoutMs })
    try {
      // Idempotente: run já terminal (cancelado/terminado normalmente)
      // NÃO é sobrescrito pelo watchdog.
      const row = await db.poskliRun.findUnique({
        where: { id: opts.runId },
        select: { state: true },
      })
      const terminal = ['COMPLETED', 'FAILED', 'BLOCKED', 'PARTIAL', 'CANCELLED']
      if (row && terminal.includes(row.state)) return

      await db.poskliRun.update({
        where: { id: opts.runId },
        data: {
          state: 'FAILED',
          errorCode: 'TIMEOUT',
          outcomeReason: 'STALL_WATCHDOG',
          error:
            `Run watchdog: ${Math.round(silentMs / 1000)}s sem atividade (limite ` +
            `${Math.round(opts.stallTimeoutMs / 1000)}s) — run terminado com TIMEOUT ` +
            'em vez de permanecer congelado em IMPLEMENTING.',
          finishedAt: new Date(),
        },
      })
      await db.task.updateMany({
        where: { projectId: opts.projectId, status: 'RUNNING' },
        data: { status: 'FAILED', error: 'Run morto pelo watchdog (TIMEOUT sem atividade)' },
      }).catch(() => {})
      await db.project.update({
        where: { id: opts.projectId },
        data: { status: 'FAILED' },
      }).catch(() => {})
      await emitEvent({
        type: 'pipeline.failed',
        projectId: opts.projectId,
        runId: opts.runId,
        status: 'FAILED',
        message:
          `Poskli Falhou — watchdog: ${Math.round(silentMs / 1000)}s sem atividade ` +
          `(limite ${Math.round(opts.stallTimeoutMs / 1000)}s). Run terminado com TIMEOUT.`,
        data: { finalState: 'FAILED', reason: 'STALL_WATCHDOG', silentMs, recovered: true },
      })
    } catch (e) {
      console.error('[StallWatchdog] falha ao matar run travado:', (e as Error).message)
    }
  }

  const timer = setInterval(async () => {
    if (stopped || killed) return
    // 1) heartbeat — updatedAt mantém a stale recovery honesta
    await db.poskliRun
      .update({ where: { id: opts.runId }, data: { updatedAt: new Date() } })
      .catch(() => {})
    // 2) verificação de inatividade REAL (touch > heartbeat)
    const decision = stallWatchdogDecision({
      lastActivityAtMs,
      nowMs: Date.now(),
      stallTimeoutMs: opts.stallTimeoutMs,
    })
    if (decision.stalled) {
      console.warn(
        `[StallWatchdog] run ${opts.runId} sem atividade por ${Math.round(decision.silentMs / 1000)}s — a matar com TIMEOUT`
      )
      await kill(decision.silentMs)
    }
  }, Math.max(1_000, opts.heartbeatMs))

  // serverless: o intervalo não deve manter a função viva sozinho
  timer.unref?.()

  return {
    touch,
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      unregisterTouch(opts.runId)
    },
  }
}
