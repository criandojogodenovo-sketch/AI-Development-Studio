// ============================================================
// POSKLI / STALL WATCHDOG — NÚCLEO PURO (decisão + registry)
// ============================================================
// Parte testável com node:test (ZERO imports de runtime — o mesmo
// contrato do state-machine.ts/loop-guard.ts). O runtime (db,
// eventos, intervalos) vive em stall-watchdog.ts.
//
// Semântica:
//   stalled = (now - lastActivityAt) > stallTimeoutMs
//   heartbeat NÃO conta como atividade (um run travado tem
//   heartbeat vivo — o que revela o congelamento é a ausência de
//   ATIVIDADE REAL: passos de agente, estágios, execuções).
// ============================================================

export interface StallWatchdogDecision {
  /** true → matar o run com TIMEOUT. */
  stalled: boolean
  /** Milissegundos desde a última atividade real. */
  silentMs: number
}

/**
 * Decisão do watchdog — PURA:
 *   stalled = (now - lastActivity) > stallTimeoutMs
 */
export function stallWatchdogDecision(input: {
  lastActivityAtMs: number
  nowMs: number
  stallTimeoutMs: number
}): StallWatchdogDecision {
  const silentMs = Math.max(0, input.nowMs - input.lastActivityAtMs)
  return { stalled: silentMs > input.stallTimeoutMs, silentMs }
}

// ---------- REGISTRY DE ATIVIDADE (AgentRunner → watchdog) ----------

/** touch() do watchdog ativo de cada run (limpo no stop). */
const touchRegistry = new Map<string, () => void>()

/** Registra a atividade de um agente em nome do run Poskli dele.
 *  Chamado a cada passo do AgentRunner (sem contexto do orquestrador
 *  — a ligação é o poskliRunId do input). Silencioso sem watchdog. */
export function touchPoskliActivity(poskliRunId: string | undefined | null): void {
  if (!poskliRunId) return
  try {
    touchRegistry.get(poskliRunId)?.()
  } catch {
    /* best-effort: atividade nunca derruba o agente */
  }
}

/** (runtime) registra o touch de um run no registry. */
export function registerTouch(runId: string, touch: () => void): void {
  touchRegistry.set(runId, touch)
}

/** (runtime) remove o registro do run (stop/kill). */
export function unregisterTouch(runId: string): void {
  touchRegistry.delete(runId)
}

/** (testes) tamanho do registry — verificação de limpeza. */
export function touchRegistrySize(): number {
  return touchRegistry.size
}
