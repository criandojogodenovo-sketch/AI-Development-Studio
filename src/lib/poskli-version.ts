// ============================================================
// POSKLI VERSION (client-side) — opções do SELETOR DE MODELOS
// ============================================================
// Fonte única das opções exibidas no Command Center (PoskliPanel) e
// na aba Models. A escolha é persistida em localStorage e enviada ao
// backend no corpo (`poskliVersion`) e header (`x-poskli-version`) de
// todas as chamadas que envolvem o Poskli; o backend valida contra a
// lista server-side (chain.ts) — a env POSKLI_VERSION continua como
// fallback quando nada é enviado.
//
// Tarefa C: Experiential ELIMINADA — expposkli-1.0/1.1 removidas;
// nova versão superagent (badge violeta) com dupla de coding.
// Valores antigos persistidos no localStorage (ex.: "expposkli-1.0")
// são ignorados na leitura (voltam ao default da env).
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
  /** true = destaque (badge violeta) — superagent */
  highlight: boolean
}

export const POSKLI_VERSION_OPTIONS: readonly PoskliVersionOption[] = [
  {
    value: '0.1',
    short: '0.1 · legado B.AI',
    detail: 'Qwen · Hy3 (só B.AI)',
    description:
      'Versão legada — apenas B.AI: master Qwen, coding Hy3, review Qwen. Sem failover externo.',
    highlight: false,
  },
  {
    value: '0.2',
    short: '0.2 · B.AI + NVIDIA',
    detail: 'B.AI → NVIDIA (padrão)',
    description:
      'Master GLM, coding Qwen, review Hy3 — NVIDIA como fallback de coding/review em falhas elegíveis.',
    highlight: false,
  },
  {
    value: '0.3.1',
    short: '0.3.1 · review NVIDIA',
    detail: 'Hy3 · Qwen→GLM · GPT-OSS',
    description:
      'Master Hy3, coding Qwen (GLM imediato em 429 — mesma conta), review GPT-OSS-20B (NVIDIA) com reserva GPT-5.6 Luna.',
    highlight: false,
  },
  {
    value: '1.0-flash',
    short: '1.0 Flash · NVIDIA',
    detail: 'NVIDIA prioritário → B.AI',
    description:
      'NVIDIA prioritário: master Nemotron, coding DeepSeek V4 Flash, review GPT-OSS-20B. 429 → 1 retry → B.AI como reserva.',
    highlight: false,
  },
  {
    value: 'superagent',
    short: 'superagent',
    detail: 'GLM · Hy3+Qwen · GPT-OSS',
    description:
      'Superagente: master GLM, coding DUPLA (Hy3 → Qwen em 429 → DeepSeek NVIDIA), review GPT-OSS-20B (NVIDIA) com reserva Luna.',
    highlight: true,
  },
] as const

/** Lê a versão persistida (localStorage); null se nunca escolheu/inválida. */
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
