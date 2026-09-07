// ============================================================
// TOOLS / FILE INTEGRITY (VALIDAÇÃO PÓS-ESCRITA) — puro + fs
//
// PROBLEMA (bug de corrupção): o modelo às vezes emite código
// com caracteres comidos no MEIO do conteúdo ("yld('status')",
// "eturn") ou truncado no fim. A tool gravava o conteúdo sem
// verificar e o editor exibia código quebrado.
//
// DEFESAS (estilo Claude Code — validar ANTES de aceitar):
//   1. validateFileContent  — pré-escrita: vazio, caracteres de
//      controle, desequilíbrio de chaves em arquivos de código,
//      tokens de sintaxe corrompidos (eturn, yld(, fuction…).
//   2. writeFileVerified    — pós-escrita: grava, LÊ DE VOLTA e
//      confere byte a byte (detecta truncamento de disco/cota);
//      1 re-tentativa antes de declarar divergência.
//
// Sem imports de DB — testável com node:test em diretório tmp.
// ============================================================

import fs from 'fs/promises'

/** Extensões cujo conteúdo é código (validação de sintaxe aplicável). */
const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'gd', 'py',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'java',
  'kt', 'kts', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'cs', 'php',
  'rb', 'swift', 'dart', 'lua', 'gd3',
])

/** Extensões onde `#` inicia comentário de linha (py/gd/sh…). */
const HASH_COMMENT_EXTENSIONS = new Set(['py', 'gd', 'gd3', 'sh', 'bash', 'rb', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env'])

export interface FileValidation {
  ok: boolean
  /** código estável do motivo da rejeição (vazio quando ok). */
  reason?: 'CONTEUDO_VAZIO' | 'CARACTERES_INVALIDOS' | 'DESEQUILIBRIO_DE_CHAVES' | 'SINTAXE_SUSPEITA'
  /** explicação devolvida ao agente (como agir). */
  hint?: string
}

export function isCodeFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return ext.length > 0 && CODE_EXTENSIONS.has(ext)
}

/**
 * Remove conteúdos de strings e comentários para que a contagem
 * de delimitadores considere apenas código real.
 * - strings ' " ` (com escapes) → espaço
 * - comentários // e /* *\/ → espaço
 * - comentários # (py/gd/sh — conforme extensão) → espaço
 */
export function stripStringsAndComments(code: string, hashComments: boolean): string {
  let out = ''
  let i = 0
  const n = code.length
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let mode: Mode = 'code'
  while (i < n) {
    const ch = code[i]!
    const next = code[i + 1]
    switch (mode) {
      case 'code': {
        if (ch === '/' && next === '/') { mode = 'line'; i += 2; out += '  '; continue }
        if (ch === '/' && next === '*') { mode = 'block'; i += 2; out += '  '; continue }
        if (hashComments && ch === '#') { mode = 'line'; i += 1; out += ' '; continue }
        if (ch === "'") { mode = 'single'; i += 1; out += ' '; continue }
        if (ch === '"') { mode = 'double'; i += 1; out += ' '; continue }
        if (ch === '`') { mode = 'template'; i += 1; out += ' '; continue }
        out += ch
        i += 1
        continue
      }
      case 'line': {
        if (ch === '\n' || ch === '\r') { mode = 'code'; out += ch }
        i += 1
        continue
      }
      case 'block': {
        if (ch === '*' && next === '/') { mode = 'code'; i += 2; out += ' '; continue }
        i += 1
        continue
      }
      default: {
        // single | double | template
        if (ch === '\\') { i += 2; continue }
        const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`'
        if (ch === closer) { mode = 'code'; i += 1; out += ' '; continue }
        i += 1
        continue
      }
    }
  }
  return out
}

/** Conta delimitadores de código ({}, [], ()) depois de limpar strings/comentários. */
export function delimiterBalance(code: string, hashComments: boolean): Record<'braces' | 'brackets' | 'parens', number> {
  const clean = stripStringsAndComments(code, hashComments)
  let braces = 0
  let brackets = 0
  let parens = 0
  for (const ch of clean) {
    if (ch === '{') braces++
    else if (ch === '}') braces--
    else if (ch === '[') brackets++
    else if (ch === ']') brackets--
    else if (ch === '(') parens++
    else if (ch === ')') parens--
  }
  return { braces, brackets, parens }
}

/**
 * Tokens que indicam corrupção de caracteres no MEIO do código
 * (prefixos comidos de keywords comuns). Verificados apenas no
 * código limpo (sem strings/comentários) para evitar falsos
 * positivos em textos e comentários.
 */
const SUSPICIOUS_TOKENS = /\b(eturn|eturns|eyturn|fuction|fucntion|reurn|retrn|retun|functon|ontinue|contiue|ontinue)\b|\byld\s*\(|\byiled\b/g

export function findSuspiciousTokens(code: string, hashComments: boolean): string[] {
  const clean = stripStringsAndComments(code, hashComments)
  const found = new Set<string>()
  for (const m of clean.matchAll(SUSPICIOUS_TOKENS)) {
    found.add(m[0].trim())
  }
  return [...found]
}

/**
 * Valida o conteúdo ANTES de gravar. Rejeita:
 * 1. conteúdo vazio/só espaços
 * 2. caracteres de controle (exceto \t \n \r) ou U+FFFD
 * 3. código com chaves/colchetes/parênteses desequilibrados
 * 4. tokens de sintaxe corrompidos (eturn, yld(, fuction…)
 */
export function validateFileContent(path: string, content: string): FileValidation {
  if (!content || content.trim().length === 0) {
    return {
      ok: false,
      reason: 'CONTEUDO_VAZIO',
      hint: 'o conteúdo está vazio — gere o código completo do arquivo e reenvie',
    }
  }
  // caracteres de controle + replacement char (encoding quebrado)
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i)
    const isCtl = c < 32 && c !== 9 && c !== 10 && c !== 13
    if (isCtl || c === 0xfffd) {
      return {
        ok: false,
        reason: 'CARACTERES_INVALIDOS',
        hint: `caractere inválido na posição ${i} (código ${c}) — reenvie o arquivo completo`,
      }
    }
  }
  if (isCodeFile(path)) {
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const hashComments = HASH_COMMENT_EXTENSIONS.has(ext)
    const bal = delimiterBalance(content, hashComments)
    if (bal.braces !== 0 || bal.brackets !== 0 || bal.parens !== 0) {
      return {
        ok: false,
        reason: 'DESEQUILIBRIO_DE_CHAVES',
        hint:
          `delimitadores desequilibrados (chaves ${bal.braces > 0 ? '+' : ''}${bal.braces}, ` +
          `colchetes ${bal.brackets > 0 ? '+' : ''}${bal.brackets}, parênteses ${bal.parens > 0 ? '+' : ''}${bal.parens}) — ` +
          'o código provavelmente foi TRUNCADO. Reenvie o arquivo completo (ou divida em arquivos menores)',
      }
    }
    const tokens = findSuspiciousTokens(content, hashComments)
    if (tokens.length > 0) {
      return {
        ok: false,
        reason: 'SINTAXE_SUSPEITA',
        hint: `tokens com aparência de código corrompido: ${tokens.join(', ')} (ex.: "eturn"/"yld(" são keywords incompletas) — reenvie o arquivo com o código íntegro`,
      }
    }
  }
  return { ok: true }
}

export interface WriteVerifyResult {
  ok: boolean
  reason?: 'ESCRITA_DIVERGENTE'
  hint?: string
}

/**
 * Grava e LÊ DE VOLTA conferindo byte a byte (validação
 * pós-escrita). Uma re-tentativa antes de declarar divergência
 * (disco cheio/cota pode truncar silenciosamente).
 */
export async function writeFileVerified(absPath: string, content: string): Promise<WriteVerifyResult> {
  await fs.writeFile(absPath, content, 'utf8')
  const first = await fs.readFile(absPath, 'utf8').catch(() => null)
  if (first === content) return { ok: true }
  // re-tentativa única
  await fs.writeFile(absPath, content, 'utf8')
  const second = await fs.readFile(absPath, 'utf8').catch(() => null)
  if (second === content) return { ok: true }
  return {
    ok: false,
    reason: 'ESCRITA_DIVERGENTE',
    hint: 'o arquivo em disco difere do conteúdo enviado (truncamento de disco/cota?) — verifique o espaço e reenvie',
  }
}
