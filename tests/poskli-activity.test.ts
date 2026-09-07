// ============================================================
// POSKLI ACTIVITY + MODES — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-activity.test.ts
// Linguagem de produto na UI (reconstrução agêntica):
//   A1. toolCalls traduzidas para frases amigáveis
//   A2. NENHUM label contém nomes técnicos de modelos
//   A3. estado running/failed/asked derivado do status
//   A4. modos do seletor: 4 opções, sem nomes técnicos,
//       valores válidos no chain do backend
//   A5. game-format: resumo Godot honesto (erros vs OK vs
//       CLI indisponível)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { translateActivity, isFriendlyActivityLabel } from '../src/lib/poskli-activity.ts'
import { POSKLI_VERSION_OPTIONS, readStoredPoskliVersion, poskliVersionOption } from '../src/lib/poskli-version.ts'
import { POSKLI_VERSIONS, DEFAULT_POSKLI_VERSION } from '../src/lib/studio/models/chain.ts'
import { summarizeGodotOutput, godotUnavailableMessage } from '../src/lib/studio/tools/game-format.ts'

test('A1 — ações das tools viram frases amigáveis de progresso', () => {
  const cases: Array<[string, string]> = [
    ['create_file', 'A criar arquivo…'],
    ['modify_file', 'A editar arquivo…'],
    ['run_tests', 'A executar testes…'],
    ['run_command', 'A executar comando…'],
    ['read_file', 'A ler arquivo…'],
    ['godot_check', 'A validar o jogo (Godot)…'],
    ['ask_user_question', 'Pergunta respondida'],
    ['git_commit', 'A criar ponto de restauração…'],
    ['web_search', 'A pesquisar na web…'],
    ['generate_image', 'A gerar imagens…'],
  ]
  for (const [tool, expected] of cases) {
    const item = translateActivity({ tool, status: 'OK', createdAt: new Date().toISOString() })
    assert.equal(item.label, expected, `${tool} → ${expected}`)
  }
  // pergunta PENDENTE aguarda resposta (modal aberto)
  const waiting = translateActivity({ tool: 'ask_user_question', status: 'PENDING', createdAt: '' })
  assert.equal(waiting.label, 'Aguardando sua resposta…')
  // caminho do arquivo aparece como detalhe
  const withPath = translateActivity({ tool: 'create_file', status: 'OK', createdAt: '', path: 'src/main.js' })
  assert.equal(withPath.detail, 'src/main.js')
  // caminho longo é cortado
  const longPath = translateActivity({ tool: 'modify_file', status: 'OK', createdAt: '', path: 'a'.repeat(80) })
  assert.ok((longPath.detail ?? '').length <= 48)
  // comando aparece como detalhe (Activity Log do chat)
  const withCmd = translateActivity({ tool: 'run_command', status: 'OK', createdAt: '', command: 'npm test' })
  assert.equal(withCmd.detail, 'npm test')
  const withTestCmd = translateActivity({ tool: 'run_tests', status: 'OK', createdAt: '', command: 'node --test test/' })
  assert.equal(withTestCmd.detail, 'node --test test/')
  // comando longo é cortado
  const longCmd = translateActivity({ tool: 'run_command', status: 'OK', createdAt: '', command: 'npx '.repeat(30) })
  assert.ok((longCmd.detail ?? '').length <= 48)
  // termo de busca aparece como detalhe
  const withQuery = translateActivity({ tool: 'search_code', status: 'OK', createdAt: '', query: 'gameOver' })
  assert.equal(withQuery.detail, 'gameOver')
})

test('A2 — NENHUM label/detalhe expõe nomes técnicos de modelos', () => {
  const tools = [
    'create_file', 'modify_file', 'delete_file', 'create_directory', 'run_tests', 'run_command',
    'read_file', 'search_code', 'list_files', 'get_project_status', 'godot_check',
    'ask_user_question', 'git_commit', 'git_status', 'git_diff', 'git_log',
    'git_create_branch', 'git_push', 'github_create_branch', 'create_pull_request',
    'web_search', 'generate_image',
    'ferramenta_desconhecida',
  ]
  for (const tool of tools) {
    for (const status of ['OK', 'PENDING', 'ERROR']) {
      const item = translateActivity({ tool, status, createdAt: '' })
      assert.ok(isFriendlyActivityLabel(item.label), `label amigável para ${tool}/${status}: ${item.label}`)
    }
  }
})

test('A3 — estado running/failed/asked derivado corretamente', () => {
  const running = translateActivity({ tool: 'create_file', status: 'PENDING', createdAt: '' })
  assert.ok(running.running)

  const failed = translateActivity({ tool: 'run_command', status: 'ERROR', createdAt: '' })
  assert.ok(failed.failed)
  assert.ok(!failed.running)

  const asked = translateActivity({ tool: 'ask_user_question', status: 'PENDING', createdAt: '' })
  assert.ok(asked.asked)
  assert.ok(asked.running)

  const done = translateActivity({ tool: 'run_tests', status: 'OK', createdAt: '' })
  assert.ok(!done.running && !done.failed && !done.asked)
})

test('A4 — seletor de MODOS: 4 opções amigáveis, valores válidos no backend', () => {
  assert.equal(POSKLI_VERSION_OPTIONS.length, 4, 'exatamente 4 modos no seletor')
  const labels = POSKLI_VERSION_OPTIONS.map((o) => o.short)
  assert.deepEqual(labels, ['Normal', 'Padrão', 'Avançado', 'Superagente'])

  // valores continuam válidos para o chain do backend
  for (const opt of POSKLI_VERSION_OPTIONS) {
    assert.ok((POSKLI_VERSIONS as readonly string[]).includes(opt.value), `valor ${opt.value} aceito pelo backend`)
  }
  // o modo Padrão mapeia ao default do backend
  const padrao = POSKLI_VERSION_OPTIONS.find((o) => o.short === 'Padrão')
  assert.equal(padrao?.value, DEFAULT_POSKLI_VERSION)

  // 1.0-flash saiu do seletor (modo interno via env), superagent destaca
  assert.ok(!POSKLI_VERSION_OPTIONS.some((o) => o.value === '1.0-flash'))
  const superagente = poskliVersionOption('superagent')
  assert.ok(superagente?.highlight, 'superagent mantém badge violeta (highlight)')
  assert.ok(POSKLI_VERSION_OPTIONS.filter((o) => o.highlight).length === 1, 'apenas 1 destaque')

  // ZERO nomes técnicos em short/detail/description
  const technical = /(glm|qwen|hy3|nemotron|deepseek|gpt|oss|luna|nvidia|b\.ai|provider|flash)/i
  for (const opt of POSKLI_VERSION_OPTIONS) {
    assert.ok(!technical.test(opt.short), `short limpo: ${opt.short}`)
    assert.ok(!technical.test(opt.detail), `detail limpo: ${opt.detail}`)
    assert.ok(!technical.test(opt.description), `description limpa: ${opt.description}`)
  }

  // localStorage inexistente no node → null (sem crash)
  assert.equal(readStoredPoskliVersion(), null)
  assert.equal(poskliVersionOption('1.0-flash'), null, '1.0-flash fora do seletor UI')
})

test('A5 — game-format: saída Godot resumida com honestidade', () => {
  const bad = summarizeGodotOutput(
    'Godot Engine v4.3.steam\nSCRIPT ERROR: Parse Error: Unexpected token in main.gd:12\nAt: main.gd:12\nOpenGL Vulkan CUDA Bluetooth',
    ''
  )
  assert.ok(bad.hasErrors)
  assert.ok(bad.errorCount >= 1)
  assert.match(bad.text, /ERROS DETECTADOS/)
  assert.match(bad.text, /main\.gd:12/)

  const ok = summarizeGodotOutput('Godot Engine v4.3\nOpenGL initialized\n', '')
  assert.ok(!ok.hasErrors)
  assert.match(ok.text, /GODOT OK/)

  const unavailable = godotUnavailableMessage('spawn godot ENOENT')
  assert.match(unavailable, /GODOT_INDISPONÍVEL/)
  assert.match(unavailable, /NÃO tente simular o Godot/i)
  assert.match(unavailable, /DOCUMENTE/i)
})
