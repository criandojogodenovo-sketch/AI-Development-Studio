// ============================================================
// POSKLI / TOON — formato compacto de comunicação agente↔agente
// ============================================================
// TOON substitui o JSON nas mensagens entre o master e os
// subagentes e no fast-plan. Uma spec de tarefa com ~450 chars
// em JSON passa a ~180 chars em TOON (−40 a −60% tokens).
//
// Formato (UMA linha, registos `chave:valor` separados por |):
//   t:<intent> | k:<kind> | d:<difficulty> | l:<lang> | f:<files> | n:<notes>
//
// Chaves:
//   t = intenção da tarefa (uma linha curta, objetivo do usuário)
//   k = tipo de tarefa      (web | logic | research | chat | generic)
//   d = dificuldade         (simple | medium | hard | complex)
//   l = idioma do usuário   (pt | en | es | …)
//   f = ficheiros envolvidos (vírgulas; omitido se vazio)
//   n = notas/restrições    (vírgulas; omitido se vazio)
//
// O output É SEMPRE uma linha única ASCII-safe (split por | e :).
// ZERO imports → testável com node:test.
// ============================================================

export type Difficulty = 'simple' | 'medium' | 'hard' | 'complex'
export type TaskKind = 'web' | 'logic' | 'research' | 'chat' | 'generic'

export interface ToonTask {
  intent: string
  kind: TaskKind
  difficulty: Difficulty
  lang: string
  files: string[]
  notes: string[]
}

const MAX_INTENT = 120
const MAX_NOTE = 60
const MAX_NOTES = 4

/** Palavras que sinalizam tarefa de web/frontend. */
const WEB_HINTS = [
  'site', 'website', 'página', 'pagina', 'page', 'landing', 'web',
  'app', 'frontend', 'ui', 'blog', 'portfólio', 'portfolio', 'dashboard',
  'html', 'css', 'componente', 'component', 'loja', 'formulário', 'formulario',
]

/** Palavras que sinalizam pesquisa / recuperação de informação. */
const RESEARCH_HINTS = [
  'pesquisa', 'pesquisar', 'pesquise', 'search', 'find', 'encontra',
  'procura', 'investiga', 'analisa', 'analise', 'compara', 'estuda',
  'study', 'trends', 'tendências', 'tendencias', 'notícias', 'noticias',
  'news', 'referências', 'referencias', 'inspiração', 'inspiracao', 'benchmark',
]

/** Palavras que sinalizam lógica pura / trabalho algorítmico. */
const LOGIC_HINTS = [
  'algoritmo', 'algorithm', 'lógica', 'logica', 'logic', 'cálculo',
  'calculo', 'calc', 'fórmula', 'formula', 'função', 'funcao',
  'refatora', 'refactor', 'otimiza', 'optimize', 'bug', 'corrige',
  'performance', 'parse', 'valida', 'schema', 'state machine', 'regex',
]

/** Verbos que marcam um pedido ACIONÁVEL (vs mensagem conversacional). */
const ACTION_VERBS = [
  'cria', 'criar', 'crie', 'faz', 'fazer', 'faça', 'faca', 'constrói',
  'construir', 'construi', 'desenvolve', 'desenvolver', 'implementa',
  'implementar', 'implemente', 'corrige', 'corrigir', 'corrija', 'refaz',
  'refactor', 'refatora', 'muda', 'mudar', 'altera', 'alterar', 'adiciona',
  'adicionar', 'adicione', 'remove', 'remover', 'apaga', 'apagar',
  'gera', 'gerar', 'gere', 'escreve', 'escrever', 'escreva', 'cria-me',
  'faz-me', 'create', 'make', 'build', 'write', 'implement', 'add',
  'remove', 'fix', 'generate', 'design', 'monta', 'montar', 'monte',
  'atualiza', 'atualizar', 'update', 'translate', 'traduz', 'converte',
  'converter', 'move', 'mover', 'instala', 'install', 'mostra', 'mostrar',
  'exibe', 'exibir', 'abre', 'abrir', 'roda', 'rodar', 'executa',
  'executar', 'testa', 'testar', 'publica', 'publicar', 'deploy',
]

function countMatches(lower: string, hints: readonly string[]): number {
  let n = 0
  for (const hint of hints) {
    if (lower.includes(hint)) n += 1
  }
  return n
}

/** Deteta o idioma do usuário a partir do texto do pedido. */
export function detectLang(request: string): string {
  const t = request.toLowerCase()
  // 1) acentos portugueses → sinal forte de PT
  if (/[áàâãéêíóôõúç]/.test(t)) return 'pt'
  // 2) palavras funcionais inglesas (fortes, sem colisão com PT)
  if (/\b(website|about|the|and|with|please|create|make|build|write|app|page|landing)\b/.test(t)) return 'en'
  // 3) palavras funcionais portuguesas
  if (/\b(um|uma|de|do|da|para|sobre|com|nao|não|me|faz|fazer|cria|criar|site|página|pagina|jogo|quero)\b/.test(t)) return 'pt'
  // 4) espanhol
  if (/\b(el|la|los|las|un|una|hacer|crea|quiero)\b/.test(t)) return 'es'
  return 'en'
}

/** Deteta o tipo de tarefa por densidade de palavras-chave. */
export function detectKind(request: string): TaskKind {
  const t = request.toLowerCase()
  const web = countMatches(t, WEB_HINTS)
  const research = countMatches(t, RESEARCH_HINTS)
  const logic = countMatches(t, LOGIC_HINTS)
  if (research > web && research > logic) return 'research'
  if (web >= 1 && web >= logic) return 'web'
  if (logic >= 1) return 'logic'
  return 'generic'
}

/** Deteta a dificuldade: heurística sobre tamanho, amplitude e marcadores. */
export function detectDifficulty(request: string): Difficulty {
  const t = request.toLowerCase()
  const words = t.split(/\s+/).filter(Boolean).length

  const parts = countMatches(t, [
    ' e ', ' com ', ' depois ', ' também ', 'tambem', ' then ', ' and ',
    ' além ', 'alem', 'plus', ' depois disso', ' em seguida',
  ])
  const integrations = countMatches(t, [
    'api', 'base de dados', 'database', 'postgres', 'login', 'autenticação',
    'autenticacao', 'auth', 'payment', 'pagamento', 'stripe', 'websocket',
    'real-time', 'tempo real', 'integra', 'integrar', 'cron', 'email',
    'deploy', 'docker',
  ])
  const research = countMatches(t, RESEARCH_HINTS)

  let score = 0
  if (words > 12) score += 1
  if (words > 30) score += 1
  score += Math.min(parts, 2)
  score += Math.min(integrations, 2)
  if (research >= 2) score += 1
  if (/\b(multi|vários|varios|multi-|complexo|completa|completo|full|avançado|avancado)\b/.test(t)) score += 1

  if (score <= 1) return 'simple'
  if (score <= 3) return 'medium'
  if (score <= 5) return 'hard'
  return 'complex'
}

/** true quando a mensagem NÃO tem verbo de ação → Modo Conversa. */
export function isConversational(request: string): boolean {
  const t = request.toLowerCase()
  return countMatches(t, ACTION_VERBS) === 0
}

/** Extrai a linha de intenção: remove saudações/filler, limita tamanho. */
export function extractIntent(request: string): string {
  let intent = request.trim()
  intent = intent.replace(
    /^(olá|ola|hi|hello|hey|bom dia|boa tarde|boa noite|por favor|please|podes|pode|poderias|poderia|podias|gostaria de|quero que|preciso que|quero|preciso de)[,!\s]+/i,
    '',
  )
  intent = intent.replace(/\s+/g, ' ')
  if (intent.length > MAX_INTENT) {
    intent = intent.slice(0, MAX_INTENT - 1).trimEnd() + '…'
  }
  return intent
}

const FILE_PATTERN = /[\w./-]+\.(html|css|js|jsx|ts|tsx|json|md|py|sql|yml|yaml|env|txt|svg|png|jpg)/gi

/** Extrai nomes de ficheiros mencionados no pedido. */
export function extractFiles(request: string): string[] {
  const matches = request.match(FILE_PATTERN) ?? []
  return Array.from(new Set(matches.map((m) => m.toLowerCase()))).slice(0, 8)
}

function sanitize(value: string): string {
  return value.replace(/[|\n\r:]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Constrói o objeto ToonTask a partir do pedido livre do usuário. */
export function buildToonTask(request: string): ToonTask {
  return {
    intent: sanitize(extractIntent(request)),
    kind: detectKind(request),
    difficulty: detectDifficulty(request),
    lang: detectLang(request),
    files: extractFiles(request),
    notes: [],
  }
}

/** Serializa um ToonTask na linha compacta TOON. */
export function toonToString(task: ToonTask): string {
  const parts: string[] = [
    `t:${sanitize(task.intent)}`,
    `k:${task.kind}`,
    `d:${task.difficulty}`,
    `l:${task.lang}`,
  ]
  if (task.files.length > 0) {
    parts.push(`f:${task.files.map(sanitize).join(',')}`)
  }
  if (task.notes.length > 0) {
    parts.push(`n:${task.notes.slice(0, MAX_NOTES).map((note) => sanitize(note).slice(0, MAX_NOTE)).join(',')}`)
  }
  return parts.join('|')
}

/**
 * parseRequestToTOON — entry point principal.
 * Converte o pedido livre do usuário numa linha TOON compacta usada
 * pelo master no plano e nas mensagens aos subagentes (−30 a −50%
 * de tokens vs JSON equivalente).
 */
export function parseRequestToTOON(userRequest: string): string {
  return toonToString(buildToonTask(userRequest))
}

/** Faz o parse de uma linha TOON de volta para ToonTask (lado do subagente). */
export function parseToon(line: string): ToonTask {
  const record: Partial<Record<string, string>> = {}
  for (const chunk of line.split('|')) {
    const idx = chunk.indexOf(':')
    if (idx <= 0) continue
    const key = chunk.slice(0, idx).trim()
    const value = chunk.slice(idx + 1).trim()
    record[key] = value
  }
  return {
    intent: record['t'] ?? '',
    kind: (record['k'] as TaskKind) ?? 'generic',
    difficulty: (record['d'] as Difficulty) ?? 'simple',
    lang: record['l'] ?? 'en',
    files: record['f'] ? record['f'].split(',').filter(Boolean) : [],
    notes: record['n'] ? record['n'].split(',').filter(Boolean) : [],
  }
}

/** Comparação de tamanho JSON vs TOON (testes + telemetria). */
export function toonSavings(json: string, toon: string): number {
  return 1 - toon.length / Math.max(json.length, 1)
}
