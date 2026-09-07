// ============================================================
// POSKLI ACTIVITY (client-safe, PURO) — atividade ao vivo
// ============================================================
// Traduz ações de ferramentas dos agentes (toolCalls) para
// linguagem de PRODUTO — "A criar arquivo…", "A executar
// testes…" — sem expor nomes técnicos de modelos/ferramentas.
// Testável com node:test (zero imports).
// ============================================================

export interface ActivityEntry {
  tool: string
  status: string
  createdAt: string
  path?: string
}

export interface ActivityItem {
  label: string
  detail?: string
  running: boolean
  failed: boolean
  asked: boolean
}

function filePathOf(entry: ActivityEntry): string | undefined {
  // args é Json no DB — o painel pré-extrai `path`/`query`/`command`
  // para este helper; caminho relativo curto é o detalhe útil
  const p = entry.path
  if (typeof p !== 'string' || !p) return undefined
  return p.length > 48 ? p.slice(0, 45) + '…' : p
}

/** Traduz uma ação de ferramenta para linguagem de produto. */
export function translateActivity(entry: ActivityEntry): ActivityItem {
  const failed = entry.status === 'ERROR' || entry.status === 'DENIED'
  const pending = entry.status === 'PENDING'
  const path = filePathOf(entry)

  const base = (() => {
    switch (entry.tool) {
      case 'create_file':
        return { label: 'A criar arquivo…', detail: path }
      case 'modify_file':
        return { label: 'A editar arquivo…', detail: path }
      case 'delete_file':
        return { label: 'A apagar arquivo…', detail: path }
      case 'create_directory':
        return { label: 'A criar pasta…', detail: path }
      case 'run_tests':
        return { label: 'A executar testes…' }
      case 'run_command':
        return { label: 'A executar comando…' }
      case 'read_file':
        return { label: 'A ler código…', detail: path }
      case 'search_code':
        return { label: 'A procurar no código…' }
      case 'list_files':
        return { label: 'A inspecionar o projeto…' }
      case 'get_project_status':
        return { label: 'A analisar o estado…' }
      case 'godot_check':
        return { label: 'A validar o jogo (Godot)…' }
      case 'ask_user_question':
        return { label: 'Aguardando sua resposta…' }
      case 'git_commit':
        return { label: 'A criar ponto de restauração…' }
      case 'git_status':
      case 'git_diff':
      case 'git_log':
        return { label: 'A comparar versões…' }
      case 'git_create_branch':
        return { label: 'A criar ramo de trabalho…' }
      case 'git_push':
        return { label: 'A publicar alterações…' }
      case 'github_create_branch':
        return { label: 'A preparar publicação…' }
      case 'create_pull_request':
        return { label: 'A abrir pedido de revisão…' }
      default:
        return { label: 'Trabalhando…' }
    }
  })()

  return {
    label: base.label,
    detail: base.detail,
    running: pending,
    failed,
    asked: entry.tool === 'ask_user_question' && pending,
  }
}

/** true se o label está em português e SEM nomes técnicos de modelos. */
export function isFriendlyActivityLabel(label: string): boolean {
  const technical = /(glm|qwen|hy3|nemotron|deepseek|gpt|luna|nvidia|b\.ai|provider)/i
  return label.length > 0 && !technical.test(label)
}
