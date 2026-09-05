// ============================================================
// TOOLS — Contrato da camada de ferramentas
// Toda tool tem: schema de parâmetros, validação, permissões,
// logs (ToolCall no DB), timeout e tratamento de erro.
// ============================================================

export type ToolCategory = 'fs' | 'exec' | 'git' | 'github' | 'info'
export type ToolPermission =
  | 'fs:read' | 'fs:write' | 'fs:delete'
  | 'exec:command' | 'exec:tests'
  | 'git:read' | 'git:write'
  | 'github:read' | 'github:write'

export interface ToolParam {
  name: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  description: string
}

/** Contexto passado a toda execução de tool. */
export interface ToolCtx {
  projectId: string
  workspaceRoot: string
  runId: string
  agentId: string
  /** Permissões concedidas a este agente (allowedTools). */
  permissions: string[]
}

export interface ToolResult {
  ok: boolean
  /** Observação textual devolvida ao agente (economia de tokens). */
  output: string
  data?: Record<string, unknown>
}

export interface ToolDefinition {
  name: string
  description: string
  category: ToolCategory
  permissions: ToolPermission[]
  params: ToolParam[]
  timeoutMs?: number
  execute(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult>
}

/** Valida argumentos contra o schema da tool. */
export function validateArgs(tool: ToolDefinition, args: Record<string, unknown>): string | null {
  if (!args || typeof args !== 'object') return 'argumentos ausentes'
  for (const p of tool.params) {
    const v = args[p.name]
    if (p.required && (v === undefined || v === null || v === '')) {
      return `parâmetro obrigatório ausente: "${p.name}"`
    }
    if (v !== undefined && v !== null) {
      if (p.type === 'string' && typeof v !== 'string') return `"${p.name}" deve ser string`
      if (p.type === 'number' && typeof v !== 'number') return `"${p.name}" deve ser number`
      if (p.type === 'boolean' && typeof v !== 'boolean') return `"${p.name}" deve ser boolean`
    }
  }
  const known = new Set(tool.params.map((p) => p.name))
  for (const k of Object.keys(args)) {
    if (!known.has(k)) return `parâmetro desconhecido: "${k}"`
  }
  return null
}

/** Converte definição em schema JSON para o prompt do agente. */
export function toolToSchema(tool: ToolDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const p of tool.params) {
    properties[p.name] = { type: p.type, description: p.description }
    if (p.required) required.push(p.name)
  }
  return {
    name: tool.name,
    description: tool.description,
    category: tool.category,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
  }
}
