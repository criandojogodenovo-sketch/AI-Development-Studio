// ============================================================
// DATABASE WORKSPACE PROVIDER — implementação Postgres/Neon
//
// Fonte da verdade do workspace. Cada arquivo = 1 row.
// Dual-write: grava também no disco materializado (se existir)
// para manter o Execution Engine coerente (ver ./sync.ts).
//
// Binários (git objects, imagens) → encoding=base64.
// Caminhos .git/** → somente via opts.internal (GitService/sync).
// ============================================================

import fs from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { projectRoot } from '../projects/workspace'
import { validateFilePath, validateFileSize } from '../security/path'
import { writeMarkerEntry, removeMarkerEntry } from './sync'
import {
  normalizeWorkspacePath,
  type WorkspaceProvider,
  type TreeNode,
  type FileContent,
  type SearchResult,
  type SnapshotInfo,
  type WriteOptions,
} from './provider'

/** Grava no disco materializado (best-effort; DB é a verdade). */
async function dualWriteDisk(projectId: string, rel: string, content: string, encoding: 'utf8' | 'base64'): Promise<void> {
  try {
    const root = projectRoot(projectId)
    const dirExists = await fs.stat(root).catch(() => null)
    if (!dirExists) return // não materializado — sync cuidará quando precisar
    const abs = path.join(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')
    await fs.writeFile(abs, buf)
    // marker com MTIME real do disco (comparação exata no syncBack)
    const st = await fs.stat(abs).catch(() => null)
    await writeMarkerEntry(projectId, rel, st ? st.mtimeMs : Date.now())
  } catch {
    /* disco é cache — falha aqui não é erro de negócio */
  }
}

async function dualRemoveDisk(projectId: string, rel: string): Promise<void> {
  try {
    const root = projectRoot(projectId)
    const abs = path.join(root, rel)
    await fs.rm(abs, { recursive: true, force: true }).catch(() => {})
    await removeMarkerEntry(projectId, rel)
  } catch {
    /* best-effort */
  }
}

export class DatabaseWorkspaceProvider implements WorkspaceProvider {
  readonly name = 'database'

  async tree(projectId: string, opts?: { maxEntries?: number }): Promise<TreeNode[]> {
    const max = Math.min(opts?.maxEntries ?? 500, 2000)
    const rows = await db.workspaceFile.findMany({
      where: { projectId, path: { not: { startsWith: '.git/' } } },
      select: { path: true, isDir: true },
      take: max * 2,
    })
    const nodes = new Map<string, TreeNode>()
    for (const r of rows) {
      if (r.isDir) {
        nodes.set(r.path, { path: r.path, type: 'dir' })
        continue
      }
      // deriva diretórios implícitos dos caminhos de arquivos
      const parts = r.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        nodes.set(dir, { path: dir, type: 'dir' })
      }
      nodes.set(r.path, { path: r.path, type: 'file' })
    }
    return [...nodes.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.path.localeCompare(b.path)
    }).slice(0, max)
  }

  async readFile(projectId: string, p: string): Promise<FileContent | null> {
    const rel = normalizeWorkspacePath(p, { internal: true })
    const row = await db.workspaceFile.findUnique({
      where: { projectId_path: { projectId, path: rel } },
    })
    if (!row || row.isDir) return null
    if (row.size > STUDIO_CONFIG.files.maxFileReadBytes) {
      throw new Error(`ARQUIVO_GRANDE: ${row.size} bytes (máx ${STUDIO_CONFIG.files.maxFileReadBytes})`)
    }
    return {
      path: rel,
      content: row.content ?? '',
      encoding: (row.encoding as 'utf8' | 'base64') ?? 'utf8',
      size: row.size,
    }
  }

  async writeFile(
    projectId: string,
    p: string,
    content: string,
    encoding: 'utf8' | 'base64' = 'utf8',
    opts?: WriteOptions
  ): Promise<{ bytes: number }> {
    const rel = normalizeWorkspacePath(p, { internal: opts?.internal })
    const bytes = Buffer.byteLength(content, encoding === 'base64' ? 'base64' : 'utf8')

    // valida tamanho + extensão (arquivos .env, .pem etc. proibidos)
    if (!opts?.internal) {
      validateFileSize(content, `arquivo "${rel}"`)
      validateFilePath(rel)
    } else if (bytes > STUDIO_CONFIG.files.maxFileSize * 4) {
      // .git objects podem ultrapassar o limite de arquivo comum; cap duro maior
      throw new Error(`FILE_TOO_LARGE: ${bytes} bytes`)
    }

    const existing = await db.workspaceFile.findUnique({
      where: { projectId_path: { projectId, path: rel } },
      select: { isDir: true },
    })
    if (existing?.isDir) throw new Error(`É diretório: ${rel}`)

    await db.workspaceFile.upsert({
      where: { projectId_path: { projectId, path: rel } },
      create: { projectId, path: rel, isDir: false, encoding, content, size: bytes },
      update: { isDir: false, encoding, content, size: bytes },
    })

    await dualWriteDisk(projectId, rel, content, encoding)
    return { bytes }
  }

  async createDir(projectId: string, p: string, opts?: { internal?: boolean }): Promise<void> {
    const rel = normalizeWorkspacePath(p, { internal: opts?.internal })
    const exists = await db.workspaceFile.findUnique({
      where: { projectId_path: { projectId, path: rel } },
      select: { isDir: true },
    })
    if (exists && !exists.isDir) throw new Error(`Já existe ARQUIVO com este nome: ${rel}`)
    await db.workspaceFile.upsert({
      where: { projectId_path: { projectId, path: rel } },
      create: { projectId, path: rel, isDir: true, content: null, size: 0 },
      update: { isDir: true },
    })
    try {
      await fs.mkdir(path.join(projectRoot(projectId), rel), { recursive: true })
    } catch { /* best-effort */ }
  }

  async deleteEntry(projectId: string, p: string, opts?: { internal?: boolean }): Promise<{ removed: number }> {
    const rel = normalizeWorkspacePath(p, { internal: opts?.internal })
    const prefix = rel + '/'
    // arquivos sob o prefixo (recursivo) + a própria entrada
    const rows = await db.workspaceFile.findMany({
      where: { projectId, OR: [{ path: rel }, { path: { startsWith: prefix } }] },
      select: { path: true, isDir: true },
    })
    if (rows.length === 0) throw new Error(`NÃO_ENCONTRADO: ${rel}`)
    await db.workspaceFile.deleteMany({
      where: { projectId, OR: [{ path: rel }, { path: { startsWith: prefix } }] },
    })
    await dualRemoveDisk(projectId, rel)
    return { removed: rows.filter((r) => !r.isDir).length }
  }

  async rename(projectId: string, from: string, to: string, opts?: { internal?: boolean }): Promise<{ moved: number }> {
    const src = normalizeWorkspacePath(from, { internal: opts?.internal })
    const dst = normalizeWorkspacePath(to, { internal: opts?.internal })
    if (src === dst) return { moved: 0 }

    const srcEntry = await db.workspaceFile.findUnique({
      where: { projectId_path: { projectId, path: src } },
    })
    if (!srcEntry) throw new Error(`NÃO_ENCONTRADO: ${src}`)
    const dstEntry = await db.workspaceFile.findUnique({
      where: { projectId_path: { projectId, path: dst } },
    })
    if (dstEntry) throw new Error(`DESTINO_JÁ_EXISTE: ${dst}`)
    if (!opts?.internal) validateFilePath(dst)

    const isDir = srcEntry.isDir
    const prefix = src + '/'
    const under = isDir
      ? await db.workspaceFile.findMany({ where: { projectId, path: { startsWith: prefix } } })
      : []

    await db.$transaction(async (tx) => {
      // renomeia a própria entrada
      await tx.workspaceFile.update({
        where: { projectId_path: { projectId, path: src } },
        data: { path: dst },
      })
      // renomeia filhos (prefixo)
      for (const child of under) {
        await tx.workspaceFile.update({
          where: { id: child.id },
          data: { path: dst + child.path.slice(src.length) },
        })
      }
    })

    // disco: rename atômico quando possível
    try {
      const root = projectRoot(projectId)
      const dirExists = await fs.stat(root).then(() => true).catch(() => false)
      if (dirExists) {
        await fs.mkdir(path.dirname(path.join(root, dst)), { recursive: true })
        await fs.rename(path.join(root, src), path.join(root, dst))
      }
    } catch {
      // disco dessincronizado → invalida marker; próxima materialização corrige
      await removeMarkerEntry(projectId, src)
    }
    return { moved: under.length + 1 }
  }

  async search(projectId: string, query: string, opts?: { maxResults?: number }): Promise<SearchResult[]> {
    const q = query.trim()
    if (!q || q.length < 2) throw new Error('BUSCA_INVÁLIDA (mín 2 caracteres)')
    const maxResults = Math.min(opts?.maxResults ?? 50, 100)
    const rows = await db.workspaceFile.findMany({
      where: {
        projectId,
        isDir: false,
        encoding: 'utf8',
        size: { lte: STUDIO_CONFIG.files.maxFileReadBytes },
        path: { not: { startsWith: '.git/' } },
      },
      select: { path: true, content: true },
      take: 400,
    })
    const needle = q.toLowerCase()
    const results: SearchResult[] = []
    outer: for (const r of rows) {
      const lines = (r.content ?? '').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push({ path: r.path, line: i + 1, text: lines[i].trim().slice(0, 200) })
          if (results.length >= maxResults) break outer
        }
      }
    }
    return results
  }

  async snapshot(projectId: string, label: string, reason = 'manual'): Promise<{ id: string; fileCount: number; totalBytes: number }> {
    const rows = await db.workspaceFile.findMany({
      where: { projectId, path: { not: { startsWith: '.git/' } } },
    })
    const files = rows.map((r) => ({
      path: r.path,
      isDir: r.isDir,
      encoding: r.encoding,
      content: r.isDir ? null : r.content,
    }))
    const totalBytes = rows.reduce((s, r) => s + r.size, 0)
    if (totalBytes > 20_000_000) {
      throw new Error('SNAPSHOT_GRANDE_DEMAIS: workspace excede 20MB — reduza arquivos grandes')
    }
    const snap = await db.workspaceSnapshot.create({
      data: {
        projectId,
        label: label.slice(0, 120),
        reason,
        files: files as unknown as object,
        fileCount: rows.filter((r) => !r.isDir).length,
        totalBytes,
      },
    })
    return { id: snap.id, fileCount: snap.fileCount, totalBytes: snap.totalBytes }
  }

  async listSnapshots(projectId: string, take = 20): Promise<SnapshotInfo[]> {
    const snaps = await db.workspaceSnapshot.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 50),
    })
    return snaps.map((s) => ({
      id: s.id,
      label: s.label,
      reason: s.reason,
      fileCount: s.fileCount,
      totalBytes: s.totalBytes,
      createdAt: s.createdAt.toISOString(),
    }))
  }

  async restoreSnapshot(projectId: string, snapshotId: string): Promise<{ restored: number }> {
    const snap = await db.workspaceSnapshot.findFirst({
      where: { id: snapshotId, projectId },
    })
    if (!snap) throw new Error('SNAPSHOT_NÃO_ENCONTRADO')
    const files = (snap.files as unknown as Array<{ path: string; isDir: boolean; encoding: string; content: string | null }>) ?? []
    await db.$transaction([
      db.workspaceFile.deleteMany({ where: { projectId } }),
      db.workspaceFile.createMany({
        data: files.map((f) => ({
          projectId,
          path: f.path,
          isDir: f.isDir,
          encoding: f.encoding ?? 'utf8',
          content: f.isDir ? null : (f.content ?? ''),
          size: f.isDir ? 0 : Buffer.byteLength(f.content ?? '', 'utf8'),
        })),
      }),
    ])
    // disco: re-materializa do zero na próxima execução
    await invalidateDisk(projectId)
    return { restored: files.filter((f) => !f.isDir).length }
  }
}

/** Invalida a materialização de disco (próxima execução reescreve tudo). */
export async function invalidateDisk(projectId: string): Promise<void> {
  try {
    const root = projectRoot(projectId)
    await fs.rm(root, { recursive: true, force: true })
  } catch { /* best-effort */ }
}

/** Provider ativo (única instância — DATABASE é a fonte da verdade). */
export const workspaceProvider: WorkspaceProvider = new DatabaseWorkspaceProvider()
