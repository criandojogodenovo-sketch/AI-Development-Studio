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
import { runTool, getTool, toolsForPermissions } from '../tools'
import { toolToSchema, type ToolCtx } from '../tools/types'
import { emitEvent } from '../events/bus'
import { compressHistory } from '../context/context-manager'
import { RepeatedFailureDetector } from '../orchestrator/loop-detector'
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
  private runId!: string
  private startedAt = Date.now()
  private deadline: number

  constructor(private input: AgentRunInput) {
    this.deadline = Date.now() + input.agent.timeoutMs
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
        JSON.stringify(available, null, 1).slice(0, 8000),
      ]
        .filter(Boolean)
        .join('\n'),
    })

    if (this.input.extraMessages?.length) messages.push(...this.input.extraMessages)

    let finalResult = ''
    let status: AgentRunOutput['status'] = 'COMPLETED'

    try {
      while (this.steps.length < agent.maxSteps) {
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
          conversation.push({ role: 'user', content: `[OBSERVAÇÃO] ${s.observation ?? ''}`.slice(0, 1500) })
        }
        // Re-educação NÃO-acumulativa: lembrança fixa quando há erros de protocolo
        if (this.protocolErrors > 0) {
          conversation.push({
            role: 'user',
            content: '[SISTEMA] Lembrete: responda SOMENTE com JSON no protocolo: {"thought":"...","action":{"tool":"nome","args":{...}}} ou {"final":true,"result":"..."}',
          })
        }

        const completion = await modelRouter.chatRole(agent.modelRole, conversation, {
          temperature: agent.role === 'coding' ? 0.2 : 0.4,
          // maxTokens por papel: coding precisa de espaço para escrever arquivos
          maxTokens: agent.role === 'coding' ? 6000 : 3000,
        })
        this.tokensIn += completion.promptTokens
        this.tokensOut += completion.completionTokens

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

        this.toolCallCount++

        // ---- Detecção de AÇÃO repetida (loop de leitura, etc.) ----
        const actionKey = `${toolName}:${JSON.stringify(toolArgs)}`.slice(0, 300)
        const seen = (this.actionCounts.get(actionKey) ?? 0) + 1
        this.actionCounts.set(actionKey, seen)
        if (seen >= 4) {
          status = 'REPEATED_FAILURE'
          finalResult =
            `REPEATED_ACTION: a mesma ação foi executada ${seen} vezes sem progresso.\n` +
            `Ação: ${actionKey.slice(0, 200)}\n` +
            `RECOMENDAÇÃO: mude de estratégia — o conteúdo já está no histórico. Siga para a PRÓXIMA etapa da tarefa.`
          break
        }

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
        }

        let observation: string
        let ok: boolean
        try {
          const res = await runTool(String(toolName), toolArgs, ctx)
          observation = res.output
          ok = res.ok
          if (toolName === 'read_file' && typeof toolArgs.path === 'string') {
            this.readCache.set(toolArgs.path, this.steps.length + 1)
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
        if (!ok) {
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

      if (this.steps.length >= agent.maxSteps && !finalResult) {
        status = 'MAX_LIMITS_REACHED'
        finalResult = `MAX_STEPS: agente atingiu ${agent.maxSteps} passos sem finalizar.`
      }
    } catch (err) {
      status = 'FAILED'
      finalResult = `ERRO_DO_AGENTE: ${(err as Error).message}`
      await emitEvent({
        type: 'agent.failed',
        projectId: this.input.projectId,
        taskId: this.input.taskId,
        runId: this.runId,
        agent: agent.id,
        message: `Falha: ${(err as Error).message}`,
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
      message: `${agent.name} finalizado (${status}) em ${(durationMs / 1000).toFixed(1)}s — ${this.steps.length} passos, ${this.tokensIn + this.tokensOut} tokens`,
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
    this.toolBudget = Math.max(1, n)
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
export async function runAgent(input: AgentRunInput, toolBudget = 60): Promise<AgentRunOutput> {
  const runner = new AgentRunner(input)
  runner.setToolBudget(toolBudget)
  return runner.run()
}
