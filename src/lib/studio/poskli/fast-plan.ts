// ============================================================
// POSKLI / FAST PLAN (NÚCLEO PURO) — decisão de ritmo da análise
// ============================================================
// FIX do travamento ("A pensar durante 45s…"): o master recebia a
// mesma instrução para QUALQUER pedido — pesquisar a web antes de
// planejar, inspecionar arquivos, etc. Pedidos simples ("Cria uma
// landing page") ficavam presos em ciclos de pesquisa/ferramenta
// antes do primeiro passo útil.
//
// Este módulo classifica o RITMO ideal da análise:
//   - fast       → pedido claro de construção: plano no PRIMEIRO
//                  passo, sem pesquisas nem inspeções;
//   - suggested  → pedido que depende de informação externa:
//                  UMA pesquisa (opcional) fundamenta o plano;
//   - default    → análise mínima, plano no 1º-2º passo.
//
// ZERO imports de runtime → testável com node:test.
// ============================================================

import { isConversational } from './toon.ts'

export interface PlanMode {
  /** true → instrui o master a produzir o plano JÁ no 1º passo. */
  fast: boolean
  /** web_search é 'suggested' (pode fundamentar) ou 'optional'. */
  webSearch: 'suggested' | 'optional'
  /** Linha adicionada ao objetivo da análise (prompt do master). */
  hint: string
}

/** Padrões de pedidos de construção claros (não exigem pesquisa). */
const SIMPLE_BUILD_RE =
  /landing|site\b|website|página|pagina|portfólio|portfolio|app\b|jogo|game\b|dashboard|blog|loja|formul|quiz|calculadora|calcul|landing page/i

/** Padrões de pedidos que dependem de informação externa atual. */
const RESEARCH_RE =
  /pesquis|tendênc|tendenc|compar|notíc|notic|preç|prec|mercado|estatíst|estatist|atual|últim|ultim|latest|hoje|referên|referen|inspir|202[5-9]|benchmark/i

/** Pedido longo → provavelmente tem requisitos suficientes no texto. */
const MAX_SIMPLE_REQUEST_CHARS = 220

/**
 * Modo de planeamento para o pedido (heurística pura):
 *   "Cria uma landing page"          → fast, pesquisa opcional
 *   "Pesquisa tendências de design"  → suggested
 *   "Refatora X e corrige Y"         → default (plano 1º-2º passo)
 */
export function planModeFor(request: string): PlanMode {
  const text = (request ?? '').trim()
  const simple = SIMPLE_BUILD_RE.test(text) && text.length <= MAX_SIMPLE_REQUEST_CHARS
  const researchy = RESEARCH_RE.test(text)
  if (simple && !researchy) {
    return {
      fast: true,
      webSearch: 'optional',
      hint:
        'PEDIDO CLARO E SIMPLES: produza o plano JÁ NO PRIMEIRO PASSO — ' +
        'sem pesquisas web, sem inspecionar arquivos (o contexto fornecido basta). ' +
        'A pesquisa web é OPCIONAL; se algum dia devolver vazio, prossegue sem ela.',
    }
  }
  if (researchy) {
    return {
      fast: false,
      webSearch: 'suggested',
      hint:
        'O pedido envolve informação externa: UMA pesquisa web (web_search) PODE ' +
        'fundamentar o plano — mas é opcional; se falhar ou devolver vazio, PROSSIGA ' +
        'com o que sabe e planeie sem pesquisar.',
    }
  }
  return {
    fast: false,
    webSearch: 'optional',
    hint:
      'Analise com o MÍNIMO de passos e produza o plano (idealmente no 1º-2º passo). ' +
      'Ferramentas e pesquisas são OPCIONAIS — use-as apenas se algo ESSENCIAL faltar.',
  }
}

/** true se o pedido é de construção simples (atalho p/ testes/UI). */
export function isSimpleBuildRequest(request: string): boolean {
  const mode = planModeFor(request)
  return mode.fast
}

// ---------- MODO CONVERSA (TOON) ----------

export interface ConversationDecision {
  /** true → resposta direta do master, SEM run, SEM tools, SEM projeto. */
  conversation: boolean
  /** Linha adicionada ao prompt quando conversa. */
  hint: string
}

/**
 * MODO CONVERSA: pedidos SEM verbos de ação ("Olá, como estás?",
 * "obrigado!", "isso é interessante") são conversa, não trabalho —
 * o master responde LIVREMENTE sem criar projeto/run (custo mínimo:
 * ~1 chamada LLM de poucos tokens vs um run completo de agente).
 */
export function conversationModeFor(request: string): ConversationDecision {
  const conversational = isConversational((request ?? '').trim())
  return {
    conversation: conversational,
    hint: conversational
      ? 'Responda de forma natural, curta e amigável, no idioma do usuário. ' +
        'Se o usuário parecer querer TRABALHO a seguir, termine sugerindo o que pode pedir ' +
        '(ex.: "posso criar um site, uma app ou um jogo — é só pedir").'
      : '',
  }
}
