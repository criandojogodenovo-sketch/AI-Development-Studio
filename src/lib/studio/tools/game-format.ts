// ============================================================
// TOOLS / GODOT FORMAT (NÚCLEO PURO)
// Resumo honesto da saída do Godot headless: erros de script/parse
// são o sinal útil; o resto é ruído.
//
// ZERO imports de runtime — testável isoladamente com node:test.
// ============================================================

const MAX_GODOT_OUTPUT_CHARS = 2000

export interface GodotCheckSummary {
  hasErrors: boolean
  errorCount: number
  text: string
}

/** Extrai linhas de erro reais da saída do Godot (SCRIPT ERROR,
 *  PARSE ERROR, ERROR) — ignora warnings/ruído de render. */
export function summarizeGodotOutput(stdout: string, stderr: string): GodotCheckSummary {
  const lines = `${stdout}\n${stderr}`.split('\n')
  const isNoise = (l: string) =>
    /^\s*$/.test(l) ||
    /Godot Engine|OpenGL|Vulkan|Devices|CUDA|NVIDIA GL|Bluetooth|joypad|Input buffer/i.test(l)

  const errorLines = lines.filter((l) => /SCRIPT ERROR|PARSE ERROR|^ERROR:|Cannot|Could not|Failed|expected|Unexpected/i.test(l))
  const errors = errorLines.slice(0, 12)

  let text: string
  if (errors.length > 0) {
    text = `ERROS DETECTADOS (${errors.length}+):\n${errors.join('\n')}`
  } else {
    text = 'GODOT OK: projeto carregado sem erros de script/parse'
  }

  if (text.length > MAX_GODOT_OUTPUT_CHARS) {
    text = text.slice(0, MAX_GODOT_OUTPUT_CHARS) + '\n...[saída truncada]'
  }
  return { hasErrors: errors.length > 0, errorCount: errors.length, text }
}

/** Mensagem honesta quando a CLI não está disponível no executor. */
export function godotUnavailableMessage(detail: string): string {
  return (
    'GODOT_INDISPONÍVEL: a CLI do Godot NÃO está instalada neste executor ' +
    `(detalhe: ${detail.slice(0, 200)}).\n` +
    'O projeto Godot continua válido como entregável (abra no Godot 4 localmente para rodar/exportar). ' +
    'NÃO tente simular o Godot com JS nem gerar um jogo paralelo. ' +
    'Valide o que for possível por estrutura (project.godot, cenas .tscn, scripts .gd) e ' +
    'DOCUMENTE no resultado que a validação headless não pôde executar neste ambiente.'
  )
}
