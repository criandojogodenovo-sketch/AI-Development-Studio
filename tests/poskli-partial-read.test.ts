// ============================================================
// LEITURA PARCIAL — TESTES (node:test, PURO)
// Executar: node --test tests/poskli-partial-read.test.ts
// read_head / read_range / read_tail (núcleo partial-read.ts):
//   R1. sliceRange: intervalo exato 1-based, numerado "N\tlinha"
//   R2. intervalo inválido/fora dos limites → ERRO legível
//   R3. truncagem SEMPRE a 2000 chars (nunca sopra o contexto)
//   R4. sliceHead / sliceTail: primeiras/últimas linhas certas
//   R5. formatPartialRead: header com path+range+total
//   R6. registro das tools no registry central (fs-tools)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  sliceHead,
  sliceRange,
  sliceTail,
  formatPartialRead,
  validRange,
  MAX_OUTPUT_CHARS,
  DEFAULT_LINES,
} from '../src/lib/studio/tools/partial-read.ts'

const many = Array.from({ length: 500 }, (_, i) => `linha ${i + 1} com conteúdo`).join('\n')

test('R1 — sliceRange devolve exatamente [start, end] numerado 1-based', () => {
  const r = sliceRange(many, 100, 110)
  assert.equal(r.ok, true)
  assert.equal(r.range, '100-110')
  assert.equal(r.totalLines, 500)
  assert.ok(r.content.startsWith('100\tlinha 100'), 'primeira linha deve ser a 100')
  assert.ok(r.content.includes('110\tlinha 110'), 'última deve ser a 110')
  assert.equal(r.content.split('\n').length, 11)
})

test('R2 — intervalo inválido e fora dos limites → ERRO legível (sem throw)', () => {
  const bad = sliceRange(many, 0, 10)
  assert.equal(bad.ok, false)
  assert.match(bad.content, /intervalo inválido/i)
  const inverted = sliceRange(many, 20, 5)
  assert.equal(inverted.ok, false)
  const oob = sliceRange(many, 600, 700)
  assert.equal(oob.ok, false)
  assert.match(oob.content, /fora dos limites/i)
  assert.equal(validRange(1, 1), true)
  assert.equal(validRange(0, 1), false)
  assert.equal(validRange(5, 2), false)
})

test('R3 — truncagem dura a 2000 chars mesmo pedindo 500 linhas', () => {
  const huge = Array.from({ length: 500 }, (_, i) => `${i + 1}: ${'x'.repeat(200)}`).join('\n')
  const r = sliceRange(huge, 1, 500)
  assert.equal(r.truncated, true)
  // 2000 + nota de truncamento curta (margem pequena e controlada)
  assert.ok(r.content.length <= MAX_OUTPUT_CHARS + 60, `len=${r.content.length}`)
  assert.match(r.content, /\[\.\.\.truncado em 2000 chars\]/)
  // truncagem prefere fronteira de linha (numeração legível)
  const lines = r.content.split('\n')
  assert.match(lines[lines.length - 2], /^\d+\t/)
})

test('R4 — sliceHead e sliceTail devolvem as linhas certas', () => {
  const head = sliceHead(many, 10)
  assert.equal(head.range, '1-10')
  assert.ok(head.content.startsWith('1\tlinha 1'))
  const tail = sliceTail(many, 5)
  assert.equal(tail.range, '496-500')
  assert.ok(tail.content.includes('500\tlinha 500'))
  assert.equal(DEFAULT_LINES, 50)
})

test('R5 — formatPartialRead emite header compacto para o LLM', () => {
  const r = sliceRange(many, 100, 110)
  const out = formatPartialRead('src/app.ts', r)
  assert.ok(out.startsWith('src/app.ts [linhas 100-110 de 500]'))
  assert.ok(out.includes('100\tlinha 100'))
  const err = formatPartialRead('src/app.ts', sliceRange(many, 600, 700))
  assert.match(err, /ERRO/) // erro sem header — só a mensagem
})

test('R6 — tools read_head/read_range/read_tail declaradas com fs:read (fonte)', () => {
  // NOTA: fs-tools.ts importa @/lib/db via db-provider — não importável
  // em node:test puro; a declaração/registro é verificada no FONTE
  // (compilação/tsc garantem que as exports batem certo com o registry).
  const fsToolsSrc = readFileSync(new URL('../src/lib/studio/tools/fs-tools.ts', import.meta.url), 'utf8')
  const indexSrc = readFileSync(new URL('../src/lib/studio/tools/index.ts', import.meta.url), 'utf8')
  for (const [name, exportName] of [
    ['read_head', 'readHeadTool'],
    ['read_range', 'readRangeTool'],
    ['read_tail', 'readTailTool'],
  ] as const) {
    assert.ok(fsToolsSrc.includes(`name: '${name}'`), `tool ${name} declarada em fs-tools.ts`)
    assert.ok(fsToolsSrc.includes("permissions: ['fs:read']"), 'permissão fs:read')
    assert.ok(indexSrc.includes(exportName), `${exportName} importada no registry central`)
  }
  // read_range exige startLine/endLine (params obrigatórios)
  assert.ok(fsToolsSrc.includes("{ name: 'startLine', type: 'number', required: true"))
  assert.ok(fsToolsSrc.includes("{ name: 'endLine', type: 'number', required: true"))
})
