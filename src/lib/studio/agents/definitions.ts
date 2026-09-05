// ============================================================
// AGENTS — Registro de agentes especializados
// Cada agente: id, name, role, model, systemPrompt,
// allowedTools, maxSteps, maxRetries, timeout, permissions.
// Arquitetura extensível: adicionar novo agente = acrescentar
// uma entrada aqui (sem reescrever o sistema).
// ============================================================

import type { ToolPermission } from '../tools/types'
import { SYSTEM_PROMPTS } from './prompts'

export type AgentRole =
  | 'master' | 'coding' | 'review' | 'testing' | 'github'
  | 'game-design' | 'ui' | 'backend' | 'frontend' | 'security'
  | 'performance' | 'documentation' | 'asset' | 'audio'

export interface AgentDefinition {
  id: string
  name: string
  role: AgentRole
  modelRole: 'master' | 'coding' | 'review'
  systemPrompt: string
  allowedTools: string[]           // '*' = todas compatíveis com permissions
  maxSteps: number
  maxRetries: number
  timeoutMs: number
  permissions: ToolPermission[]
  enabled: boolean                  // futuros agentes ficam prontos, mas desabilitados
  future?: boolean
  description: string
}

const FS_READ_PERMS: ToolPermission[] = ['fs:read']
const FS_WRITE_PERMS: ToolPermission[] = ['fs:read', 'fs:write']
const EXEC_PERMS: ToolPermission[] = ['fs:read', 'exec:command', 'exec:tests']
const GIT_READ_PERMS: ToolPermission[] = ['git:read', 'fs:read']
const GIT_WRITE_PERMS: ToolPermission[] = ['git:read', 'git:write', 'fs:read', 'github:read', 'github:write']

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: 'master',
    name: 'Master Agent (Orquestrador)',
    role: 'master',
    modelRole: 'master', // GLM-5.3-Flash
    systemPrompt: SYSTEM_PROMPTS.master,
    allowedTools: ['list_files', 'read_file', 'search_code', 'get_project_status'],
    maxSteps: 8,
    maxRetries: 2,
    timeoutMs: 300_000,
    permissions: FS_READ_PERMS,
    enabled: true,
    description: 'Compreende o pedido, analisa o projeto, define requisitos, escolhe arquitetura, divide o trabalho, cria o task graph e acompanha a execução. ORQUESTRA — não edita tudo diretamente.',
  },
  {
    id: 'coding',
    name: 'Coding Agent',
    role: 'coding',
    modelRole: 'coding', // Qwen3.8-Flash
    systemPrompt: SYSTEM_PROMPTS.coding,
    allowedTools: [
      'list_files', 'read_file', 'search_code', 'create_file',
      'modify_file', 'delete_file', 'create_directory',
      'run_command', 'run_tests', 'git_status', 'git_diff', 'git_log',
    ],
    maxSteps: 22,
    maxRetries: 3,
    timeoutMs: 600_000,
    permissions: [...FS_WRITE_PERMS, ...EXEC_PERMS, 'git:read'],
    enabled: true,
    description: 'Implementa código real: cria, modifica e corrige arquivos; executa comandos e testes; itera sobre erros.',
  },
  {
    id: 'review',
    name: 'Review Agent (QA)',
    role: 'review',
    modelRole: 'review', // Hy3
    systemPrompt: SYSTEM_PROMPTS.review,
    allowedTools: ['list_files', 'read_file', 'search_code', 'git_diff', 'git_log', 'run_tests'],
    maxSteps: 15,
    maxRetries: 2,
    timeoutMs: 300_000,
    permissions: [...FS_READ_PERMS, 'git:read', 'exec:tests'],
    enabled: true,
    description: 'Verifica funcionalidade, bugs, arquitetura, segurança, performance, código duplicado, manutenibilidade e requisitos não cumpridos. APPROVE ou CREATE_FIX_TASK.',
  },
  {
    id: 'testing',
    name: 'Testing Agent',
    role: 'testing',
    modelRole: 'review', // Hy3
    systemPrompt: SYSTEM_PROMPTS.testing,
    allowedTools: [
      'list_files', 'read_file', 'search_code',
      'create_file', 'modify_file', 'run_command', 'run_tests',
    ],
    maxSteps: 20,
    maxRetries: 2,
    timeoutMs: 300_000,
    permissions: [...FS_WRITE_PERMS, ...EXEC_PERMS],
    enabled: true,
    description: 'Cria e executa testes relevantes para a tarefa; reporta falhas com evidências (stdout/stderr/exit code).',
  },
  {
    id: 'github',
    name: 'GitHub Agent',
    role: 'github',
    modelRole: 'master',
    systemPrompt: SYSTEM_PROMPTS.github,
    allowedTools: [
      'git_status', 'git_diff', 'git_log', 'git_create_branch',
      'git_commit', 'git_push', 'get_repository', 'get_file',
      'github_create_branch', 'create_pull_request',
      'list_files', 'read_file',
    ],
    maxSteps: 12,
    maxRetries: 2,
    timeoutMs: 240_000,
    permissions: GIT_WRITE_PERMS,
    enabled: true,
    description: 'Operações Git/GitHub: branches agent/*, commits verificados, push e Pull Requests. Nunca push direto em main.',
  },

  // ======== AGENTES FUTUROS (arquitetura pronta, desabilitados) ========
  {
    id: 'game-design',
    name: 'Game Design Agent',
    role: 'game-design',
    modelRole: 'master',
    systemPrompt: SYSTEM_PROMPTS.gameDesign,
    allowedTools: ['list_files', 'read_file', 'search_code'],
    maxSteps: 15,
    maxRetries: 2,
    timeoutMs: 240_000,
    permissions: FS_READ_PERMS,
    enabled: false,
    future: true,
    description: 'Define mecânicas, loops de gameplay, dificuldade e progressão para jogos.',
  },
  {
    id: 'ui',
    name: 'UI Agent',
    role: 'ui',
    modelRole: 'coding',
    systemPrompt: SYSTEM_PROMPTS.ui,
    allowedTools: ['list_files', 'read_file', 'search_code', 'create_file', 'modify_file', 'run_tests'],
    maxSteps: 25,
    maxRetries: 3,
    timeoutMs: 480_000,
    permissions: [...FS_WRITE_PERMS, 'exec:tests'],
    enabled: false,
    future: true,
    description: 'Interfaces mobile-first, design system e componentes visuais.',
  },
  {
    id: 'backend',
    name: 'Backend Agent',
    role: 'backend',
    modelRole: 'coding',
    systemPrompt: SYSTEM_PROMPTS.backend,
    allowedTools: ['list_files', 'read_file', 'search_code', 'create_file', 'modify_file', 'run_command', 'run_tests'],
    maxSteps: 25,
    maxRetries: 3,
    timeoutMs: 480_000,
    permissions: [...FS_WRITE_PERMS, ...EXEC_PERMS],
    enabled: false,
    future: true,
    description: 'APIs, models, integrações e lógica de servidor.',
  },
  {
    id: 'frontend',
    name: 'Frontend Agent',
    role: 'frontend',
    modelRole: 'coding',
    systemPrompt: SYSTEM_PROMPTS.frontend,
    allowedTools: ['list_files', 'read_file', 'search_code', 'create_file', 'modify_file', 'run_tests'],
    maxSteps: 25,
    maxRetries: 3,
    timeoutMs: 480_000,
    permissions: [...FS_WRITE_PERMS, 'exec:tests'],
    enabled: false,
    future: true,
    description: 'Aplicações cliente, estado, componentes e integração com backend.',
  },
  {
    id: 'security',
    name: 'Security Agent',
    role: 'security',
    modelRole: 'review',
    systemPrompt: SYSTEM_PROMPTS.security,
    allowedTools: ['list_files', 'read_file', 'search_code', 'run_tests'],
    maxSteps: 15,
    maxRetries: 2,
    timeoutMs: 240_000,
    permissions: [...FS_READ_PERMS, 'exec:tests'],
    enabled: false,
    future: true,
    description: 'Análise de vulnerabilidades, injeções, XSS, secrets expostos e hardening.',
  },
  {
    id: 'performance',
    name: 'Performance Agent',
    role: 'performance',
    modelRole: 'review',
    systemPrompt: SYSTEM_PROMPTS.performance,
    allowedTools: ['list_files', 'read_file', 'search_code', 'run_tests'],
    maxSteps: 15,
    maxRetries: 2,
    timeoutMs: 240_000,
    permissions: [...FS_READ_PERMS, 'exec:tests'],
    enabled: false,
    future: true,
    description: 'Otimização de loops, render, memória, bundle e runtime.',
  },
  {
    id: 'documentation',
    name: 'Documentation Agent',
    role: 'documentation',
    modelRole: 'review',
    systemPrompt: SYSTEM_PROMPTS.documentation,
    allowedTools: ['list_files', 'read_file', 'search_code', 'create_file', 'modify_file'],
    maxSteps: 15,
    maxRetries: 2,
    timeoutMs: 240_000,
    permissions: FS_WRITE_PERMS,
    enabled: false,
    future: true,
    description: 'README, docs de API, comentários e guias.',
  },
  {
    id: 'asset',
    name: 'Asset Agent',
    role: 'asset',
    modelRole: 'coding',
    systemPrompt: SYSTEM_PROMPTS.asset,
    allowedTools: ['list_files', 'create_file', 'read_file'],
    maxSteps: 15,
    maxRetries: 2,
    timeoutMs: 240_000,
    permissions: FS_WRITE_PERMS,
    enabled: false,
    future: true,
    description: 'Sprites SVG, ícones e recursos visuais gerados por código.',
  },
  {
    id: 'audio',
    name: 'Audio Agent',
    role: 'audio',
    modelRole: 'coding',
    systemPrompt: SYSTEM_PROMPTS.audio,
    allowedTools: ['list_files', 'read_file', 'create_file', 'modify_file'],
    maxSteps: 15,
    maxRetries: 2,
    timeoutMs: 240_000,
    permissions: FS_WRITE_PERMS,
    enabled: false,
    future: true,
    description: 'Áudio procedural via WebAudio, SFX e trilhas leves.',
  },
]

export function getAgent(id: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS.find((a) => a.id === id)
}

export function enabledAgents(): AgentDefinition[] {
  return AGENT_DEFINITIONS.filter((a) => a.enabled)
}

export function agentSummaries() {
  return AGENT_DEFINITIONS.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    modelRole: a.modelRole,
    enabled: a.enabled,
    future: Boolean(a.future),
    maxSteps: a.maxSteps,
    maxRetries: a.maxRetries,
    description: a.description,
    tools: a.allowedTools,
    permissions: a.permissions,
  }))
}
