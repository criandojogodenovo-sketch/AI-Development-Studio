// ============================================================
// AGENTS / BASE — Motor de execução de agentes (loop ReAct)
//
// Fluxo: THOUGHT → ACTION (tool JSON) → OBSERVATION → ...
// até "final" OU limite (maxSteps / maxToolCalls / timeout /
// maxRetries / REPEATED_FAILURE detectado).
// Todo o passo a passo é registrado em AgentRun.log.
// ============================================================

import { db } from '@/lib/db'
import { modelRouter } from '../models/router'
import { STUDIO_CONFIG } from '../config'
import { runTool, getTool, toolsForPermissions } from '../tools'
import { toolToSchema, type ToolCtx } from '../tools/types'
import { emitEvent } from '../events/bus'
import { compressHistory } from '../context/context-manager'
import { clipToolOutput } from '../context/clip.ts'
import {
  shouldAutoCompact, compactConversation, agentProgressFromSteps, slimContextMessage,
} from '../context/compaction.ts'

/** Nome de produto do agente para mensagens de evento (server-side). */
function agentDisplayName(agentId: string): string {
  const names: Record<string, string> = {
    master: 'Planejador',
    coding: 'Engenheiro de Implementação',
    testing: 'Verificador de Testes',
    review: 'Revisor de Qualidade',
    github: 'Agente de Publicação',
  }
  return names[agentId] ?? 'Agente'
}
import { RepeatedFailureDetector } from '../orchestrator/loop-detector'
import { touchPoskliActivity } from '../poskli/stall-watchdog-core.ts'
import type { AgentDefinition } from './definitions'
import type { ChatMessage } from '../models/types'

export interface AgentStepLog {
  step: number
  thought?: string
  tool?: string
  args?: Record<string, unknown>
  observation?: string
  ok?: boolean
  ts: string
}

export interface AgentRunInput {
  agent: AgentDefinition
  projectId: string
  workspaceRoot: string
  taskId?: string
  runType?: 'PLAN' | 'TASK' | 'TEST' | 'REVIEW' | 'FIX'
  objective: string          // instrução principal
  contextBlock?: string      // arquivos relevantes, memória, etc.
  extraMessages?: ChatMessage[]
  /** Run do Poskli (interatividade ask_user_question + cancelamento). */
  poskliRunId?: string
  /** Orçamento por NÍVEL (FASE 2 — 0.1/0.2/0.3.1/1.0-flash/superagent):
   *  clampa maxSteps e timeoutMs do agente. Ausente → usa a definição.
   *  DELEGAÇÃO (subagentes): maxToolCalls e tokenBudget são
   *  orçamentos ESPECÍFICOS do subagente (coding 20/30k,
   *  testing 5/10k, review 5/10k) — ver poskli/delegation.ts. */
  budget?: {
    maxSteps: number
    agentTimeoutMs: number
    /** teto de tool calls do subagente (menor vence com toolBudget). */
    maxToolCalls?: number
    /** orçamento de tokens IN+OUT do subagente — excedeu → para
     *  honestamente com "Orçamento atingido, a terminar". */
    tokenBudget?: number
  }
}

export interface AgentRunOutput {
  status: 'COMPLETED' | 'FAILED' | 'REPEATED_FAILURE' | 'MAX_LIMITS_REACHED' | 'TIMEOUT'
  result: string
  steps: AgentStepLog[]
  tokensIn: number
  tokensOut: number
  durationMs: number
  runId: string
  error?: string
}

/**
 * Repara JSONs gerados por LLM: escapa quebras de linha/tabs literais
 * dentro de strings, remove vírgulas pendentes e fecha objetos truncados.
 */
function repairJson(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '"') { inString = false; out += ch }
      else if (ch === '\\') { out += ch + (text[i + 1] ?? ''); i++ }
      else if (ch === '\n') out += '\\n'
      else if (ch === '\r') out += '\\r'
      else if (ch === '\t') out += '\\t'
      else out += ch
    } else {
      if (ch === '"') { inString = true; out += ch }
      else out += ch
    }
  }
  out = out.replace(/,\s*([}\]])/g, '$1')
  return out
}

/** Fecha JSON truncado (conteúdo cortado por max_tokens). */
function closeTruncatedJson(text: string): string {
  const repaired = repairJson(text)
  let braces = 0
  let brackets = 0
  let inString = false
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') braces++
    else if (ch === '}') braces--
    else if (ch === '[') brackets++
    else if (ch === ']') brackets--
  }
  let closed = repaired
  if (inString) closed += '"'
  closed += ']'.repeat(Math.max(0, brackets)) + '}'.repeat(Math.max(0, braces))
  return closed
}

/** Extração robusta de JSON (cercas, texto ao redor, newlines literais, truncamento). */
export function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null
  const trimmed = text.trim()
  const candidates: string[] = []
  // 1) JSON direto
  candidates.push(trimmed)
  // 2) bloco json em cercas
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) candidates.push(fence[1].trim())
  // 3) primeiro { até último }
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1))
  // 4) objeto iniciando em {"thought (respostas ReAct)
  const thought = trimmed.match(/\{"thought"[\s\S]*\}/)
  if (thought) candidates.push(thought[0])

  // 5) versões REPARADAS (newlines literais, vírgulas pendentes)
  // 6) versão FECHADA (truncamento)
  const attempts: string[] = [...candidates]
  for (const c of candidates) attempts.push(repairJson(c))
  attempts.push(closeTruncatedJson(trimmed))

  for (const c of attempts) {
    if (!c) continue
    try {
      const parsed = JSON.parse(c)
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* tenta próximo candidato */ }
  }
  return null
}

export class AgentRunner {
  private steps: AgentStepLog[] = []
  private tokensIn = 0
  private tokensOut = 0
  private toolCallCount = 0
  private protocolErrors = 0
  private detector = new RepeatedFailureDetector()
  // Detecção de AÇÃO repetida (mesma tool+args, mesmo com sucesso)
  private actionCounts = new Map<string, number>()
  // Cache de leituras por run: read_file repetido → observação curta
  private readCache = new Map<string, number>() // path → último step em que foi lido
  // FIX do travamento: ferramentas BEST-EFFORT — falha/repetição
  // NUNCA derruba o run (web_search degrada para vazio; o agente
  // prossegue sem pesquisar em vez de ficar preso)
  private static readonly BEST_EFFORT_TOOLS: ReadonlySet<string> = new Set(['web_search'])
  private runId!: string
  private startedAt = Date.now()
  private deadline: number
  // Teto EFETIVO de passos (menor entre agente e orçamento por nível)
  private readonly effectiveMaxSteps: number
  // FASE 2 — auditoria: após 3 passos, o bloco inicial de contexto
  // (arquivos+schemas ~30k chars) é emagrecido para estado — corta
  // a média medida de 4.271 tokens IN/passo.
  private static readonly SLIM_AFTER_STEPS = 3

  constructor(private input: AgentRunInput) {
    const agent = input.agent
    this.effectiveMaxSteps = input.budget
      ? Math.max(1, Math.min(agent.maxSteps, input.budget.maxSteps))
      : agent.maxSteps
    const timeout = input.budget ? Math.min(agent.timeoutMs, input.budget.agentTimeoutMs) : agent.timeoutMs
    this.deadline = Date.now() + timeout
    // DELEGAÇÃO: teto de tool calls do subagente (menor vence)
    if (input.budget?.maxToolCalls) {
      this.toolBudget = Math.max(1, Math.min(this.toolBudget, input.budget.maxToolCalls))
    }
  }

  /** Executa o loop completo de um agente. */
  async run(): Promise<AgentRunOutput> {
    const { agent, objective, contextBlock, projectId, taskId } = this.input
    const run = await db.agentRun.create({
      data: {
        projectId,
        taskId: taskId ?? null,
        agentId: agent.id,
        model: modelRouter.modelForRole(agent.modelRole),
        runType: this.input.runType ?? 'TASK',
        status: 'RUNNING',
        log: [] as unknown as object,
      },
    })
    this.runId = run.id

    await emitEvent({
      type: 'agent.started',
      projectId,
      taskId,
      runId: this.runId,
      agent: agent.id,
      message: `${agent.name} iniciado: ${objective.slice(0, 150)}`,
    })

    const messages: ChatMessage[] = [
      { role: 'system', content: agent.systemPrompt },
    ]

    // Contexto: tools disponíveis (schema) + objetivo + contexto do projeto
    // FASE 2 — schemas COMPACTOS (JSON sem pretty-print cortava ~30%:
    // `null, 1` gastava indentação em TODA chamada)
    const available = (agent.allowedTools.includes('*')
      ? toolsForPermissions(agent.permissions)
      : agent.allowedTools.map((t) => getTool(t)).filter((t): t is NonNullable<typeof t> => Boolean(t))
    ).map(toolToSchema)

    messages.push({
      role: 'user',
      content: [
        '## OBJETIVO',
        objective,
        contextBlock ? '\n## CONTEXTO DO PROJETO\n' + contextBlock : '',
        '\n## FERRAMENTAS DISPONÍVEIS (use exatamente estes nomes)',
        JSON.stringify(available),
      ]
        .filter(Boolean)
        .join('\n'),
    })

    // FASE 2 — emagrecimento do contexto inicial: a partir do 4º
    // passo os arquivos já foram lidos via tools; a mensagem inicial
    // troca os blocões por OBJETIVO + estado (arquivos tocados/testes).
    let contextSlimmed = false
    const maybeSlimContext = () => {
      if (contextSlimmed || this.steps.length < AgentRunner.SLIM_AFTER_STEPS) return
      contextSlimmed = true
      const progress = agentProgressFromSteps(this.steps)
      messages[1] = {
        role: 'user',
        content: slimContextMessage(messages[1].content, progress, { keepFileList: true }),
      }
    }

    if (this.input.extraMessages?.length) messages.push(...this.input.extraMessages)

    let finalResult = ''
    let status: AgentRunOutput['status'] = 'COMPLETED'

    try {
      while (this.steps.length < this.effectiveMaxSteps) {
        // atividade REAL para o watchdog do run Poskli (cada passo
        // do agente conta — evita kill com TIMEOUT durante trabalho vivo)
        touchPoskliActivity(this.input.poskliRunId)
        // ---- LIMITES Duros ----
        if (Date.now() > this.deadline) {
          status = 'TIMEOUT'
          finalResult = `TIMEOUT: excedeu ${agent.timeoutMs}ms em ${this.steps.length} passos.`
          break
        }
        if (this.toolCallCount >= this.input.toolBudget) {
          status = 'MAX_LIMITS_REACHED'
          finalResult = `MAX_TOOL_CALLS: orçamento de ferramentas esgotado (${this.input.toolBudget}).`
          break
        }
        // FASE 2 — emagrece o contexto inicial quando aplicável
        maybeSlimContext()

        // ---- CHAMADA AO MODELO ----
        // Histórico comprimido (economia de tokens): observações curtas
        const { summary, recent } = compressHistory(
          this.steps.map((s) => ({ thought: s.thought, action: s.tool, observation: s.observation?.slice(0, 700) }))
        )
        const conversation: ChatMessage[] = [...messages]
        if (summary) conversation.push({ role: 'assistant', content: `[sistema] ${summary.slice(0, 3000)}` })
        for (const s of recent) {
          conversation.push({
            role: 'assistant',
            content: JSON.stringify({ thought: (s.thought ?? '').slice(0, 200), action: { tool: s.tool, args: s.args } }).slice(0, 1200),
          })
          conversation.push({ role: 'user', content: `[OBSERVAÇÃO] ${s.observation ?? ''}`.slice(0, 2100) })
        }
        // Re-educação NÃO-acumulativa: lembrança fixa quando há erros de protocolo
        if (this.protocolErrors > 0) {
          conversation.push({
            role: 'user',
            content: '[SISTEMA] Lembrete: responda SOMENTE com JSON no protocolo: {"thought":"...","action":{"tool":"nome","args":{...}}} ou {"final":true,"result":"..."}',
          })
        }
        // ---- COMPACTAÇÃO AUTOMÁTICA (75% da janela) — preserva ESTADO ----
        // Como Claude Code/Codex: o resumo antigo é substituído pelo estado
        // estruturado (arquivos tocados, testes, progresso) para o agente
        // NUNCA repetir trabalho já concluído após a compactação.
        if (shouldAutoCompact(conversation, STUDIO_CONFIG.context.windowTokens, STUDIO_CONFIG.context.compactAtRatio)) {
          const progress = agentProgressFromSteps(this.steps)
          const compacted = compactConversation(conversation, {
            keepLastTurns: STUDIO_CONFIG.context.compactKeepLastTurns,
            progress,
            pendingHint: `Última ferramenta: ${progress.lastTool ?? '—'}.`,
          })
          conversation.length = 0
          conversation.push(...compacted)
        }

        const completion = await modelRouter.chatRole(agent.modelRole, conversation, {
          temperature: agent.role === 'coding' ? 0.2 : 0.4,
          // maxTokens por papel: coding precisa de espaço para escrever arquivos
          maxTokens: agent.role === 'coding' ? 6000 : 3000,
        })
        this.tokensIn += completion.promptTokens
        this.tokensOut += completion.completionTokens
        // resposta do modelo recebida — atividade real p/ o watchdog
        touchPoskliActivity(this.input.poskliRunId)

        // ---- ORÇAMENTO DE TOKENS do subagente (delegação) ----
        // Excedeu → para honestamente: "Orçamento atingido, a terminar"
        const tokenBudget = this.input.budget?.tokenBudget
        if (tokenBudget && this.tokensIn + this.tokensOut >= tokenBudget) {
          status = 'MAX_LIMITS_REACHED'
          finalResult =
            `ORÇAMENTO_ATINGIDO: o subagente "${agent.id}" consumiu ${this.tokensIn + this.tokensOut} tokens ` +
            `(teto ${tokenBudget}). Orçamento atingido, a terminar — reporte o estado real do que foi feito.`
          await emitEvent({
            type: 'agent.budget',
            projectId,
            taskId,
            runId: this.runId,
            agent: agent.id,
            status: 'MAX_LIMITS_REACHED',
            message: `Orçamento do subagente ${agentDisplayName(agent.id)} atingido (${tokenBudget} tokens) — a terminar`,
            data: { tokensIn: this.tokensIn, tokensOut: this.tokensOut, tokenBudget },
          })
          break
        }

        // ---- TRUNCAMENTO detectado (finish_reason=length) ----
        if (completion.finishReason === 'length') {
          this.steps.push({
            step: this.steps.length + 1,
            thought: 'RESPOSTA TRUNCADA por max_tokens',
            observation: 'Sua resposta foi cortada por limite de tamanho. NÃO reescreva arquivos inteiros: use modify_file com searchText/replaceText (trechos pequenos), ou create_file dividindo em arquivos menores. Continue a tarefa agora.',
            ts: new Date().toISOString(),
          })
          continue
        }

        // ---- PARSE DA AÇÃO ----
        const parsed = extractJson(completion.content)
        if (!parsed) {
          this.steps.push({
            step: this.steps.length + 1,
            thought: 'RESPOSTA NÃO-JSON',
            observation: `resposta bruta (300c): ${completion.content.slice(0, 300)}`,
            ts: new Date().toISOString(),
          })
          this.protocolErrors++
          if (this.protocolErrors > 5) {
            status = 'FAILED'
            finalResult = `PROTOCOL_ERRORS: modelo não seguiu o protocolo JSON em ${this.protocolErrors} respostas. Última resposta: ${completion.content.slice(0, 300)}`
            break
          }
          continue
        }

        // ---- FINALIZAÇÃO ----
        if (parsed.final === true) {
          finalResult = String(parsed.result ?? parsed.thought ?? 'concluído')
          this.steps.push({
            step: this.steps.length + 1,
            thought: String(parsed.thought ?? ''),
            observation: `[FINAL] ${finalResult.slice(0, 400)}`,
            ok: true,
            ts: new Date().toISOString(),
          })
          break
        }

        // ---- EXECUÇÃO DA TOOL ----
        const action = parsed.action as { tool?: string; args?: Record<string, unknown> } | undefined
        // Tolerância a variações do protocolo: action.tool | tool | parameters
        const toolName =
          action?.tool ??
          (parsed.tool as string | undefined) ??
          (action?.name as string | undefined) ??
          (parsed.name as string | undefined)
        const toolArgs =
          (action?.args ??
            (parsed.args as Record<string, unknown> | undefined) ??
            (parsed.parameters as Record<string, unknown> | undefined) ??
            (action?.parameters as Record<string, unknown> | undefined) ??
            (parsed.arguments as Record<string, unknown> | undefined) ??
            {}) as Record<string, unknown>

        if (!toolName) {
          this.protocolErrors++
          this.steps.push({
            step: this.steps.length + 1,
            thought: String(parsed.thought ?? '').slice(0, 300),
            observation: `ERRO PROTOCOLO: nenhum tool identificado. resposta: ${completion.content.slice(0, 200)}`,
            ts: new Date().toISOString(),
          })
          if (this.protocolErrors > 5) {
            status = 'FAILED'
            finalResult = `PROTOCOL_ERRORS: sem tool identificável após ${this.protocolErrors} respostas.`
            break
          }
          continue
        }

        // ---- Detecção de AÇÃO repetida (loop de leitura, etc.) ----
        // FASE 2 — apertado de 4 para 3 (2 runs reais morreram em
        // REPEATED_ACTION com 4 repetições — parar 1 passo antes)
        // FIX do travamento: best-effort (web_search) NÃO mata o run.
        const actionKey = `${toolName}:${JSON.stringify(toolArgs)}`.slice(0, 300)
        const seen = (this.actionCounts.get(actionKey) ?? 0) + 1
        this.actionCounts.set(actionKey, seen)
        if (seen >= 3) {
          if (AgentRunner.BEST_EFFORT_TOOLS.has(toolName)) {
            // repetição de pesquisa best-effort: avisa e PROSSIGUE
            // (o agente nunca fica preso à espera de uma pesquisa)
            this.steps.push({
              step: this.steps.length + 1,
              thought: String(parsed.thought ?? '').slice(0, 300),
              tool: String(toolName),
              args: sanitizeArgs(toolArgs),
              observation:
                '[BEST_EFFORT] Esta pesquisa JÁ foi feita 2x — NÃO insista. ' +
                'PROSSIGA com a tarefa SEM pesquisar (resultados/avisos anteriores já estão no histórico).',
              ok: true,
              ts: new Date().toISOString(),
            })
            continue
          }
          status = 'REPEATED_FAILURE'
          finalResult =
            `REPEATED_ACTION: a mesma ação foi executada ${seen} vezes sem progresso.\n` +
            `Ação: ${actionKey.slice(0, 200)}\n` +
            `RECOMENDAÇÃO: mude de estratégia — o conteúdo já está no histórico. Siga para a PRÓXIMA etapa da tarefa.`
          break
        }

        this.toolCallCount++

        // ---- Cache de leitura: re-leitura do mesmo arquivo no mesmo run ----
        if (toolName === 'read_file' && typeof toolArgs.path === 'string') {
          const lastRead = this.readCache.get(toolArgs.path)
          if (lastRead !== undefined) {
            const cached = this.steps.find((s) => s.step === lastRead)
            this.steps.push({
              step: this.steps.length + 1,
              thought: `re-leitura evitada: ${toolArgs.path} (conteúdo idêntico no passo ${lastRead})`,
              tool: String(toolName),
              args: sanitizeArgs(toolArgs),
              observation: `[CACHE] ${toolArgs.path} já foi lido no passo ${lastRead} — o conteúdo está no histórico acima. PROSSIGA com a tarefa: edite via modify_file (searchText/replaceText) ou crie arquivos. Não releia o mesmo arquivo.`,
              ok: true,
              ts: new Date().toISOString(),
            })
            continue
          }
        }

        const ctx: ToolCtx = {
          projectId: this.input.projectId,
          workspaceRoot: this.input.workspaceRoot,
          runId: this.runId,
          agentId: agent.id,
          permissions: agent.permissions,
          poskliRunId: this.input.poskliRunId,
        }

        let observation: string
        let ok: boolean
        try {
          const res = await runTool(String(toolName), toolArgs, ctx)
          // tool concluída — atividade real p/ o watchdog (run_tests e
          // instalações podem demorar; o toque de INÍCIO já aconteceu no
          // passo, este confirma o fim)
          touchPoskliActivity(this.input.poskliRunId)
          // Tarefa C §3d: outputs de ferramentas (run_tests/run_command/
          // read_file/…) truncados em 2k chars ANTES de irem ao LLM
          observation = clipToolOutput(res.output)
          ok = res.ok
          if (toolName === 'read_file' && typeof toolArgs.path === 'string') {
            this.readCache.set(toolArgs.path, this.steps.length + 1)
          }
          // Arquivo modificado → invalida cache de leitura (conteúdo mudou)
          if (ok && ['modify_file', 'create_file', 'delete_file'].includes(String(toolName)) && typeof toolArgs.path === 'string') {
            this.readCache.delete(String(toolArgs.path))
            // re-leitura futura deste arquivo é legítima (conteúdo novo)
            const readKey = `read_file:${JSON.stringify({ path: toolArgs.path })}`.slice(0, 300)
            this.actionCounts.delete(readKey)
          }
        } catch (e) {
          observation = `TOOL_CRASH: ${(e as Error).message}`
          ok = false
        }

        const stepLog: AgentStepLog = {
          step: this.steps.length + 1,
          thought: String(parsed.thought ?? '').slice(0, 300),
          tool: String(toolName),
          args: sanitizeArgs(toolArgs),
          observation: observation.slice(0, 2000),
          ok,
          ts: new Date().toISOString(),
        }
        this.steps.push(stepLog)

        // ---- DETECÇÃO DE LOOP (REPEATED_FAILURE) ----
        // FIX do travamento: falhas de ferramentas best-effort
        // (web_search) NÃO contam — a pesquisa degrada para vazio
        // e o agente continua; nunca derrubam o run.
        if (!ok && !AgentRunner.BEST_EFFORT_TOOLS.has(toolName)) {
          this.detector.record(toolName, toolArgs, observation)
          const repeated = this.detector.isRepeating()
          if (repeated) {
            status = 'REPEATED_FAILURE'
            finalResult =
              `REPEATED_FAILURE: a mesma estratégia falhou ${this.detector.getRepeats()} vezes.\n` +
              `Assinatura repetida: ${repeated.signature}\n` +
              `Última observação: ${repeated.lastObservation.slice(0, 300)}\n` +
              `RECOMENDAÇÃO: mudar de estratégia, escalar para outro agente ou intervenção humana.`
            break
          }
        }

        // ---- Economia de tokens: observação já entra via history no próximo loop ----
      }

      if (this.steps.length >= this.effectiveMaxSteps && !finalResult) {
        status = 'MAX_LIMITS_REACHED'
        finalResult = `MAX_STEPS: agente atingiu ${this.effectiveMaxSteps} passos sem finalizar.`
      }
    } catch (err) {
      status = 'FAILED'
      finalResult = `ERRO_DO_AGENTE: ${(err as Error).message}`
      // Evento em linguagem de produto; o detalhe técnico fica registrado
      // no resultado da tarefa (área apropriada de diagnóstico)
      await emitEvent({
        type: 'agent.failed',
        projectId: this.input.projectId,
        taskId: this.input.taskId,
        runId: this.runId,
        agent: agent.id,
        message: 'Não foi possível concluir esta etapa — abra a tarefa para ver os detalhes',
        data: { error: (err as Error).message.slice(0, 300) },
      })
    }

    const durationMs = Date.now() - this.startedAt
    await db.agentRun.update({
      where: { id: this.runId },
      data: {
        status,
        steps: this.steps.length,
        tokensIn: this.tokensIn,
        tokensOut: this.tokensOut,
        durationMs,
        log: this.steps as unknown as object,
        error: status === 'COMPLETED' ? null : finalResult.slice(0, 1000),
        finishedAt: new Date(),
      },
    })

    await emitEvent({
      type: status === 'COMPLETED' ? 'agent.completed' : 'agent.failed',
      projectId: this.input.projectId,
      taskId: this.input.taskId,
      runId: this.runId,
      agent: agent.id,
      status,
      message: `${agentDisplayName(agent.id)} finalizado (${status}) em ${(durationMs / 1000).toFixed(1)}s — ${this.steps.length} passos, ${this.tokensIn + this.tokensOut} tokens`,
      durationMs,
      data: { steps: this.steps.length, tokensIn: this.tokensIn, tokensOut: this.tokensOut },
    })

    return {
      status,
      result: finalResult || '(sem resultado)',
      steps: this.steps,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      durationMs,
      runId: this.runId,
    }
  }

  private toolBudget = 200 // será ajustado pelo orchestrator via setToolBudget
  setToolBudget(n: number) {
    // DELEGAÇÃO: teto do subagente (menor vence com o pedido)
    const cap = this.input.budget?.maxToolCalls
    this.toolBudget = Math.max(1, Math.min(n, cap ?? Number.POSITIVE_INFINITY))
    return this
  }
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...[truncado]' : v
  }
  return out
}

/** Atalho para rodar um agente com orçamento de ferramentas. */
export async function runAgent(input: AgentRunInput, toolBudget = 40): Promise<AgentRunOutput> {
  const runner = new AgentRunner(input)
  runner.setToolBudget(toolBudget)
  return runner.run()
}
