// ============================================================
// POSKLI CHAT EVENTS — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-chat-events.test.ts
// Chat conversacional (reconstrução Grok/ChatGPT):
//   B1. estados do run → frases NATURAIS (nunca rótulos de
//       estágio: "IMPLEMENTANDO", "REVISANDO", …)
//   B2. quota 429 → mensagem exata do produto, sem loops
//   B3. serialização defensiva do resultado (nunca [object Object])
//   B4. deriveChatEvents: snapshot → eventos do stream (state,
//       activity, question, quota, result, done)
//   B5. encodeSseEvent: formato SSE parseável
//   B6. eventos SEM nomes técnicos (chat limpo)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  friendlyRunState, isChatTerminal, isThinkingState,
  isQuotaErrorCode, QUOTA_EXHAUSTED_MESSAGE, safeRunResult,
  deriveChatEvents, encodeSseEvent, activityToChatEvent, isFriendlyChatLabel, chatAgentLabel,
  type ChatRunSnapshot,
} from '../src/lib/poskli-chat.ts'

test('B1 — estados viram frases naturais (SEM rótulos de estágio)', () => {
  const cases: Array<[string, string]> = [
    ['ANALYZING', 'A analisar o pedido…'],
    ['PLANNING', 'A planear o trabalho…'],
    ['IMPLEMENTING', 'A escrever código…'],
    ['TESTING', 'A executar testes…'],
    ['VERIFYING', 'A verificar o resultado…'],
    ['COMPLETED', 'Concluído'],
    ['FAILED', 'Não consegui concluir'],
    ['BLOCKED', 'Bloqueado'],
    ['PARTIAL', 'Concluído parcialmente'],
    ['CANCELLED', 'Cancelado'],
  ]
  for (const [state, label] of cases) {
    assert.equal(friendlyRunState(state), label, `${state} → ${label}`)
  }
  // runs ANTIGOS (legacy REVIEWING/CORRECTING) também ficam naturais
  assert.equal(friendlyRunState('REVIEWING'), 'A melhorar o código…')
  assert.equal(friendlyRunState('CORRECTING'), 'A melhorar o código…')
  // estado desconhecido não crasha
  assert.ok(friendlyRunState('XPTO').length > 0)

  // NUNCA aparece o rótulo de estágio em NENHUM label
  const allStates = ['ANALYZING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'CORRECTING', 'VERIFYING',
    'COMPLETED', 'FAILED', 'BLOCKED', 'PARTIAL', 'CANCELLED', 'PENDING', 'RUNNING']
  for (const s of allStates) {
    const label = friendlyRunState(s)
    assert.ok(isFriendlyChatLabel(label), `label de chat limpo para ${s}: ${label}`)
  }

  // classificação terminal/pensamento
  for (const s of ['COMPLETED', 'FAILED', 'BLOCKED', 'PARTIAL', 'CANCELLED']) {
    assert.ok(isChatTerminal(s), `${s} é terminal`)
  }
  assert.ok(!isChatTerminal('IMPLEMENTING'), 'IMPLEMENTING não é terminal')
  assert.ok(isThinkingState('ANALYZING') && isThinkingState('PLANNING'), 'análise/planamento = pensando')
  assert.ok(!isThinkingState('IMPLEMENTING'), 'implementação não é "pensando"')
})

test('B2 — quota 429: mensagem exata do produto (STOP honesto)', () => {
  assert.equal(QUOTA_EXHAUSTED_MESSAGE, 'A cota do modelo acabou. A mudar para o modelo reserva…')
  assert.ok(isQuotaErrorCode('QUOTA_EXHAUSTED'))
  assert.ok(isQuotaErrorCode('PROVIDER_RATE_LIMIT'))
  assert.ok(!isQuotaErrorCode('TASK_FAILED'))
  assert.ok(!isQuotaErrorCode(null))
  assert.ok(!isQuotaErrorCode(undefined))
})

test('B3 — resultado serializado defensivamente (nunca [object Object])', () => {
  assert.equal(safeRunResult('texto puro'), 'texto puro')
  assert.equal(safeRunResult({ output: 'resultado markdown' }), 'resultado markdown')
  assert.equal(safeRunResult({ result: 'via result' }), 'via result')
  assert.equal(safeRunResult({ message: 'via message' }), 'via message')
  assert.equal(safeRunResult(null), '')
  assert.equal(safeRunResult(undefined), '')
  assert.equal(safeRunResult(42), '42')
  // objeto sem campos conhecidos → JSON legível (não [object Object])
  assert.equal(safeRunResult({ a: 1 }), '{"a":1}')
})

test('B4 — deriveChatEvents: snapshot → eventos do stream', () => {
  // run ATIVO: state + atividades + pergunta (sem result/done)
  const active: ChatRunSnapshot = {
    run: { id: 'r1', state: 'IMPLEMENTING', errorCode: null, error: null, result: null },
    activity: [
      { id: 'a1', tool: 'read_file', status: 'OK', createdAt: '2026-01-01T00:00:01Z', path: 'src/main.js' },
      { id: 'a2', tool: 'create_file', status: 'PENDING', createdAt: '2026-01-01T00:00:02Z', path: 'src/index.html' },
    ],
    pendingQuestion: null,
  }
  const events = deriveChatEvents(active)
  const types = events.map((e) => e.type)
  assert.ok(types.includes('state'), 'evento de estado presente')
  assert.equal(types.filter((t) => t === 'activity').length, 2, 'duas atividades')
  assert.ok(!types.includes('done'), 'run ativo não emite done')
  assert.ok(!types.includes('result'), 'run ativo não emite resultado')

  // pergunta pendente → evento question (modal)
  const withQuestion: ChatRunSnapshot = {
    ...active,
    pendingQuestion: { toolCallId: 't1', questions: [{ header: 'Controles', question: 'Toque ou teclado?' }] },
  }
  const qEvents = deriveChatEvents(withQuestion)
  const q = qEvents.find((e) => e.type === 'question')
  assert.ok(q, 'evento question presente')

  // run TERMINAL com resultado → result + done
  const done: ChatRunSnapshot = {
    run: {
      id: 'r1', state: 'COMPLETED', errorCode: null, error: null,
      result: { output: '## Resultado do Poskli\nTudo ok' },
    },
    activity: [{ id: 'a1', tool: 'run_tests', status: 'OK', createdAt: '', command: 'npm test' }],
    pendingQuestion: null,
  }
  const doneEvents = deriveChatEvents(done)
  const result = doneEvents.find((e) => e.type === 'result')
  assert.ok(result && (result as { message: string }).message.includes('Resultado do Poskli'))
  const doneEv = doneEvents.find((e) => e.type === 'done')
  assert.ok(doneEv && (doneEv as { state: string }).state === 'COMPLETED')

  // quota → evento quota ANTES do done
  const quota: ChatRunSnapshot = {
    run: { id: 'r2', state: 'FAILED', errorCode: 'QUOTA_EXHAUSTED', error: null, result: null },
    activity: [],
    pendingQuestion: null,
  }
  const quotaEvents = deriveChatEvents(quota)
  const quotaEv = quotaEvents.find((e) => e.type === 'quota')
  assert.ok(quotaEv)
  assert.equal((quotaEv as { message: string }).message, QUOTA_EXHAUSTED_MESSAGE)
  assert.ok(quotaEvents.map((e) => e.type).includes('done'))
})

test('B5 — encodeSseEvent: frames SSE parseáveis (event + data)', () => {
  const frame = encodeSseEvent({ type: 'state', state: 'ANALYZING', label: 'A analisar o pedido…' })
  assert.ok(frame.endsWith('\n\n'), 'frame termina com linha em branco')
  const lines = frame.trim().split('\n')
  assert.equal(lines[0], 'event: state')
  assert.ok(lines[1].startsWith('data: '))
  const payload = JSON.parse(lines[1].slice('data: '.length))
  assert.equal(payload.state, 'ANALYZING')

  // round-trip de todos os tipos
  const frames = [
    encodeSseEvent({ type: 'thinking', seconds: 3 }),
    encodeSseEvent({ type: 'activity', activity: { id: 'a1', tool: 'create_file', label: 'A criar arquivo…', status: 'OK', running: false, failed: false } }),
    encodeSseEvent({ type: 'question', question: { toolCallId: 't1', questions: [] } }),
    encodeSseEvent({ type: 'quota', message: QUOTA_EXHAUSTED_MESSAGE }),
    encodeSseEvent({ type: 'result', message: '# ok', state: 'COMPLETED' }),
    encodeSseEvent({ type: 'done', state: 'COMPLETED' }),
  ]
  for (const f of frames) {
    const [eventLine, dataLine] = f.trim().split('\n')
    assert.ok(eventLine.startsWith('event: '), 'linha event:')
    assert.ok(dataLine.startsWith('data: '), 'linha data:')
    JSON.parse(dataLine.slice(6)) // não lança
  }
})

test('B6 — atividade do chat SEM nomes técnicos e SEM código cru', () => {
  const ev = activityToChatEvent({ id: 'a1', tool: 'create_file', status: 'OK', createdAt: '', path: 'src/index.html' })
  assert.equal(ev.label, 'A criar arquivo…')
  assert.equal(ev.detail, 'src/index.html')
  assert.ok(!ev.running && !ev.failed)

  const web = activityToChatEvent({ id: 'a2', tool: 'web_search', status: 'PENDING', createdAt: '' })
  assert.equal(web.label, 'A pesquisar na web…')
  assert.ok(web.running)

  const img = activityToChatEvent({ id: 'a3', tool: 'generate_image', status: 'PENDING', createdAt: '' })
  assert.equal(img.label, 'A gerar imagens…')

  const cmd = activityToChatEvent({ id: 'a4', tool: 'run_command', status: 'PENDING', createdAt: '', command: 'npm test' })
  assert.equal(cmd.label, 'A executar comando…')
  assert.equal(cmd.detail, 'npm test')

  const failed = activityToChatEvent({ id: 'a5', tool: 'run_tests', status: 'ERROR', createdAt: '' })
  assert.ok(failed.failed)

  // labels de todos os eventos são amigáveis
  for (const e of [ev, web, img, cmd, failed]) {
    assert.ok(isFriendlyChatLabel(e.label), `label limpa: ${e.label}`)
  }
})

// ---------- FASES VISÍVEIS: plano + delegação (refactor) ----------

test('B7 — FASE VISÍVEL: plano com passos numerados após PLANNING (nunca durante o pensamento)', () => {
  const snap: ChatRunSnapshot = {
    run: { id: 'r1', state: 'IMPLEMENTING', errorCode: null, error: null, result: null },
    activity: [],
    pendingQuestion: null,
    plan: {
      architecture: 'Landing page estática com CSS moderno',
      tasks: [
        { title: 'Criar estrutura', agentRole: 'coding' },
        { title: 'Implementar conteúdo', agentRole: 'coding' },
        { title: 'Testar tudo', agentRole: 'testing' },
        { title: 'Rever qualidade', agentRole: 'review' },
      ],
    },
    tasks: [],
  }
  const events = deriveChatEvents(snap)
  const plan = events.find((e) => e.type === 'plan')
  assert.ok(plan, 'evento plan presente')
  const p = plan as { steps: Array<{ title: string; agent: string }>; architecture?: string }
  assert.equal(p.steps.length, 4)
  assert.equal(p.steps[0].title, 'Criar estrutura')
  assert.equal(p.steps[0].agent, 'agente de programação')
  assert.equal(p.steps[2].agent, 'agente de testes')
  assert.equal(p.steps[3].agent, 'agente de revisão')
  assert.equal(p.architecture, 'Landing page estática com CSS moderno')

  // durante ANALYZING/PLANNING o plano AINDA não aparece (fase de
  // análise visível primeiro — "A analisar o pedido…")
  const thinking = deriveChatEvents({ ...snap, run: { ...snap.run, state: 'ANALYZING' } })
  assert.ok(!thinking.some((e) => e.type === 'plan'), 'sem plano durante a análise')

  // títulos-objeto (defensivo) não crasham
  const weird = deriveChatEvents({
    ...snap,
    plan: { tasks: [{ title: { complex: 'objeto' }, agentRole: 'coding' }] },
  })
  const wp = weird.find((e) => e.type === 'plan') as { steps: Array<{ title: string }> }
  assert.equal(typeof wp.steps[0].title, 'string')
})

test('B8 — FASE VISÍVEL: delegações por tarefa (idempotente por taskId, ordem do grafo)', () => {
  const snap: ChatRunSnapshot = {
    run: { id: 'r1', state: 'IMPLEMENTING', errorCode: null, error: null, result: null },
    activity: [],
    pendingQuestion: null,
    tasks: [
      { id: 't1', title: 'Criar estrutura', agentRole: 'coding', status: 'COMPLETED' },
      { id: 't2', title: 'Implementar conteúdo', agentRole: 'coding', status: 'RUNNING' },
      { id: 't3', title: 'Testar tudo', agentRole: 'testing', status: 'PENDING' },
    ],
  }
  const events = deriveChatEvents(snap)
  const delegations = events.filter((e) => e.type === 'delegation') as Array<{
    taskId: string; title: string; agent: string; status: string
  }>
  assert.equal(delegations.length, 3, 'uma delegação por tarefa')
  assert.equal(delegations[0].taskId, 't1')
  assert.equal(delegations[0].status, 'COMPLETED')
  assert.equal(delegations[1].agent, 'agente de programação')
  assert.equal(delegations[2].agent, 'agente de testes')
  // reprocessar o MESMO snapshot → mesmas delegações (idempotente)
  assert.equal(deriveChatEvents(snap).filter((e) => e.type === 'delegation').length, 3)
  // sem tarefas → sem delegações
  assert.equal(deriveChatEvents({ ...snap, tasks: [] }).filter((e) => e.type === 'delegation').length, 0)
})

test('B9 — ordem das fases no stream: state → plan → delegations → activity → terminal', () => {
  const snap: ChatRunSnapshot = {
    run: { id: 'r1', state: 'COMPLETED', errorCode: null, error: null, result: { output: 'ok' } },
    activity: [{ id: 'a1', tool: 'create_file', status: 'OK', createdAt: '', path: 'index.html' }],
    pendingQuestion: null,
    plan: { tasks: [{ title: 'Estrutura', agentRole: 'coding' }] },
    tasks: [{ id: 't1', title: 'Estrutura', agentRole: 'coding', status: 'COMPLETED' }],
  }
  const types = deriveChatEvents(snap).map((e) => e.type)
  const idx = (t: (typeof types)[number]) => types.indexOf(t)
  assert.ok(idx('state') < idx('plan'), 'estado antes do plano')
  assert.ok(idx('plan') < idx('delegation'), 'plano antes das delegações')
  assert.ok(idx('delegation') < idx('activity'), 'delegações antes das ações')
  assert.ok(idx('activity') < idx('result'), 'ações antes do resultado')
  assert.equal(types[types.length - 1], 'done', 'done é o último')
})

test('B10 — labels de agente: chatAgentLabel sem nomes técnicos de modelos', () => {
  assert.equal(chatAgentLabel('coding'), 'agente de programação')
  assert.equal(chatAgentLabel('testing'), 'agente de testes')
  assert.equal(chatAgentLabel('review'), 'agente de revisão')
  assert.equal(chatAgentLabel('github'), 'agente de publicação')
  assert.equal(chatAgentLabel('master'), 'orquestrador')
  assert.equal(chatAgentLabel('qualquer'), 'agente especializado')
  // nenhum label expõe nomes técnicos
  for (const role of ['coding', 'testing', 'review', 'github', 'master', 'x']) {
    assert.ok(isFriendlyChatLabel(chatAgentLabel(role)), `label limpo para ${role}`)
  }
})
