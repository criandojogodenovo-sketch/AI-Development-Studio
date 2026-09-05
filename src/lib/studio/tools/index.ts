// ============================================================
// TOOLS — Registro central (Tool Registry)
// Toda execução passa por runTool(): valida args, checa
// permissões do agente, executa com timeout e registra no DB.
// ============================================================

import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { emitEvent } from '../events/bus'
import {
  listFilesTool,
  readFileTool,
  searchCodeTool,
  createFileTool,
  modifyFileTool,
  deleteFileTool,
  createDirectoryTool,
  getProjectStatusTool,
} from './fs-tools'
import { runCommandTool, runTestsTool } from './exec-tools'
import { GIT_TOOLS } from './git-tools'
import { GITHUB_TOOLS } from './github-tools'
import { validateArgs, type ToolCtx, type ToolDefinition, type ToolResult } from './types'

const ALL_TOOLS: ToolDefinition[] = [
  listFilesTool,
  readFileTool,
  searchCodeTool,
  createFileTool,
  modifyFileTool,
  deleteFileTool,
  createDirectoryTool,
  getProjectStatusTool,
  runCommandTool,
  runTestsTool,
  ...GIT_TOOLS,
  ...GITHUB_TOOLS,
]

const REGISTRY = new Map<string, ToolDefinition>(ALL_TOOLS.map((t) => [t.name, t]))

export function getTool(name: string): ToolDefinition | undefined {
  return REGISTRY.get(name)
}

export function listTools(): ToolDefinition[] {
  return ALL_TOOLS
}

export function toolsForPermissions(permissions: string[]): ToolDefinition[] {
  return ALL_TOOLS.filter((t) => t.permissions.some((p) => permissions.includes(p)))
}

/** Execução central com auditoria. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx
): Promise<ToolResult> {
  const tool = getTool(name)
  const started = Date.now()

  if (!tool) {
    await recordCall(ctx, name, args, 'ERROR', null, `TOOL_DESCONHECIDA: ${name}`, Date.now() - started)
    return { ok: false, output: `TOOL_DESCONHECIDA: ${name}. Ferramentas disponíveis: ${ALL_TOOLS.map((t) => t.name).join(', ')}` }
  }

  // Verificação de permissão do agente
  const hasPermission = tool.permissions.some((p) => ctx.permissions.includes(p))
  if (!hasPermission) {
    await recordCall(ctx, name, args, 'DENIED', null, `PERMISSÃO_NEGADA: agente ${ctx.agentId} não pode usar ${name}`, Date.now() - started)
    await emitEvent({
      type: 'tool.denied',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      tool: name,
      status: 'DENIED',
      message: `Permissão negada: ${ctx.agentId} → ${name}`,
    })
    return { ok: false, output: `PERMISSÃO_NEGADA: você não tem permissão para "${name}"` }
  }

  // Validação de schema
  const validationError = validateArgs(tool, args)
  if (validationError) {
    await recordCall(ctx, name, args, 'ERROR', null, validationError, Date.now() - started)
    return { ok: false, output: `ARGUMENTOS_INVÁLIDOS: ${validationError}` }
  }

  await emitEvent({
    type: 'tool.called',
    projectId: ctx.projectId,
    runId: ctx.runId,
    agent: ctx.agentId,
    tool: name,
    action: JSON.stringify(args).slice(0, 200),
    message: `${ctx.agentId} chamou ${name}`,
  })

  // Execução com timeout
  const timeoutMs = tool.timeoutMs ?? STUDIO_CONFIG.executor.maxCommandTimeoutMs
  let result: ToolResult
  try {
    const raced = await Promise.race([
      tool.execute(args, ctx),
      new Promise<ToolResult>((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('TOOL_TIMEOUT'), { code: 'TIMEOUT' })), timeoutMs)
      ),
    ])
    result = raced
  } catch (err) {
    const msg = (err as Error).message
    result = { ok: false, output: `TOOL_ERRO: ${msg}` }
  }

  const durationMs = Date.now() - started
  const status = result.ok ? 'OK' : result.output.startsWith('PERMISSÃO_NEGADA') ? 'DENIED' : 'ERROR'
  await recordCall(ctx, name, args, status as 'OK' | 'ERROR' | 'DENIED', result, null, durationMs)

  await emitEvent({
    type: 'tool.completed',
    projectId: ctx.projectId,
    runId: ctx.runId,
    agent: ctx.agentId,
    tool: name,
    status,
    message: `${name} → ${status} (${durationMs}ms)`,
    durationMs,
    data: { ok: result.ok },
  })

  return result
}

async function recordCall(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>,
  status: 'OK' | 'ERROR' | 'DENIED' | 'TIMEOUT',
  result: ToolResult | null,
  error: string | null,
  durationMs: number
): Promise<void> {
  try {
    // Sanitiza args: remove possíveis contents gigantes (economia de DB)
    const safeArgs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
      safeArgs[k] = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '...[truncado]' : v
    }
    await db.toolCall.create({
      data: {
        runId: ctx.runId,
        projectId: ctx.projectId,
        tool: name,
        args: safeArgs,
        status,
        output: result?.output?.slice(0, 2000) ?? null,
        error,
        durationMs,
      },
    })
  } catch (e) {
    console.error('[tools] falha ao registrar tool call:', (e as Error).message)
  }
}
