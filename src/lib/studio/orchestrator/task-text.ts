// ============================================================
// ORCHESTRATOR / TASK TEXT (NÚCLEO PURO)
// Normalização de texto de tarefas vindas do LLM.
//
// PROBLEMA (bug de serialização): o plano JSON do planejador às
// vezes traz `description`/`title` como OBJETO ({"text": "..."},
// listas, etc.). `String(obj)` → "[object Object]" gravado no DB
// e exibido no painel. Este módulo achata QUALQUER valor em texto
// legível antes da persistência.
//
// ZERO imports de runtime — testável isoladamente com node:test.
// ============================================================

/** Campos preferidos quando o valor é um objeto (em ordem). */
const PREFERRED_FIELDS = [
  'description', 'text', 'summary', 'desc', 'instruction', 'instructions',
  'details', 'value', 'content', 'name', 'title',
] as const

const MAX_FALLBACK_JSON_CHARS = 600

/**
 * Converte qualquer valor do plano do LLM em texto legível:
 * - string → própria string
 * - número/boolean → representação
 * - array → itens unidos com "; "
 * - objeto → campo preferido (recursivo) ou JSON legível
 * - null/undefined → ''
 * NUNCA devolve "[object Object]".
 */
export function taskText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    return v
      .map((item) => taskText(item))
      .filter((s) => s.trim().length > 0)
      .join('; ')
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>
    let hasPreferredKey = false
    for (const key of PREFERRED_FIELDS) {
      const val = obj[key]
      if (val === undefined) continue
      hasPreferredKey = true
      if (typeof val === 'string' && val.trim()) return val
      if (val !== null && val !== undefined && typeof val === 'object') {
        const nested = taskText(val)
        if (nested.trim()) return nested
      }
    }
    // objeto tem campos preferidos mas todos vazios → nada útil
    if (hasPreferredKey) return ''
    // último recurso: JSON legível (nunca [object Object])
    try {
      const json = JSON.stringify(v)
      return typeof json === 'string' ? json.slice(0, MAX_FALLBACK_JSON_CHARS) : ''
    } catch {
      return ''
    }
  }
  return String(v)
}

/** Título de tarefa normalizado (não vazio; fallback numérico). */
export function taskTitle(v: unknown, fallbackOrder: number): string {
  const t = taskText(v).trim()
  return t || `Tarefa ${fallbackOrder + 1}`
}

/** true se o texto parece ser o artefato de coerção padrão. */
export function isObjectCoercionArtifact(s: string): boolean {
  return s.trim() === '[object Object]'
}
