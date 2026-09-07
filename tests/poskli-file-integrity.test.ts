// ============================================================
// FILE INTEGRITY — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-file-integrity.test.ts
// Bug de corrupção: o editor exibia código com caracteres
// comidos ("yld('status')", "eturn"). A tool write agora valida
// ANTES de gravar e LÊ DE VOLTA para conferir.
//   F1. código LIMPO com aspas/caracteres especiais → aceito
//   F2. "eturn" / "yld(" → REJEITADO (sintaxe suspeita)
//   F3. chaves desequilibradas (truncamento) → REJEITADO
//   F4. conteúdo vazio → REJEITADO
//   F5. caracteres de controle/U+FFFD → REJEITADO
//   F6. arquivo não-código (md) com chaves soltas → aceito
//   F7. round-trip real em tmpdir: grava → lê → idêntico
//   F8. strings/comentários NÃO contam no balanço de chaves
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  validateFileContent, writeFileVerified, isCodeFile,
  delimiterBalance, stripStringsAndComments,
} from '../src/lib/studio/tools/file-integrity.ts'

const CLEAN_CODE = `const status = 'pronto'
const msg = "com \\"aspas\\" internas"
const tpl = \`template \${status} com 'apóstrofo'\`

// comentário com { chaves } soltas
/* bloco com (parênteses) */

function update() {
  if (status !== 'pronto') return
  const arr = [1, 2, 3].map((n) => n * 2)
  const obj = { a: { b: [arr] } }
  console.log(msg, tpl, obj)
  return eturnPlaceholderAvoid
}

update()
`

// a linha acima com "eturnPlaceholderAvoid" é substituída abaixo —
// construímos o código limpo SEM o token suspeito:
const CLEAN = CLEAN_CODE.replace('eturnPlaceholderAvoid', 'true')

test('F1 — código limpo com aspas, escapes e template literals é ACEITO', () => {
  const v = validateFileContent('src/game.js', CLEAN)
  assert.equal(v.ok, true, `deveria passar: ${JSON.stringify(v)}`)
})

test('F2 — tokens corrompidos ("eturn", "yld(") são REJEITADOS', () => {
  const corrupted1 = CLEAN.replace('return true', 'eturn true')
  const v1 = validateFileContent('src/game.js', corrupted1)
  assert.equal(v1.ok, false)
  assert.equal(v1.reason, 'SINTAXE_SUSPEITA')
  assert.ok(v1.hint!.includes('eturn'), 'hint menciona o token')

  const corrupted2 = `function* gen() {
  yld('status')
}
`
  const v2 = validateFileContent('src/gen.js', corrupted2)
  assert.equal(v2.ok, false)
  assert.equal(v2.reason, 'SINTAXE_SUSPEITA')

  // e o EXEMPLO do bug reportado: yield comido + return comido
  const bugReport = `extends Node

func _process(delta):
    yld('status')
    if delta > 0:
        eturn
`
  const v3 = validateFileContent('scripts/player.gd', bugReport)
  assert.equal(v3.ok, false, 'o padrão exato do bug deve ser rejeitado')
  assert.ok(v3.reason === 'SINTAXE_SUSPEITA' || v3.reason === 'DESEQUILIBRIO_DE_CHAVES')
})

test('F3 — chaves/parênteses desequilibrados (truncamento) são REJEITADOS', () => {
  const truncated = `function update() {
  if (a) {
    if (b) {
      doSomething()
  }
`
  const v = validateFileContent('src/broken.js', truncated)
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'DESEQUILIBRIO_DE_CHAVES')

  const parenOnly = 'fazer(algo('
  const v2 = validateFileContent('src/p.js', parenOnly)
  assert.equal(v2.ok, false)
})

test('F4 — conteúdo vazio é REJEITADO', () => {
  assert.equal(validateFileContent('a.js', '').ok, false)
  assert.equal(validateFileContent('a.js', '   \n\t  ').ok, false)
  const v = validateFileContent('a.js', '')
  assert.equal(v.reason, 'CONTEUDO_VAZIO')
})

test('F5 — caracteres de controle e U+FFFD são REJEITADOS', () => {
  const withNul = 'const a = 1\x00'
  const v1 = validateFileContent('a.js', withNul)
  assert.equal(v1.ok, false)
  assert.equal(v1.reason, 'CARACTERES_INVALIDOS')

  const withFffd = 'const a = 1' + String.fromCharCode(0xfffd)
  const v2 = validateFileContent('a.js', withFffd)
  assert.equal(v2.ok, false)
  assert.equal(v2.reason, 'CARACTERES_INVALIDOS')
})

test('F6 — arquivo NÃO-código (markdown) aceita chaves soltas no texto', () => {
  const md = `# README

Texto com { chaves } e (parênteses) soltos — normal em prosa.

- item com "aspas" e 'apóstrofos'
`
  const v = validateFileContent('README.md', md)
  assert.equal(v.ok, true)
  assert.equal(isCodeFile('README.md'), false)
  assert.equal(isCodeFile('src/game.js'), true)
  assert.equal(isCodeFile('scripts/player.gd'), true)
  assert.equal(isCodeFile('main.py'), true)
})

test('F7 — round-trip REAL: grava em tmpdir, lê de volta e confere byte a byte', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poskli-integrity-'))
  const file = path.join(dir, 'game.js')
  const contents = [
    CLEAN,
    `const s = "aspas 'simples' e \\"duplas\\" \\\\ e barra"`
      .replace('\\\\', '\\\\'),
    'código com unicode: ação, coração, emoção, çãõ',
    '// só um comentário\n',
  ]
  for (const c of contents) {
    const w = await writeFileVerified(file, c)
    assert.equal(w.ok, true, `round-trip deveria verificar: ${JSON.stringify(w)}`)
    const readBack = await fs.readFile(file, 'utf8')
    assert.equal(readBack, c, 'conteúdo em disco idêntico ao enviado')
  }
  // arquivo com caracteres especiais de verdade
  const special = `const re = /['"\\\\]/g
const s = 'mix "duplas" e \\'simples\\''
export default { re, s }
`
  const w = await writeFileVerified(path.join(dir, 'special.js'), special)
  assert.equal(w.ok, true)
  const back = await fs.readFile(path.join(dir, 'special.js'), 'utf8')
  assert.equal(back, special)
  await fs.rm(dir, { recursive: true, force: true })
})

test('F8 — strings e comentários NÃO contam no balanço de delimitadores', () => {
  const code = `const s = '}]{[(' // }]){[
/* ((( ))) {{{ }}} */
const ok = 1
`
  const bal = delimiterBalance(code, false)
  assert.equal(bal.braces, 0)
  assert.equal(bal.brackets, 0)
  assert.equal(bal.parens, 0)

  // strip remove conteúdo de strings
  const stripped = stripStringsAndComments(`x = "conteudo { interno }" + 'outro'`, false)
  assert.ok(!stripped.includes('conteudo'))
  assert.ok(stripped.includes('x ='))

  // comentário # em python
  const py = `def f():\n    return 1  # { comentario }\n`
  const balPy = delimiterBalance(py, true)
  assert.equal(balPy.braces, 0)
  assert.equal(balPy.parens, 0)
})
