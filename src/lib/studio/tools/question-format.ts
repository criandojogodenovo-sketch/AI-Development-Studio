// ============================================================
// TOOLS / QUESTION FORMAT (NÚCLEO PURO)
// Formato da ferramenta ask_user_question (interatividade real,
// como o AskUserQuestion do Claude Code).
//
// ZERO imports de runtime — testável isoladamente com node:test.
// O agente envia `questions` como STRING JSON:
//   [{"header":"Controles","question":"Teclado ou toque?",
//     "options":[{"label":"Toque","description":"mobile-first"}]}]
// Máx 4 perguntas · 2-4 opções por pergunta.
// ============================================================

export interface QuestionOption {
  label: string
  description?: string
}

export interface AgentQuestion {
  header: string
  question: string
  options: QuestionOption[]
}

export const MAX_QUESTIONS = 4
export const MAX_OPTIONS_PER_QUESTION = 4
export const MIN_OPTIONS_PER_QUESTION = 2

const MAX_HEADER_CHARS = 40
const MAX_QUESTION_CHARS = 300
const MAX_LABEL_CHARS = 60
const MAX_DESCRIPTION_CHARS = 120

export interface QuestionParseOk {
  ok: true
  questions: AgentQuestion[]
}
export interface QuestionParseErr {
  ok: false
  error: string
}
export type QuestionParseResult = QuestionParseOk | QuestionParseErr

function clipText(s: unknown, max: number): string {
  return String(s ?? '').trim().slice(0, max)
}

/** Normaliza UMA pergunta bruta; null se inválida. */
function normalizeQuestion(raw: unknown, idx: number): AgentQuestion | null {
  if (typeof raw === 'string') {
    // string pura: "pergunta" — sem opções → inválida (mín 2 exigidas)
    const q = clipText(raw, MAX_QUESTION_CHARS)
    if (!q) return null
    return { header: `Pergunta ${idx + 1}`, question: q, options: [] }
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const question = clipText(r.question ?? r.text ?? r.prompt, MAX_QUESTION_CHARS)
  if (!question) return null
  const header = clipText(r.header ?? r.title ?? r.label, MAX_HEADER_CHARS) || `Pergunta ${idx + 1}`

  const rawOptions = Array.isArray(r.options) ? r.options : Array.isArray(r.choices) ? r.choices : []
  const options: QuestionOption[] = []
  for (const o of rawOptions.slice(0, MAX_OPTIONS_PER_QUESTION)) {
    if (typeof o === 'string') {
      const label = clipText(o, MAX_LABEL_CHARS)
      if (label) options.push({ label })
    } else if (o && typeof o === 'object') {
      const oo = o as Record<string, unknown>
      const label = clipText(oo.label ?? oo.value ?? oo.name, MAX_LABEL_CHARS)
      if (!label) continue
      const description = clipText(oo.description ?? oo.detail, MAX_DESCRIPTION_CHARS)
      options.push(description ? { label, description } : { label })
    }
  }
  return { header, question, options }
}

/**
 * Faz o parse do argumento `questions` da tool.
 * Aceita: STRING JSON (array, {questions:[...]}, {question,...}) ou
 * fallback "pergunta|opção1|opção2" (texto simples com separador |).
 * Sempre devolve regra de erro INSTRUTIVA quando o formato não serve.
 */
export function parseQuestionsInput(raw: string): QuestionParseResult {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, error: 'argumento "questions" vazio' }

  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }

  let rawList: unknown[] = []
  if (Array.isArray(parsed)) {
    rawList = parsed
  } else if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>
    if (Array.isArray(p.questions)) rawList = p.questions
    else if (p.question !== undefined || p.text !== undefined || p.prompt !== undefined) rawList = [p]
  }

  // fallback textual: "pergunta | opcao A | opcao B"
  if (rawList.length === 0 && text.startsWith('{') === false && text.startsWith('[') === false) {
    const parts = text.split('|').map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 3) {
      rawList = [
        {
          header: parts[0].slice(0, MAX_HEADER_CHARS),
          question: parts[0].slice(0, MAX_QUESTION_CHARS),
          options: parts.slice(1).map((s) => ({ label: s.slice(0, MAX_LABEL_CHARS) })),
        },
      ]
    }
  }

  if (rawList.length === 0) {
    return {
      ok: false,
      error:
        'formato inválido — envie STRING JSON: [{"header":"...","question":"...","options":[{"label":"...","description":"..."}]}] (máx 4 perguntas, 2-4 opções cada)',
    }
  }

  const questions: AgentQuestion[] = []
  let invalid = ''
  for (const [i, rq] of rawList.slice(0, MAX_QUESTIONS).entries()) {
    const q = normalizeQuestion(rq, i)
    if (!q) continue
    if (q.options.length < MIN_OPTIONS_PER_QUESTION) {
      invalid = `pergunta ${i + 1} ("${q.question.slice(0, 60)}") tem ${q.options.length} opção(ões) — mínimo ${MIN_OPTIONS_PER_QUESTION}`
      continue
    }
    questions.push(q)
  }
  if (questions.length === 0) {
    return {
      ok: false,
      error: invalid || 'nenhuma pergunta válida encontrada (verifique o formato JSON)',
    }
  }
  return { ok: true, questions }
}

/** Resposta do usuário devolvida ao agente como observação. */
export interface UserAnswer {
  header?: string
  answer: string
}

export function formatUserAnswers(answers: UserAnswer[]): string {
  if (!answers.length) return '(sem conteúdo)'
  return answers
    .map((a) => `- ${a.header ? `${a.header}: ` : ''}${String(a.answer ?? '').trim().slice(0, 400)}`)
    .join('\n')
}

// ============================================================
// DECISÃO DO LOOP DE ESPERA (núcleo puro — testável)
// A tool ask_user_question BLOQUEIA o agente até a resposta:
// cada volta do polling decide com base no estado da ToolCall,
// no estado do run e no prazo. Estas regras puras garantem:
//   - PENDING + dentro do prazo     → WAIT (o loop continua)
//   - ANSWERED                       → ANSWER (resposta ao LLM)
//   - run CANCELLED                  → CANCELLED (aborta)
//   - prazo esgotado sem resposta    → TIMEOUT (prossegue
//     com a opção mais conservadora documentada)
// ============================================================

export type QuestionPollAction = 'WAIT' | 'ANSWER' | 'TIMEOUT' | 'CANCELLED'

export interface QuestionPollInput {
  /** status atual da ToolCall (PENDING | ANSWERED | …) */
  toolCallStatus: string
  /** estado do run Poskli ('CANCELLED' aborta a espera) */
  runState?: string | null
  /** epoch ms atual */
  now: number
  /** epoch ms limite da janela de espera */
  deadline: number
}

export function nextQuestionPollAction(input: QuestionPollInput): QuestionPollAction {
  if (input.runState === 'CANCELLED') return 'CANCELLED'
  if (input.toolCallStatus === 'ANSWERED') return 'ANSWER'
  if (input.toolCallStatus === 'TIMEOUT' || input.toolCallStatus === 'CANCELLED') return 'TIMEOUT'
  if (input.now >= input.deadline) return 'TIMEOUT'
  return 'WAIT'
}
