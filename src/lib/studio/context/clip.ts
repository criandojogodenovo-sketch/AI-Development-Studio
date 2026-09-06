// ============================================================
// CLIP — truncagem de outputs (economia de tokens — Tarefa C §3d)
// NÚCLEO PURO (zero imports): importável por node:test.
//
// Outputs de ferramentas (run_tests, run_command, read_file, ...)
// são truncados para 2.000 caracteres ANTES de ir ao LLM, com o
// marcador no início: "[Output truncado - 2k chars]".
// ============================================================

/** Limite padrão de outputs de ferramenta enviados ao LLM. */
export const TOOL_OUTPUT_MAX_CHARS = 2000

/** Marcador prefixado quando o output é truncado. */
export const TOOL_OUTPUT_MARKER = '[Output truncado - 2k chars]'

/**
 * Trunca um output de ferramenta para `max` caracteres, prefixando
 * o marcador de truncagem. Outputs dentro do limite passam intactos.
 */
export function clipToolOutput(output: string, max: number = TOOL_OUTPUT_MAX_CHARS): string {
  if (output.length <= max) return output
  return `${TOOL_OUTPUT_MARKER}\n${output.slice(0, max)}`
}

/**
 * Trunca saída de testes para o contexto do agente (alias do
 * clipToolOutput — mesmo limite/marcador, Tarefa C).
 */
export function clipTestOutput(output: string, max: number = TOOL_OUTPUT_MAX_CHARS): string {
  return clipToolOutput(output, max)
}
