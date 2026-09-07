// ============================================================
// FAST PLAN — TESTES (node:test, PURO)
// Executar: node --test tests/poskli-fast-plan.test.ts
// FIX do travamento "A pensar durante 45s…":
//   F1. pedidos claros de construção → fast + pesquisa OPCIONAL
//   F2. pedidos com informação externa → suggested (mas opcional
//       na prática: falha de pesquisa nunca bloqueia)
//   F3. pedidos neutros → plano 1º-2º passo, ferramentas opcionais
//   F4. REGRESSÃO de prompt: master NÃO obriga pesquisa antes de
//       planear; ferramentas são OPCIONAIS (decisão autónoma)
//   F5. orquestrador usa o hint (objetivo da análise contém RITMO)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { planModeFor, isSimpleBuildRequest } from '../src/lib/studio/poskli/fast-plan.ts'
import { SYSTEM_PROMPTS } from '../src/lib/studio/agents/prompts.ts'
import { webSearchTool } from '../src/lib/studio/tools/web-tools.ts'

test('F1 — pedido claro de construção → fast:true, pesquisa opcional, hint de 1º passo', () => {
  for (const req of [
    'Cria uma landing page',
    'Faz um site sobre gatos',
    'Cria uma app de tarefas',
    'Faz um jogo de nave',
    'Cria um dashboard de vendas',
  ]) {
    const mode = planModeFor(req)
    assert.equal(mode.fast, true, `"${req}" deve ser fast`)
    assert.equal(mode.webSearch, 'optional')
    assert.match(mode.hint, /PRIMEIRO PASSO/i)
  }
  assert.equal(isSimpleBuildRequest('Cria uma landing page'), true)
})

test('F2 — pedido que depende de informação externa → pesquisa sugerida (opcional na prática)', () => {
  for (const req of [
    'Pesquisa as tendências de design para 2026 e faz um site',
    'Compara preços de domínios e cria um blog',
    'Site com as últimas notícias de IA',
  ]) {
    const mode = planModeFor(req)
    assert.equal(mode.webSearch, 'suggested', `"${req}" sugere pesquisa`)
    assert.match(mode.hint, /opcional/i, 'mesmo sugerida, é opcional (nunca bloqueia)')
    assert.match(mode.hint, /PROSSIGA/i)
  }
})

test('F3 — pedido neutro/complexo → análise mínima, ferramentas opcionais', () => {
  const mode = planModeFor('Refatora o módulo de autenticação e corrige o bug de login')
  assert.equal(mode.fast, false)
  assert.equal(mode.webSearch, 'optional')
  assert.match(mode.hint, /MÍNIMO/i)
  // pedido vazio/curto → default seguro
  assert.equal(planModeFor('').fast, false)
})

test('F4 — REGRESSÃO de prompt: master não obriga pesquisa; tools são OPCIONAIS', () => {
  const master = SYSTEM_PROMPTS.master
  // o mandato antigo ("faça UMA pesquisa ANTES de planejar") sumiu
  assert.ok(!/faça UMA pesquisa com web_search ANTES/i.test(master), 'sem mandato de pesquisa')
  assert.ok(!/ANTES de planejar \(ex\./i.test(master), 'sem exemplo de pesquisa obrigatória')
  // novo contrato: ferramentas opcionais + prosseguir sem pesquisa
  assert.match(master, /FERRAMENTAS SÃO OPCIONAIS/i)
  assert.match(master, /PROSSIGA SEM pesquisar/i)
  assert.match(master, /VELOCIDADE/i, 'seção anti-travamento presente')
  // coding idem: pesquisa best-effort
  assert.match(SYSTEM_PROMPTS.coding, /OPCIONAL e BEST-EFFORT/i)
  assert.match(SYSTEM_PROMPTS.coding, /nunca bloqueie a tarefa/i)
  // descrição da tool declara-se OPCIONAL
  assert.match(webSearchTool.description, /OPCIONAL/i)
})

test('F5 — hint é texto não-vazio utilizável no objetivo do master', () => {
  for (const req of ['Cria uma landing page', 'Pesquisa tendências e cria um site', 'Refatora X']) {
    const mode = planModeFor(req)
    assert.ok(mode.hint.length > 40, 'hint substancial')
    assert.ok(!mode.hint.includes('\n'), 'hint é uma linha única')
  }
})
