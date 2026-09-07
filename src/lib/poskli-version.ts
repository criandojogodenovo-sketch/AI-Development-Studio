// ============================================================
// POSKLI VERSION (client-side) — MODOS do seletor
// ============================================================
// Fonte única das opções exibidas no Command Center (PoskliPanel).
// A escolha é persistida em localStorage e enviada ao backend no
// corpo (`poskliVersion`) e header (`x-poskli-version`) de todas
// as chamadas que envolvem o Poskli; o backend valida contra a
// lista server-side (chain.ts) — a env POSKLI_VERSION continua
// como fallback quando nada é enviado.
//
// RECONSTRUÇÃO AGÊNTICA: o usuário final vê MODOS com papéis
// (não nomes técnicos de modelos — "níveis" 0.1/0.2/… são
// detalhe interno; os values seguem válidos para o backend):
//   Normal      → 0.1     Padrão      → 0.2
//   Avançado    → 0.3.1   Superagente → superagent (badge violeta)
// Valores antigos no localStorage (ex.: "1.0-flash", "expposkli-*")
// são ignorados na leitura (voltam ao default do servidor).
// ============================================================

export const POSKLI_VERSION_STORAGE_KEY = 'poskli-version'

export interface PoskliVersionOption {
  value: string
  /** rótulo curto exibido no seletor (nome do MODO) */
  short: string
  /** descrição exibida na lista suspensa (papéis, sem nomes técnicos) */
  detail: string
  /** descrição longa (tooltip/legenda) */
  description: string
  /** true = destaque (badge violeta) — superagent */
  highlight: boolean
}

export const POSKLI_VERSION_OPTIONS: readonly PoskliVersionOption[] = [
  {
    value: '0.1',
    short: 'Normal',
    detail: 'leve e rápido',
    description:
      'Modo leve: agente de planeamento, agente de código e agente de verificação econômicos — ideal para pedidos simples e rápidos, sem reservas externas.',
    highlight: false,
  },
  {
    value: '0.2',
    short: 'Padrão',
    detail: 'equilibrado (recomendado)',
    description:
      'Modo padrão: planeamento forte, código ágil e verificação de qualidade — com reserva técnica automática se um dos agentes ficar indisponível.',
    highlight: false,
  },
  {
    value: '0.3.1',
    short: 'Avançado',
    detail: 'verificação reforçada',
    description:
      'Modo avançado: verificação independente reforçada e plano B imediato quando um agente atinge limites de uso — para trabalho mais exigente.',
    highlight: false,
  },
  {
    value: 'superagent',
    short: 'Superagente',
    detail: 'dupla de implementação',
    description:
      'Superagente: dupla de implementação trabalhando em sequência com falência gradual — para pedidos difíceis que precisam de mais força.',
    highlight: true,
  },
] as const

/** Lê o modo persistido (localStorage); null se nunca escolheu/inválido. */
export function readStoredPoskliVersion(): string | null {
  if (typeof window === 'undefined') return null
  const v = (localStorage.getItem(POSKLI_VERSION_STORAGE_KEY) ?? '').trim()
  if (!v) return null
  return POSKLI_VERSION_OPTIONS.some((o) => o.value === v) ? v : null
}

/** Persiste o modo escolhido (valor inválido é ignorado). */
export function storePoskliVersion(version: string): void {
  if (typeof window === 'undefined') return
  if (!POSKLI_VERSION_OPTIONS.some((o) => o.value === version)) return
  localStorage.setItem(POSKLI_VERSION_STORAGE_KEY, version)
}

/** Opção pelo valor (null se desconhecida). */
export function poskliVersionOption(version: string): PoskliVersionOption | null {
  return POSKLI_VERSION_OPTIONS.find((o) => o.value === version) ?? null
}
