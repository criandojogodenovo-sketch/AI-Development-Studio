// ============================================================
// CONTEXT — ContextManager (economia de tokens)
// Seleciona: arquivos relevantes, trechos, erros, histórico
// necessário, resultados de testes. Evita: arquivos
// irrelevantes, histórico inteiro, logs gigantes, duplicação.
// Também mantém PROJECT MEMORY estruturada por projeto.
// ============================================================

import fs from 'fs/promises'
import path from 'path'
import { STUDIO_CONFIG } from '../config'
import { db } from '@/lib/db'

// re-export p/ compat (importadores históricos) — Tarefa C §3d:
// truncagem de outputs de ferramenta em 2k chars com marcador
export { clipToolOutput, clipTestOutput } from './clip.ts'

const IGNORED_FILES = new Set([
  'package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml',
  '.DS_Store', 'README.md', '.gitkeep',
])
const CODE_EXTS = new Set(['.js', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.json', '.py', '.md'])

export interface RelevantFile {
  path: string
  content: string
  reason: string
}

/** Escolhe arquivos relevantes por prioridade: mencionados → entry points → pequenos. */
export async function selectRelevantFiles(
  workspaceRoot: string,
  mentioned: string[],
  taskDescription: string
): Promise<RelevantFile[]> {
  const maxFiles = STUDIO_CONFIG.context.maxFilesInContext
  const maxChars = STUDIO_CONFIG.context.maxFileCharsInContext
  const picked = new Map<string, RelevantFile>()
  const keywords = taskDescription.toLowerCase().split(/\W+/).filter((w) => w.length > 3)

  const add = (p: string, reason: string) => {
    if (picked.has(p)) return
    picked.set(p, { path: p, content: '', reason })
  }

  // 1. Arquivos mencionados na tarefa
  for (const m of mentioned) {
    const clean = String(m).replace(/^[./\\]+/, '').replace(/\\/g, '/')
    if (clean) add(clean, 'mencionado na tarefa')
  }

  // 2. Varredura priorizada
  const allFiles: Array<{ path: string; size: number }> = []
  await walk(workspaceRoot, '', allFiles)

  const priority = (p: string): number => {
    if (p === 'index.html' || p === 'package.json') return 10
    if (/^src\/(main|engine|game|app|index)\./.test(p)) return 9
    if (p.startsWith('src/')) return 7
    if (p.startsWith('test/')) return 5
    if (CODE_EXTS.has(path.extname(p))) return 3
    return 1
  }

  for (const f of allFiles) {
    if (keywords.some((k) => f.path.toLowerCase().includes(k))) add(f.path, 'palavra-chave da tarefa')
    if (picked.size >= maxFiles) break
  }
  for (const f of [...allFiles].sort((a, b) => priority(b.path) - priority(a.path))) {
    if (picked.size >= maxFiles) break
    add(f.path, 'prioridade estrutural')
  }

  // 3. Carrega conteúdos (com truncamento)
  const out: RelevantFile[] = []
  for (const [p, meta] of picked) {
    const abs = path.join(workspaceRoot, p)
    const st = await fs.stat(abs).catch(() => null)
    if (!st || st.isDirectory() || st.size > STUDIO_CONFIG.files.maxFileReadBytes) continue
    const ext = path.extname(p).toLowerCase()
    if (STUDIO_CONFIG.files.blockedExtensions.includes(ext)) continue
    let content = await fs.readFile(abs, 'utf8').catch(() => '')
    if (content.length > maxChars) content = content.slice(0, maxChars) + '\n...[ARQUIVO TRUNCADO]'
    out.push({ ...meta, content })
  }
  return out
}

async function walk(root: string, prefix: string, out: Array<{ path: string; size: number }>) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (['node_modules', '.git', '.next', 'dist'].includes(e.name)) continue
      await walk(path.join(root, e.name), rel, out)
    } else {
      if (IGNORED_FILES.has(e.name)) continue
      const st = await fs.stat(path.join(root, e.name)).catch(() => null)
      if (st) out.push({ path: rel, size: st.size })
    }
  }
}

/** Comprime histórico de passos do agente (mantém N mais recentes + resumo dos antigos). */
export function compressHistory(steps: Array<{ thought?: string; action?: string; observation?: string }>) {
  const keep = STUDIO_CONFIG.context.maxHistorySteps
  if (steps.length <= keep) return { summary: '', recent: steps }
  const old = steps.slice(0, steps.length - keep)
  const recent = steps.slice(-keep)
  const summary = old
    .map((s, i) => `passo ${i + 1}: ${s.action ?? ''} → ${(s.observation ?? '').slice(0, 100)}`)
    .join('\n')
  return { summary: `RESUMO DOS PASSOS ANTERIORES:\n${summary}`, recent }
}

// (clipTestOutput/clipToolOutput estão re-exportadas de ./clip.ts no topo)

// ============================================================
// PROJECT MEMORY — memória estruturada por projeto
// ============================================================

export interface ProjectMemory {
  architecture?: string
  stack?: string[]
  decisions?: Array<{ at: string; decision: string; reason: string }>
  conventions?: string[]
  dependencies?: string[]
  knownIssues?: string[]
  agentNotes?: Array<{ at: string; agent: string; note: string }>
  completedTaskSummaries?: Array<{ taskId: string; title: string; summary: string }>
}

export async function readProjectMemory(projectId: string): Promise<ProjectMemory> {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) return {}
  const mem = project.memory as unknown as ProjectMemory
  return mem ?? {}
}

export async function updateProjectMemory(
  projectId: string,
  patch: Partial<ProjectMemory>
): Promise<ProjectMemory> {
  const current = await readProjectMemory(projectId)
  const merged: ProjectMemory = { ...current }
  if (patch.architecture) merged.architecture = patch.architecture
  if (patch.stack) merged.stack = [...new Set([...(merged.stack ?? []), ...patch.stack])]
  if (patch.decisions) merged.decisions = [...(merged.decisions ?? []), ...patch.decisions].slice(-30)
  if (patch.conventions) merged.conventions = [...new Set([...(merged.conventions ?? []), ...patch.conventions])]
  if (patch.dependencies) merged.dependencies = [...new Set([...(merged.dependencies ?? []), ...patch.dependencies])]
  if (patch.knownIssues) merged.knownIssues = patch.knownIssues.slice(-20)
  if (patch.agentNotes) merged.agentNotes = [...(merged.agentNotes ?? []), ...patch.agentNotes].slice(-40)
  if (patch.completedTaskSummaries) merged.completedTaskSummaries = (merged.completedTaskSummaries ?? []).concat(patch.completedTaskSummaries).slice(-50)
  await db.project.update({ where: { id: projectId }, data: { memory: merged as object } })
  return merged
}

/** Renderiza memória compacta para injetar no prompt. */
export function memoryToPrompt(mem: ProjectMemory): string {
  const parts: string[] = []
  if (mem.architecture) parts.push(`ARQUITETURA: ${mem.architecture}`)
  if (mem.stack?.length) parts.push(`STACK: ${mem.stack.join(', ')}`)
  if (mem.conventions?.length) parts.push(`CONVENÇÕES: ${mem.conventions.slice(0, 8).join(' | ')}`)
  if (mem.decisions?.length) {
    parts.push(`DECISÕES:\n${mem.decisions.slice(-6).map((d) => `- ${d.decision} (${d.reason})`).join('\n')}`)
  }
  if (mem.knownIssues?.length) parts.push(`PROBLEMAS CONHECIDOS: ${mem.knownIssues.slice(-5).join(' | ')}`)
  if (mem.completedTaskSummaries?.length) {
    parts.push(`TAREFAS CONCLUÍDAS:\n${mem.completedTaskSummaries.slice(-8).map((t) => `- ${t.title}: ${t.summary?.slice(0, 120)}`).join('\n')}`)
  }
  return parts.join('\n\n') || '(memória vazia — projeto novo)'
}
