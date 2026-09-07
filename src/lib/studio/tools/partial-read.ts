// ============================================================
// TOOLS / PARTIAL READ (NÚCLEO PURO) — leitura por linhas exatas
// ============================================================
// Ler arquivos INTEIROS queima contexto. As tools read_head /
// read_range / read_tail leem exatamente as linhas necessárias e
// SEMPRE truncam o output a 2.000 chars — um resultado de tool
// nunca sopra o orçamento do subagente.
//
// Linhas 1-based (estilo editor):
//   read_head(path, 50)       → linhas 1..50
//   read_range(path, 20, 80)  → linhas 20..80 (inclusivo)
//   read_tail(path, 50)       → últimas 50 linhas
//
// ZERO imports de runtime → testável com node:test.
// ============================================================

export const MAX_OUTPUT_CHARS = 2000
export const DEFAULT_LINES = 50

export interface PartialReadResult {
  ok: boolean
  range: string // ex.: "12-64" (1-based)
  totalLines: number
  truncated: boolean
  /** Linhas numeradas "N\tlinha" (já truncado a 2000 chars). */
  content: string
}

function truncate(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_OUTPUT_CHARS) {
    return { text: content, truncated: false }
  }
  const cut = content.slice(0, MAX_OUTPUT_CHARS)
  // prefere cortar em fronteira de linha (numeração legível)
  const lastNewline = cut.lastIndexOf('\n')
  const text =
    (lastNewline > MAX_OUTPUT_CHARS * 0.7 ? cut.slice(0, lastNewline) : cut) +
    `\n[...truncado em ${MAX_OUTPUT_CHARS} chars]`
  return { text, truncated: true }
}

function numberLines(lines: readonly string[], startLine: number): string {
  return lines.map((line, i) => `${startLine + i}\t${line}`).join('\n')
}

/** Valida o intervalo pedido (1 <= start <= end). */
export function validRange(startLine: number, endLine: number): boolean {
  return (
    Number.isFinite(startLine) &&
    Number.isFinite(endLine) &&
    Math.floor(startLine) >= 1 &&
    Math.floor(endLine) >= Math.floor(startLine)
  )
}

/** read_head sobre o CONTEÚDO já lido (disco ou DB). */
export function sliceHead(content: string, lines = DEFAULT_LINES): PartialReadResult {
  const all = content.split('\n')
  const count = Math.max(1, Math.min(Math.floor(lines) || DEFAULT_LINES, all.length))
  const { text, truncated } = truncate(numberLines(all.slice(0, count), 1))
  return { ok: true, range: `1-${count}`, totalLines: all.length, truncated, content: text }
}

/** read_range sobre o CONTEÚDO já lido (disco ou DB). */
export function sliceRange(content: string, startLine: number, endLine: number): PartialReadResult {
  if (!validRange(startLine, endLine)) {
    return {
      ok: false,
      range: `${startLine}-${endLine}`,
      totalLines: 0,
      truncated: false,
      content: `ERRO: intervalo inválido (esperado 1 <= startLine <= endLine, recebido ${startLine}-${endLine}).`,
    }
  }
  const all = content.split('\n')
  const start = Math.max(1, Math.floor(startLine))
  const end = Math.min(Math.floor(endLine), all.length)
  if (end < start) {
    return {
      ok: false,
      range: `${startLine}-${endLine}`,
      totalLines: all.length,
      truncated: false,
      content: `ERRO: o arquivo tem ${all.length} linhas; o intervalo ${startLine}-${endLine} está fora dos limites.`,
    }
  }
  const { text, truncated } = truncate(numberLines(all.slice(start - 1, end), start))
  return { ok: true, range: `${start}-${end}`, totalLines: all.length, truncated, content: text }
}

/** read_tail sobre o CONTEÚDO já lido (disco ou DB). */
export function sliceTail(content: string, lines = DEFAULT_LINES): PartialReadResult {
  const all = content.split('\n')
  const count = Math.max(1, Math.min(Math.floor(lines) || DEFAULT_LINES, all.length))
  const start = all.length - count + 1
  const { text, truncated } = truncate(numberLines(all.slice(start - 1), start))
  return { ok: true, range: `${start}-${all.length}`, totalLines: all.length, truncated, content: text }
}

/** Formato compacto do resultado (o que o LLM vê). */
export function formatPartialRead(path: string, result: PartialReadResult): string {
  if (!result.ok) return result.content
  return `${path} [linhas ${result.range} de ${result.totalLines}]\n${result.content}`
}
