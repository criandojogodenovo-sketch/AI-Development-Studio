// ============================================================
// CONTEXT / COMPACTION (NÚCLEO PURO)
// Compactação automática de contexto a 75% da janela —
// como o Claude Code/Codex: PRESERVA O ESTADO (o que foi feito,
// o que falta) em vez de só resumir narrativamente.
//
// Evita o bug clássico: compactação que transforma planos
// CONCLUÍDOS em "trabalho pendente" → agente repete tudo.
// ZERO imports de runtime — testável com node:test.
// ============================================================

export type CompactionRole = 'system' | 'user' | 'assistant'

export interface CompactionMessage {
  role: CompactionRole
  content: string
}

export interface AgentStepLike {
  tool?: string
  args?: Record<string, unknown>
  observation?: string
  ok?: boolean
}

export interface AgentProgressState {
  /** Arquivos criados/editados (em ordem, sem duplicatas). */
  filesTouched: string[]
  /** Execuções de teste rodadas pelo agente. */
  testRuns: number
  /** Último resultado de testes conhecido (null = não rodou). */
  lastTestPassed: boolean | null
  /** Total de passos executados. */
  steps: number
  /** Última tool executada (para retomar o fio). */
  lastTool: string | null
}

/** Estimativa simples e determinística: ~4 chars por token. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4)
}

/** Tokens totais de uma conversa (system + user + assistant). */
export function conversationTokens(messages: CompactionMessage[]): number {
  return messages.reduce((acc, m) => acc + estimateTokens(m.content), 0)
}

/** Deve compactar? (janela × ratio, default 0.75). */
export function shouldAutoCompact(
  messages: CompactionMessage[],
  windowTokens: number,
  ratio = 0.75
): boolean {
  if (messages.length === 0 || windowTokens <= 0) return false
  return conversationTokens(messages) >= Math.floor(windowTokens * ratio)
}

const FILE_WRITE_TOOLS = new Set(['create_file', 'modify_file'])
const TEST_TOOLS = new Set(['run_tests', 'godot_check'])

/** Extrai o ESTADO REAL do progresso a partir dos passos do agente. */
export function agentProgressFromSteps(steps: AgentStepLike[]): AgentProgressState {
  const files: string[] = []
  let testRuns = 0
  let lastTestPassed: boolean | null = null
  let lastTool: string | null = null

  for (const s of steps) {
    if (!s.tool) continue
    lastTool = s.tool
    const filePath = typeof s.args?.path === 'string' ? s.args.path : null
    if (FILE_WRITE_TOOLS.has(s.tool) && s.ok !== false && filePath && !files.includes(filePath)) {
      files.push(filePath)
    }
    if (TEST_TOOLS.has(s.tool)) {
      testRuns++
      const obs = s.observation ?? ''
      if (/PASSARAM|TESTES_PASSARAM|GODOT OK|tests \d+ pass/i.test(obs)) lastTestPassed = true
      else if (/FALHARAM|TESTES_FALHARAM|GODOT FALHOU|fail \d+/i.test(obs)) lastTestPassed = false
    }
  }

  return {
    filesTouched: files.slice(-15),
    testRuns,
    lastTestPassed,
    steps: steps.length,
    lastTool,
  }
}

/** Renderiza o bloco de estado preservado (injetado na compactação). */
export function renderStateBlock(progress: AgentProgressState, pendingHint?: string): string {
  const lines: string[] = [
    '[COMPACTAÇÃO AUTOMÁTICA — ESTADO PRESERVADO]',
    `Passos executados: ${progress.steps}.`,
  ]
  if (progress.filesTouched.length > 0) {
    lines.push(`ARQUIVOS JÁ CRIADOS/EDITADOS (NÃO refazer): ${progress.filesTouched.join(', ')}`)
  } else {
    lines.push('Nenhum arquivo criado/editado ainda.')
  }
  if (progress.testRuns > 0) {
    const st =
      progress.lastTestPassed === true ? 'última PASS' : progress.lastTestPassed === false ? 'última FAIL' : 'resultado desconhecido'
    lines.push(`Testes já executados: ${progress.testRuns}x (${st}).`)
  } else {
    lines.push('Testes ainda não executados.')
  }
  if (pendingHint) lines.push(pendingHint)
  lines.push('Retome EXATAMENTE de onde parou — não repita trabalho já concluído.')
  return lines.join('\n')
}

/**
 * Compacta a conversa: mantém system + objetivo original,
 * injeta o bloco de ESTADO e preserva os últimos N turnos.
 * O resumo narrativo antigo é substituído pelo estado estruturado.
 */
export function compactConversation(
  messages: CompactionMessage[],
  opts: { keepLastTurns: number; progress: AgentProgressState; pendingHint?: string }
): CompactionMessage[] {
  if (messages.length <= 2) return messages

  const system = messages[0]
  const objective = messages[1]
  const stateBlock = renderStateBlock(opts.progress, opts.pendingHint)

  const keep = Math.max(0, Math.min(opts.keepLastTurns, messages.length - 2))
  // slice(-0) devolveria o array INTEIRO — guardar explicitamente
  const recent = keep > 0 ? messages.slice(-keep) : []

  const compacted: CompactionMessage[] = [system, objective]
  compacted.push({
    role: 'user',
    content: `${stateBlock}\n(mensagens antigas foram compactadas para poupar contexto — o estado acima é a verdade)`,
  })
  return [...compacted, ...recent]
}
