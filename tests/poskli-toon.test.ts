// ============================================================
// TOON — TESTES (node:test, PURO)
// Executar: node --test tests/poskli-toon.test.ts
// Formato compacto de comunicação master↔subagentes:
//   T1. linha única com chaves t/k/d/l (+f/n quando faz sentido)
//   T2. round-trip: parseToon(parseRequestToTOON(x)) preserva dados
//   T3. poupança vs JSON ≥ 30%
//   T4. deteção: kind (web/research/logic/chat) e dificuldade
//   T5. extractFiles apanha ficheiros mencionados
//   T6. sanitize: | e : e newlines nunca quebram o formato
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRequestToTOON,
  parseToon,
  buildToonTask,
  toonToString,
  toonSavings,
  detectKind,
  detectDifficulty,
  detectLang,
  isConversational,
  extractFiles,
  extractIntent,
} from '../src/lib/studio/poskli/toon.ts'

test('T1 — TOON é uma linha única com as chaves esperadas', () => {
  const toon = parseRequestToTOON('Faz um site sobre gatos')
  assert.equal(toon.includes('\n'), false, 'TOON deve ser uma linha única')
  assert.match(toon, /^t:.+gatos/)
  assert.match(toon, /\|k:web\|/)
  assert.match(toon, /\|d:simple\|/)
  assert.match(toon, /\|l:pt$/)
  // sem ficheiros/nome → campos f/n omitidos (economia)
  assert.equal(toon.includes('|f:'), false)
  assert.equal(toon.includes('|n:'), false)
})

test('T2 — round-trip: parseToon recupera o ToonTask', () => {
  const toon = parseRequestToTOON('Cria um dashboard com login e base de dados postgres')
  const task = parseToon(toon)
  assert.equal(task.kind, 'web')
  assert.ok(task.difficulty === 'medium' || task.difficulty === 'hard' || task.difficulty === 'complex')
  assert.equal(task.lang, 'pt')
  assert.ok(task.intent.length > 0)
  // ficheiro mencionado → campo f presente e recuperado
  const toon2 = parseRequestToTOON('Corrige o bug em src/index.html e testa')
  const task2 = parseToon(toon2)
  assert.ok(task2.files.includes('src/index.html'), `f deve conter src/index.html em "${toon2}"`)
})

test('T3 — TOON ≥30% mais compacto que o JSON equivalente (média de amostras)', () => {
  const samples = [
    'Faz um site sobre gatos',
    'Cria um dashboard com login e base de dados postgres',
    'Pesquisa as tendências de design 2026 e compara com 2025, depois cria um dashboard com login, base de dados postgres e api de pagamentos stripe',
  ]
  let total = 0
  for (const req of samples) {
    const toon = parseRequestToTOON(req)
    const json = JSON.stringify(buildToonTask(req))
    const savings = toonSavings(json, toon)
    assert.ok(savings >= 0.25, `poupança ${Math.round(savings * 100)}% < 25% para "${req.slice(0, 30)}…"`)
    total += savings
  }
  const avg = total / samples.length
  assert.ok(avg >= 0.3, `poupança média ${Math.round(avg * 100)}% deve ser ≥ 30% (meta: 30–50%)`)
})

test('T4 — deteção de kind por palavras-chave', () => {
  assert.equal(detectKind('Faz um site sobre gatos'), 'web')
  assert.equal(detectKind('Cria uma landing page'), 'web')
  assert.equal(detectKind('Pesquisa as tendências de design 2026'), 'research')
  assert.equal(detectKind('Refatora o algoritmo e corrige a lógica'), 'logic')
  assert.equal(detectKind('Olá, tudo bem?'), 'generic')
})

test('T4b — deteção de dificuldade (heurística)', () => {
  assert.equal(detectDifficulty('Faz um site sobre gatos'), 'simple')
  assert.equal(detectDifficulty('Cria uma landing page'), 'simple')
  // amplitude → sobe de nível (nunca desce a simple)
  const hard = detectDifficulty(
    'Pesquisa tendências de design e cria um dashboard com login, base de dados postgres, api de pagamentos stripe, websocket em tempo real e notificações por email',
  )
  assert.ok(['hard', 'complex'].includes(hard), `esperado hard/complex, obtido ${hard}`)
})

test('T4c — deteção de idioma', () => {
  assert.equal(detectLang('Faz um site sobre gatos'), 'pt')
  assert.equal(detectLang('Create a website about cats'), 'en')
})

test('T5 — extractFiles apanha extensões comuns', () => {
  const files = extractFiles('edita o src/index.html e o styles.css, ignora o logo.png')
  assert.deepEqual(files, ['src/index.html', 'styles.css', 'logo.png'])
})

test('T5b — extractIntent remove saudações/filler e limita o tamanho', () => {
  assert.equal(extractIntent('Olá, faz um site'), 'faz um site')
  const long = 'x'.repeat(300)
  assert.equal(extractIntent(long).length, 120)
  assert.ok(extractIntent(long).endsWith('…'))
})

test('T6 — caracteres perigosos são sanitized (formato nunca quebra)', () => {
  const malicious = 'cria um site | k:web | d:complex com "cenas" e:\nlinhas'
  const toon = parseRequestToTOON(malicious)
  assert.equal(toon.includes('\n'), false)
  // round-trip continua íntegro: exatamente 6 registos no máximo
  const parts = toon.split('|')
  assert.ok(parts.length <= 6, `TOON com ${parts.length} registos (esperado ≤6): ${toon}`)
  for (const part of parts) {
    assert.ok(part.includes(':'), `registo sem chave: "${part}"`)
  }
  // o intent sanitized não contém os delimitadores
  const task = parseToon(toon)
  assert.equal(task.intent.includes('|'), false)
})

test('T7 — toonToString com notes inclui o campo n', () => {
  const task = buildToonTask('Faz um site de gatos')
  task.notes = ['tema claro', 'sem imagens pesadas']
  const toon = toonToString(task)
  assert.match(toon, /\|n:tema claro,sem imagens pesadas$/)
})

test('T8 — isConversational separa conversa de trabalho', () => {
  assert.equal(isConversational('Olá, como estás hoje?'), true)
  assert.equal(isConversational('obrigado, ficou ótimo!'), true)
  assert.equal(isConversational('Faz um site sobre gatos'), false)
  assert.equal(isConversational('Cria uma landing page'), false)
  assert.equal(isConversational('mostra o estado do projeto'), false)
})
