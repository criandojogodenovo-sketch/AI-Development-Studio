// ============================================================
// INTENT ROUTER (PURO) — criação automática de projeto
// ============================================================
// Reconstrução conversacional: o usuário NUNCA escolhe o tipo de
// projeto num seletor. Ele escreve "Cria uma landing page" ou
// "Cria um jogo na Godot" e o AGENTE lê o contexto:
//
//   1. classificar a mensagem → template (confiante?)
//   2. confiante      → cria o projeto com o tipo detetado
//   3. ambíguo        → pergunta no chat (AskUserQuestion):
//                       "Queres que crie uma app web, mobile ou
//                        um jogo?" — o usuário responde e a
//                       conversa continua com o tipo resolvido.
//
// Puro (zero imports) → testável com node:test.
// ============================================================

export interface IntentClassification {
  /** Tipo de template (chave de TEMPLATES). */
  type: string
  /** true = o contexto foi suficiente para decidir sozinho. */
  confident: boolean
  /** Palavra/frase que fundamentou a decisão (evidência). */
  matched: string
}

export interface ClarifyChoice {
  label: string
  description?: string
}

export interface ClarifyQuestion {
  header: string
  question: string
  options: readonly ClarifyChoice[]
}

// ---------- classificação por contexto ----------

const GAME_RE = /\b(jogo|jogos|game|games|godot|arcade|plataforma|runner|sobreviv[êe]ncia|shooter|puzzle|tower defense|rpg|metroidvania)\b/i
const LANDING_RE = /\b(landing|p[áa]gina|paginas|site|sites|website|p[áa]ginas de vendas|one[- ]page|portf[óo]lio|p[áa]gina inicial)\b/i
const API_RE = /\b(api|apis|backend|rest|restful|endpoint|endpoints|servidor|microservi[çc]o|crud)\b/i
const PWA_RE = /\b(pwa|progressive web app|aplica[çc][ãa]o web instal[áa]vel)\b/i
const WEBAPP_RE = /\b(app web|aplica[çc][ãa]o web|web app|dashboard|painel|sistema|plataforma web|loja online|e[- ]?commerce)\b/i
const AMBIGUOUS_APP_RE = /\b(app|aplicativo|aplica[çc][ãa]o|aplica[çc][õo]es)\b/i

/**
 * Classifica uma mensagem do usuário num template de projeto.
 * Determinístico: mesmas palavras → mesma decisão (auditável).
 *
 * Ordem de avaliação (frases específicas primeiro):
 *   PWA → Landing → API → Web App (frases) → Jogo → ambíguo
 * ("plataforma web" é app; "jogo de plataforma" é jogo).
 */
export function classifyIntent(text: string): IntentClassification {
  const msg = String(text ?? '').toLowerCase()

  const pwa = msg.match(PWA_RE)
  if (pwa) return { type: 'PWA', confident: true, matched: pwa[0] }

  const landing = msg.match(LANDING_RE)
  if (landing) return { type: 'LANDING_PAGE', confident: true, matched: landing[0] }

  const api = msg.match(API_RE)
  if (api) return { type: 'API', confident: true, matched: api[0] }

  const webapp = msg.match(WEBAPP_RE)
  if (webapp) return { type: 'WEB_APP', confident: true, matched: webapp[0] }

  const game = msg.match(GAME_RE)
  if (game) return { type: 'MINI_GAME', confident: true, matched: game[0] }

  // "Cria uma app" / "Faz-me uma aplicação" → contexto insuficiente:
  // pergunta antes de criar (nunca adivinha silenciosamente).
  const ambiguous = msg.match(AMBIGUOUS_APP_RE)
  if (ambiguous) {
    return { type: 'WEB_APP', confident: false, matched: ambiguous[0] }
  }

  // sem sinal nenhum → ambíguo (pergunta; a conversa decide)
  return { type: 'WEB_APP', confident: false, matched: '' }
}

// ---------- pergunta de clarificação (AskUserQuestion) ----------

/** Opções padrão quando o contexto é ambíguo. */
export const CLARIFY_OPTIONS: readonly ClarifyChoice[] = [
  { label: 'App Web', description: 'aplicação web interativa (dashboard, sistema, loja)' },
  { label: 'Jogo', description: 'jogo 2D mobile-first com controles por toque' },
  { label: 'Landing Page', description: 'página de apresentação com CTA' },
  { label: 'API', description: 'serviço backend REST com endpoints' },
] as const

/** Pergunta conversacional exibida no chat quando o tipo é ambíguo. */
export function clarifyQuestion(): ClarifyQuestion {
  return {
    header: 'Tipo de projeto',
    question: 'Queres que crie uma app web, um jogo ou outra coisa?',
    options: CLARIFY_OPTIONS,
  }
}

/** Mapeia a resposta do usuário → tipo resolvido (confiante). */
export function resolveTypeFromAnswer(answer: string): IntentClassification {
  const a = String(answer ?? '').toLowerCase()
  if (GAME_RE.test(a) || /\bjogo\b|\bgame\b/.test(a)) {
    return { type: 'MINI_GAME', confident: true, matched: 'resposta do usuário' }
  }
  if (/\blanding\b|\bp[áa]gina\b|\bsite\b/.test(a)) {
    return { type: 'LANDING_PAGE', confident: true, matched: 'resposta do usuário' }
  }
  if (API_RE.test(a)) {
    return { type: 'API', confident: true, matched: 'resposta do usuário' }
  }
  if (PWA_RE.test(a)) {
    return { type: 'PWA', confident: true, matched: 'resposta do usuário' }
  }
  if (/\bapp\b|\baplica/.test(a)) {
    return { type: 'WEB_APP', confident: true, matched: 'resposta do usuário' }
  }
  return { type: 'WEB_APP', confident: false, matched: '' }
}

// ---------- nome automático do projeto ----------

/** Deriva um nome curto de projeto a partir da 1ª mensagem. */
export function projectNameFromMessage(text: string): string {
  const msg = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    // remove prefixos conversacionais comuns
    .replace(/^(por favor,?\s+|pf\s+)?(cria|crie|criar|faz|faça|fazer|constrói|construir|monta|montar|preciso de|quero|gostava de|podes?|pode)\s+(me\s+|um[a]?\s+|uma?\s+)*/i, '')
    .trim()
  if (!msg) return 'Nova conversa'
  const words = msg.split(' ').filter(Boolean)
  const name = words.slice(0, 5).join(' ')
  return (name.charAt(0).toUpperCase() + name.slice(1)).slice(0, 40)
}
