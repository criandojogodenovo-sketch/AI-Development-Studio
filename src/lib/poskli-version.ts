// ============================================================
// POSKLI VERSION (client-side) — opções do SELETOR DE MODELOS
// ============================================================
// Fonte única das opções exibidas no Command Center (PoskliPanel) e
// na aba Models. A escolha é persistida em localStorage e enviada ao
// backend no corpo (`poskliVersion`) e header (`x-poskli-version`) de
// todas as chamadas que envolvem o Poskli; o backend valida contra a
// lista server-side (chain.ts) — a env POSKLI_VERSION continua como
// fallback quando nada é enviado.
// ============================================================

export const POSKLI_VERSION_STORAGE_KEY = 'poskli-version'

export interface PoskliVersionOption {
  value: string
  /** rótulo curto exibido no seletor */
  short: string
  /** descrição exibida na lista suspensa */
  detail: string
  /** descrição longa (tooltip/legenda) */
  description: string
  /** true = Experiential exclusivo (badge violeta) */
  explabsExclusive: boolean
}

export const POSKLI_VERSION_OPTIONS: readonly PoskliVersionOption[] = [
  {
    value: '0.1',
    short: '0.1 · legado B.AI',
    detail: 'apenas B.AI',
    description: 'Versão legada — apenas o gateway B.AI (GLM/Qwen/Hy3).',
    explabsExclusive: false,
  },
  {
    value: '0.2',
    short: '0.2 · B.AI + NVIDIA',
    detail: 'B.AI → NVIDIA (padrão)',
    description: 'B.AI prioritário com failover para NVIDIA (429 nunca faz failover).',
    explabsExclusive: false,
  },
  {
    value: '0.3.1',
    short: '0.3.1 · 3 providers',
    detail: 'B.AI → NVIDIA → Experiential',
    description: 'B.AI → NVIDIA, com Experiential somente em tarefas difíceis.',
    explabsExclusive: false,
  },
  {
    value: '1.0-flash',
    short: '1.0 Flash · NVIDIA',
    detail: 'NVIDIA prioritário → Experiential → B.AI',
    description: 'NVIDIA prioritário; Experiential no meio; B.AI como reserva.',
    explabsExclusive: false,
  },
  {
    value: 'expposkli-1.0',
    short: 'expposkli-1.0 · Experiential',
    detail: 'Experiential exclusivo',
    description: 'Exclusivo Experiential: gpt-6-astra (fallback aion-2.0), claude-fable-5.1, aion-2.0.',
    explabsExclusive: true,
  },
  {
    value: 'expposkli-1.1',
    short: 'expposkli-1.1 · Experiential',
    detail: 'Experiential exclusivo',
    description: 'Exclusivo Experiential: claude-fable-5.1 (fallback gpt-6-astra), aion-2.0, aion-2.0.',
    explabsExclusive: true,
  },
] as const

/** Lê a versão persistida (localStorage); null se nunca escolheu. */
export function readStoredPoskliVersion(): string | null {
  if (typeof window === 'undefined') return null
  const v = (localStorage.getItem(POSKLI_VERSION_STORAGE_KEY) ?? '').trim()
  if (!v) return null
  return POSKLI_VERSION_OPTIONS.some((o) => o.value === v) ? v : null
}

/** Persiste a versão escolhida (valor inválido é ignorado). */
export function storePoskliVersion(version: string): void {
  if (typeof window === 'undefined') return
  if (!POSKLI_VERSION_OPTIONS.some((o) => o.value === version)) return
  localStorage.setItem(POSKLI_VERSION_STORAGE_KEY, version)
}

/** Opção pelo valor (null se desconhecida). */
export function poskliVersionOption(version: string): PoskliVersionOption | null {
  return POSKLI_VERSION_OPTIONS.find((o) => o.value === version) ?? null
}
