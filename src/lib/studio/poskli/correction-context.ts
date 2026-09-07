// ============================================================
// POSKLI / CORRECTION CONTEXT (NÚCLEO PURO)
// ============================================================
// FASE 2 da auditoria — teste exigido: "correções NUNCA reenviam
// o código completo". O contexto da correção agêntica é montado
// a partir de: comando de testes + hints de falha (linhas de
// erro) + DIFF do workspace (linhas alteradas) — NUNCA o
// conteúdo integral de arquivos.
//
// Extraído do orchestrator.ts para ser testável com node:test.
// ZERO imports de runtime.
// ============================================================

export interface CorrectionContextInput {
  command: string
  failureHints: string
  diff: string
}

/** Instrução anti-reenvio (linha dura do protocolo de correção). */
export const NO_FULL_RESEND_INSTRUCTION =
  'Edite DIRETAMENTE as linhas que causam a falha: use modify_file com trechos pequenos (searchText/replaceText). ' +
  'NÃO reescreva arquivos inteiros nem reenvie código completo.'

/** Título do bloco de falha. */
export const FAILURE_BLOCK_TITLE = '## FALHA DOS TESTES (resumo)'

/** Título do bloco de diff. */
export const DIFF_BLOCK_TITLE = '## DIFF DO ESTADO ATUAL (linhas alteradas)'

/**
 * Monta o contexto de correção — SÓ resumo + diff:
 *   1. FALHA DOS TESTES: comando + linhas de erro (já clipadas)
 *   2. DIFF: apenas linhas alteradas (git diff --unified=1)
 *   3. Instrução: modify_file cirúrgico, nunca código completo
 */
export function buildCorrectionContext(input: CorrectionContextInput): string {
  return [
    FAILURE_BLOCK_TITLE,
    `Comando: ${input.command}`,
    '',
    input.failureHints,
    '',
    DIFF_BLOCK_TITLE,
    input.diff,
    '',
    NO_FULL_RESEND_INSTRUCTION,
  ].join('\n')
}

/**
 * Verificação (usada em testes/auditoria): o contexto de correção
 * NÃO contém conteúdo integral de arquivos — heurística: nenhum
 * bloco de código com > 120 linhas e sempre inclui a instrução
 * anti-reenvio e o diff (marcador de escopo cirúrgico).
 */
export function isSurgicalCorrectionContext(context: string): boolean {
  if (!context.includes(NO_FULL_RESEND_INSTRUCTION)) return false
  if (!context.includes(DIFF_BLOCK_TITLE)) return false
  // bloco de código gigante = reenvio de arquivo inteiro
  for (const block of context.matchAll(/```[\s\S]*?```/g)) {
    if (block[0].split('\n').length > 120) return false
  }
  return true
}
