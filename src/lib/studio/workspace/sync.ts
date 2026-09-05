// ============================================================
// WORKSPACE SYNC — Camada de materialização DB ↔ disco
//
// DB (Neon) = FONTE DA VERDADE.
// Disco (WORKSPACES_ROOT, /tmp em serverless) = cache materializado
// para o Execution Engine rodar comandos (npm test, node, git...).
//
// Fluxos:
//   ensureMaterialized(projectId) — DB → disco (incremental via marker)
//   syncBackToDb(projectId)       — disco → DB (após execução; captura
//                                   arquivos criados por comandos)
//   importLegacyFromDisk          — migração: projetos antigos com
//                                   arquivos apenas em disco (pré-DB)
//
// Marker (workspacesRoot/.markers/<projectId>.json) registra o
// updatedAt de cada arquivo já gravado no disco → escrita incremental.
// ============================================================

import fs from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { projectRoot } from '../projects/workspace'

const MARKER_DIR = path.join(STUDIO_CONFIG.executor.workspacesRoot, '.markers')
const MAX_SYNC_FILE_BYTES = 4 * 1024 * 1024 // 4MB cap por arquivo na sincronização

/** Diretórios nunca sincronizados disco↔DB (gerados, não código-fonte). */
const EXCLUDED_DIRS = new Set(['node_modules', '.next', 'dist', '.cache', '__pycache__', '.studio-cache'])

interface Marker { files: Record<string, number> }

function markerPath(projectId: string): string {
  return path.join(MARKER_DIR, `${projectId}.json`)
}

async function readMarker(projectId: string): Promise<Marker> {
  try {
    const raw = await fs.readFile(markerPath(projectId), 'utf8')
    const m = JSON.parse(raw) as Marker
    return m && typeof m.files === 'object' ? m : { files: {} }
  } catch {
    return { files: {} }
  }
}

async function writeMarker(projectId: string, marker: Marker): Promise<void> {
  try {
    await fs.mkdir(MARKER_DIR, { recursive: true })
    await fs.writeFile(markerPath(projectId), JSON.stringify(marker), 'utf8')
  } catch { /* best-effort */ }
}

export async function writeMarkerEntry(projectId: string, rel: string, epoch: number): Promise<void> {
  const m = await readMarker(projectId)
  m.files[rel] = epoch
  await writeMarker(projectId, m)
}

export async function removeMarkerEntry(projectId: string, rel: string): Promise<void> {
  const m = await readMarker(projectId)
  if (rel in m.files) {
    delete m.files[rel]
    // filhos de diretório removido
    const prefix = rel + '/'
    for (const k of Object.keys(m.files)) if (k.startsWith(prefix)) delete m.files[k]
    await writeMarker(projectId, m)
  }
}

/** Detecta se um buffer é UTF-8 válido (senão → base64). */
function isTextBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return true
  // BOM/zero bytes → binário
  if (buf.includes(0)) return false
  const round = Buffer.from(buf.toString('utf8'), 'utf8')
  return round.equals(buf)
}

/** Caminha o disco coletando arquivos (exclui gerados). */
async function walkDisk(root: string, includeGit: boolean): Promise<Array<{ rel: string; abs: string }>> {
  const out: Array<{ rel: string; abs: string }> = []
  const walk = async (dir: string) => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const rel = path.relative(root, abs).replace(/\\/g, '/')
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue
        if (e.name === '.git' && !includeGit) continue
        await walk(abs)
      } else {
        out.push({ rel, abs })
      }
    }
  }
  await walk(root)
  return out
}

/** MIGRAÇÃO: projeto legado com arquivos só no disco (pré-DB) → importa p/ DB. */
export async function importLegacyFromDisk(projectId: string): Promise<number> {
  const root = projectRoot(projectId)
  const files = await walkDisk(root, false)
  if (files.length === 0) return 0
  let imported = 0
  const marker: Marker = { files: {} }
  for (const f of files) {
    const stat = await fs.stat(f.abs).catch(() => null)
    if (!stat || stat.size > MAX_SYNC_FILE_BYTES) continue
    const buf = await fs.readFile(f.abs)
    const text = isTextBuffer(buf)
    await db.workspaceFile.upsert({
      where: { projectId_path: { projectId, path: f.rel } },
      create: {
        projectId, path: f.rel, isDir: false,
        encoding: text ? 'utf8' : 'base64',
        content: text ? buf.toString('utf8') : buf.toString('base64'),
        size: buf.length,
      },
      update: { encoding: text ? 'utf8' : 'base64', content: text ? buf.toString('utf8') : buf.toString('base64'), size: buf.length },
    })
    marker.files[f.rel] = stat.mtimeMs
    imported++
  }
  await writeMarker(projectId, marker)
  return imported
}

/**
 * MATERIALIZAÇÃO: garante que o disco reflete o DB (incremental).
 * Retorna o caminho absoluto do workspace no disco.
 * Idempotente e deduplicado em processo (execuções concorrentes).
 */
const inflight = new Map<string, Promise<string>>()

export function ensureMaterialized(projectId: string): Promise<string> {
  const existing = inflight.get(projectId)
  if (existing) return existing
  const p = doMaterialize(projectId).finally(() => inflight.delete(projectId))
  inflight.set(projectId, p)
  return p
}

async function doMaterialize(projectId: string): Promise<string> {
  const root = projectRoot(projectId)
  const rows = await db.workspaceFile.findMany({ where: { projectId } })

  // Migração legada: DB vazio + disco com arquivos → importa
  if (rows.length === 0) {
    const imported = await importLegacyFromDisk(projectId)
    if (imported > 0) return root
    await fs.mkdir(root, { recursive: true })
    await writeMarker(projectId, { files: {} })
    return root
  }

  const marker = await readMarker(projectId)
  const dbPaths = new Set(rows.map((r) => r.path))
  let changed = false

  // 1) remove do disco o que não existe mais no DB
  for (const p of Object.keys(marker.files)) {
    if (!dbPaths.has(p)) {
      await fs.rm(path.join(root, p), { recursive: true, force: true }).catch(() => {})
      delete marker.files[p]
      changed = true
    }
  }

  // 2) grava arquivos novos/atualizados (updatedAt > marker)
  for (const row of rows) {
    if (row.isDir) continue
    const epoch = new Date(row.updatedAt).getTime()
    if ((marker.files[row.path] ?? -1) >= epoch) continue // disco já atualizado
    const abs = path.join(root, row.path)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const buf = row.encoding === 'base64'
      ? Buffer.from(row.content ?? '', 'base64')
      : Buffer.from(row.content ?? '', 'utf8')
    await fs.writeFile(abs, buf)
    // marker guarda o MTIME REAL do disco → comparação exata no syncBack
    const st = await fs.stat(abs).catch(() => null)
    marker.files[row.path] = st ? st.mtimeMs : epoch
    changed = true
  }

  // 3) remove diretórios vazios obsoletos (dirs DB viram implícitos)
  if (rows.length > 0 && changed) await pruneEmptyDirs(root)

  if (changed) await writeMarker(projectId, marker)
  await fs.mkdir(root, { recursive: true })
  return root
}

/** Remove diretórios vazios (exceto raiz) do workspace em disco. */
async function pruneEmptyDirs(root: string): Promise<void> {
  const walk = async (dir: string): Promise<boolean> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    let allEmpty = true
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        const empty = await walk(abs)
        if (!empty) allEmpty = false
      } else {
        allEmpty = false
      }
    }
    if (allEmpty && dir !== root) {
      await fs.rmdir(dir).catch(() => {})
      return true
    }
    return false
  }
  await walk(root)
}

/**
 * PÓS-EXECUÇÃO: disco → DB. Captura arquivos criados/modificados/
// removidos por comandos (npm install cria lock, testes geram artefatos...).
 * @param deleteMissing remove do DB arquivos que sumiram do disco
 *                      (só usar quando o disco é autoritativo — logo
 *                      após ensureMaterialized + execução no mesmo fluxo)
 */
export async function syncBackToDb(projectId: string, opts?: { includeGit?: boolean; deleteMissing?: boolean }): Promise<{ synced: number; removed: number; skipped: number }> {
  const root = projectRoot(projectId)
  const dirExists = await fs.stat(root).then(() => true).catch(() => false)
  if (!dirExists) return { synced: 0, removed: 0, skipped: 0 }

  const includeGit = opts?.includeGit ?? false
  const diskFiles = await walkDisk(root, includeGit)
  const marker = await readMarker(projectId)

  const rows = await db.workspaceFile.findMany({ where: { projectId } })
  const dbMap = new Map(rows.map((r) => [r.path, r]))
  const diskRelSet = new Set(diskFiles.map((f) => f.rel))

  let synced = 0
  let skipped = 0

  for (const f of diskFiles) {
    const stat = await fs.stat(f.abs).catch(() => null)
    if (!stat) continue
    if (stat.size > MAX_SYNC_FILE_BYTES) { skipped++; continue }
    const row = dbMap.get(f.rel)
    const markerEpoch = marker.files[f.rel] ?? 0
    const diskEpoch = stat.mtimeMs

    // sincroniza: novo no DB, tamanho diferente, ou modificado após materialização
    const needsSync = !row || row.size !== stat.size || diskEpoch > markerEpoch + 1000
    if (!needsSync) continue

    const buf = await fs.readFile(f.abs)
    const text = isTextBuffer(buf)
    await db.workspaceFile.upsert({
      where: { projectId_path: { projectId, path: f.rel } },
      create: {
        projectId, path: f.rel, isDir: false,
        encoding: text ? 'utf8' : 'base64',
        content: text ? buf.toString('utf8') : buf.toString('base64'),
        size: buf.length,
      },
      update: {
        isDir: false,
        encoding: text ? 'utf8' : 'base64',
        content: text ? buf.toString('utf8') : buf.toString('base64'),
        size: buf.length,
      },
    })
    marker.files[f.rel] = diskEpoch
    synced++
  }

  let removed = 0
  if (opts?.deleteMissing) {
    for (const row of rows) {
      if (row.isDir) continue
      const inGit = row.path === '.git' || row.path.startsWith('.git/')
      if (inGit && !includeGit) continue
      if (row.path.startsWith('.git/') && !includeGit) continue
      if (!diskRelSet.has(row.path)) {
        await db.workspaceFile.delete({ where: { id: row.id } }).catch(() => {})
        delete marker.files[row.path]
        removed++
      }
    }
  }

  await writeMarker(projectId, marker)
  return { synced, removed, skipped }
}

/** Força re-materialização completa na próxima execução. */
export async function invalidateMaterialization(projectId: string): Promise<void> {
  await fs.rm(markerPath(projectId), { force: true }).catch(() => {})
}
