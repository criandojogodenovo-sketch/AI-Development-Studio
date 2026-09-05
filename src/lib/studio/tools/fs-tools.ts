// ============================================================
// TOOLS / FS — Operações de arquivo com segurança
// list_files, read_file, search_code, create_file,
// modify_file, delete_file, create_directory, get_project_status
// ============================================================

import fs from 'fs/promises'
import path from 'path'
import { STUDIO_CONFIG } from '../config'
import { emitEvent } from '../events/bus'
import {
  safeResolve,
  validateFilePath,
  validateFileSize,
  assertWorkspaceQuota,
  getWorkspaceSize,
} from '../security/path'
import type { ToolDefinition, ToolResult } from './types'

const BLOCKED_DIR_NAMES = new Set(['node_modules', '.git', '.next', 'dist', '.cache', '__pycache__'])

function rel(root: string, abs: string): string {
  return path.relative(root, abs).replace(/\\/g, '/')
}

async function fileStats(abs: string) {
  const st = await fs.stat(abs)
  return { size: st.size, modified: st.mtime.toISOString() }
}

export const listFilesTool: ToolDefinition = {
  name: 'list_files',
  description:
    'Lista arquivos do workspace do projeto. Retorna árvore com tamanhos. Use antes de ler/editar para conhecer a estrutura.',
  category: 'fs',
  permissions: ['fs:read'],
  params: [
    { name: 'path', type: 'string', required: false, description: 'Subdiretório relativo (padrão: raiz)' },
    { name: 'depth', type: 'number', required: false, description: 'Profundidade máxima (padrão 3, máx 6)' },
  ],
  async execute(args, ctx): Promise<ToolResult> {
    const depth = Math.min(Math.max(1, Number(args.depth) ?? 3), 6)
    const root = safeResolve(ctx.workspaceRoot, String(args.path ?? '.'))
    const lines: string[] = []

    const walk = async (dir: string, level: number) => {
      if (level > depth) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (e) {
        lines.push(`  [erro ao ler ${rel(root, dir)}: ${(e as Error).message}]`)
        return
      }
      for (const e of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
        const full = path.join(dir, e.name)
        const prefix = '  '.repeat(level)
        if (e.isDirectory()) {
          const tag = BLOCKED_DIR_NAMES.has(e.name) ? ' (ignorado)' : ''
          lines.push(`${prefix}${e.name}/${tag}`)
          if (!BLOCKED_DIR_NAMES.has(e.name)) await walk(full, level + 1)
        } else {
          const st = await fileStats(full).catch(() => null)
          lines.push(`${prefix}${e.name} (${st ? `${st.size}B` : '?'})`)
        }
      }
    }
    await walk(root, 0)
    const tree = lines.join('\n')
    return {
      ok: true,
      output: tree || 'workspace vazio',
      data: { path: String(args.path ?? '.'), count: lines.length },
    }
  },
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Lê o conteúdo de um arquivo de texto do workspace (com limite de tamanho).',
  category: 'fs',
  permissions: ['fs:read'],
  params: [{ name: 'path', type: 'string', required: true, description: 'Caminho relativo ao workspace' }],
  async execute(args, ctx): Promise<ToolResult> {
    const abs = safeResolve(ctx.workspaceRoot, String(args.path))
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat) return { ok: false, output: `ARQUIVO_NAO_ENCONTRADO: ${args.path}` }
    if (stat.isDirectory()) return { ok: false, output: `É um diretório, não arquivo: ${args.path}` }
    if (stat.size > STUDIO_CONFIG.files.maxFileReadBytes) {
      return {
        ok: false,
        output: `ARQUIVO_GRANDE: ${stat.size}B excede limite de leitura (${STUDIO_CONFIG.files.maxFileReadBytes}B). Leia em partes via search_code.`,
      }
    }
    const ext = path.extname(abs).toLowerCase()
    if (STUDIO_CONFIG.files.blockedExtensions.includes(ext)) {
      return { ok: false, output: `EXTENSÃO_BLOQUEADA: ${ext}` }
    }
    const content = await fs.readFile(abs, 'utf8')
    return {
      ok: true,
      output: content.length > STUDIO_CONFIG.context.maxFileCharsInContext
        ? content.slice(0, STUDIO_CONFIG.context.maxFileCharsInContext) + '\n...[TRUNCADO]'
        : content,
      data: { path: rel(ctx.workspaceRoot, abs), size: stat.size },
    }
  },
}

export const searchCodeTool: ToolDefinition = {
  name: 'search_code',
  description:
    'Busca texto (substring ou regex) em arquivos do workspace. Retorna arquivo:linha:trecho. Ideal para localizar código sem ler arquivos inteiros.',
  category: 'fs',
  permissions: ['fs:read'],
  params: [
    { name: 'query', type: 'string', required: true, description: 'Texto ou regex a buscar' },
    { name: 'path', type: 'string', required: false, description: 'Subdiretório para restringir (padrão: raiz)' },
    { name: 'isRegex', type: 'boolean', required: false, description: 'Interpretar query como regex (padrão false)' },
  ],
  async execute(args, ctx): Promise<ToolResult> {
    const query = String(args.query)
    const isRegex = Boolean(args.isRegex)
    let matcher: RegExp
    try {
      matcher = isRegex ? new RegExp(query, 'i') : new RegExp(escapeRegExp(query), 'i')
    } catch {
      return { ok: false, output: `REGEX_INVÁLIDA: ${query}` }
    }
    const root = safeResolve(ctx.workspaceRoot, String(args.path ?? '.'))
    const hits: string[] = []
    let filesScanned = 0

    const walk = async (dir: string) => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (!BLOCKED_DIR_NAMES.has(e.name)) await walk(full)
          continue
        }
        const ext = path.extname(e.name).toLowerCase()
        if (STUDIO_CONFIG.files.blockedExtensions.includes(ext)) continue
        const st = await fs.stat(full).catch(() => null)
        if (!st || st.size > STUDIO_CONFIG.files.maxFileReadBytes) continue
        filesScanned++
        const content = await fs.readFile(full, 'utf8').catch(() => '')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (matcher.test(lines[i])) {
            hits.push(`${rel(ctx.workspaceRoot, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
            if (hits.length >= 60) return
          }
        }
      }
    }
    await walk(root)
    return {
      ok: true,
      output: hits.length ? `${hits.length} ocorrências (em ${filesScanned} arquivos):\n${hits.join('\n')}` : `NENHUMA ocorrência de "${query}"`,
      data: { hits: hits.length, filesScanned },
    }
  },
}

export const createFileTool: ToolDefinition = {
  name: 'create_file',
  description: 'Cria um novo arquivo (sobrescreve se existir) com o conteúdo fornecido. Caminhos-pai são criados automaticamente.',
  category: 'fs',
  permissions: ['fs:write'],
  params: [
    { name: 'path', type: 'string', required: true, description: 'Caminho relativo (ex: src/game.js)' },
    { name: 'content', type: 'string', required: true, description: 'Conteúdo completo do arquivo' },
  ],
  async execute(args, ctx): Promise<ToolResult> {
    const relPath = String(args.path)
    const content = String(args.content)
    const abs = safeResolve(ctx.workspaceRoot, relPath)
    validateFilePath(abs)
    validateFileSize(content, relPath)
    await assertWorkspaceQuota(ctx.workspaceRoot, Buffer.byteLength(content))
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
    await emitEvent({
      type: 'tool.completed',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      tool: 'create_file',
      action: `arquivo criado: ${relPath}`,
      status: 'OK',
      message: `create_file: ${relPath} (${content.length} chars)`,
      data: { path: relPath, bytes: Buffer.byteLength(content) },
    })
    return { ok: true, output: `ARQUIVO_CRIADO: ${relPath} (${Buffer.byteLength(content)}B)`, data: { path: relPath } }
  },
}

export const modifyFileTool: ToolDefinition = {
  description:
    'Modifica um arquivo existente. Dois modos: (1) search_replace com searchText/replaceText; (2) rewrite com conteúdo completo.',
  name: 'modify_file',
  category: 'fs',
  permissions: ['fs:write'],
  params: [
    { name: 'path', type: 'string', required: true, description: 'Caminho relativo' },
    { name: 'searchText', type: 'string', required: false, description: 'Trecho exato a substituir' },
    { name: 'replaceText', type: 'string', required: false, description: 'Novo trecho' },
    { name: 'content', type: 'string', required: false, description: 'Modo rewrite: conteúdo completo novo' },
  ],
  async execute(args, ctx): Promise<ToolResult> {
    const relPath = String(args.path)
    const abs = safeResolve(ctx.workspaceRoot, relPath)
    validateFilePath(abs)
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat || stat.isDirectory()) return { ok: false, output: `ARQUIVO_NAO_ENCONTRADO: ${relPath}` }

    if (args.searchText !== undefined && args.replaceText !== undefined) {
      const content = await fs.readFile(abs, 'utf8')
      const search = String(args.searchText)
      if (!content.includes(search)) {
        return { ok: false, output: `TRECHO_NAO_ENCONTRADO em ${relPath}: ${search.slice(0, 120)}` }
      }
      const updated = content.replace(search, String(args.replaceText))
      validateFileSize(updated, relPath)
      await fs.writeFile(abs, updated, 'utf8')
      return { ok: true, output: `ARQUIVO_MODIFICADO: ${relPath} (substituição aplicada)` }
    }

    if (args.content !== undefined) {
      const content = String(args.content)
      validateFileSize(content, relPath)
      await fs.writeFile(abs, content, 'utf8')
      return { ok: true, output: `ARQUIVO_REESCRITO: ${relPath} (${content.length} chars)` }
    }

    return { ok: false, output: 'Forneça searchText+replaceText OU content' }
  },
}

export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  description: 'Remove um arquivo do workspace. Não remove diretórios. Ação registrada em log de auditoria.',
  category: 'fs',
  permissions: ['fs:delete'],
  params: [{ name: 'path', type: 'string', required: true, description: 'Caminho relativo do arquivo' }],
  async execute(args, ctx): Promise<ToolResult> {
    const relPath = String(args.path)
    const abs = safeResolve(ctx.workspaceRoot, relPath)
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat) return { ok: false, output: `ARQUIVO_NAO_ENCONTRADO: ${relPath}` }
    if (stat.isDirectory()) return { ok: false, output: 'Use apenas para arquivos, não diretórios' }
    await fs.unlink(abs)
    await emitEvent({
      type: 'tool.completed',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      tool: 'delete_file',
      action: `arquivo removido: ${relPath}`,
      status: 'OK',
      message: `delete_file: ${relPath}`,
    })
    return { ok: true, output: `ARQUIVO_REMOVIDO: ${relPath}` }
  },
}

export const createDirectoryTool: ToolDefinition = {
  name: 'create_directory',
  description: 'Cria um diretório (com pais) no workspace.',
  category: 'fs',
  permissions: ['fs:write'],
  params: [{ name: 'path', type: 'string', required: true, description: 'Caminho relativo do diretório' }],
  async execute(args, ctx): Promise<ToolResult> {
    const abs = safeResolve(ctx.workspaceRoot, String(args.path))
    await fs.mkdir(abs, { recursive: true })
    return { ok: true, output: `DIRETÓRIO_CRIADO: ${args.path}` }
  },
}

export const getProjectStatusTool: ToolDefinition = {
  name: 'get_project_status',
  description: 'Retorna estatísticas do workspace: número de arquivos, tipos, tamanho total, arquivos principais.',
  category: 'info',
  permissions: ['fs:read'],
  params: [],
  async execute(_args, ctx): Promise<ToolResult> {
    let fileCount = 0
    let dirCount = 0
    const byExt: Record<string, number> = {}
    const walk = async (dir: string) => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (BLOCKED_DIR_NAMES.has(e.name)) continue
          dirCount++
          await walk(full)
        } else {
          fileCount++
          const ext = path.extname(e.name) || '(sem ext)'
          byExt[ext] = (byExt[ext] ?? 0) + 1
        }
      }
    }
    await walk(ctx.workspaceRoot)
    const size = await getWorkspaceSize(ctx.workspaceRoot)
    const topExts = Object.entries(byExt)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([e, n]) => `${e}:${n}`)
      .join(' ')
    return {
      ok: true,
      output: `WORKSPACE: ${fileCount} arquivos, ${dirCount} diretórios, ${(size / 1024).toFixed(1)}KB\nTipos: ${topExts}`,
      data: { fileCount, dirCount, sizeBytes: size },
    }
  },
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
