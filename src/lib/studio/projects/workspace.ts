// ============================================================
// PROJECTS / WORKSPACE — Gestão de workspaces isolados
// Cada projeto tem root próprio em workspaces/<projectId>/.
// Isolamento: nenhuma operação atravessa a raiz do workspace.
// ============================================================

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { STUDIO_CONFIG } from '../config'
import { getTemplate, readmeFor } from './templates'
import { validateFilePath } from '../security/path'

export function projectRoot(projectId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error('projectId inválido')
  return path.join(STUDIO_CONFIG.executor.workspacesRoot, projectId)
}

/** Cria workspace com template e README (DB = fonte da verdade + disco). */
export async function createWorkspace(
  projectId: string,
  name: string,
  type: string,
  description: string
): Promise<{ rootPath: string; fileCount: number }> {
  const root = projectRoot(projectId)
  await fs.mkdir(root, { recursive: true })

  const template = getTemplate(type)
  const files = [...template.files, readmeFor(name, type, description)]

  // 1) disco (materialização imediata p/ agents/execução)
  for (const f of files) {
    const abs = path.join(root, f.path)
    validateFilePath(abs)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, f.content, 'utf8')
  }

  // 2) DB (persistência — fonte da verdade; o dual-write do provider
  //    regrava o disco e registra o marker de sincronização)
  const { workspaceProvider } = await import('../workspace/db-provider')
  for (const f of files) {
    await workspaceProvider.writeFile(projectId, f.path, f.content, 'utf8')
  }
  return { rootPath: root, fileCount: files.length }
}

/** Verifica/cria estrutura mínima de testes. */
export async function ensureTestStructure(root: string): Promise<void> {
  const testDir = path.join(root, 'test')
  const exists = await fs.stat(testDir).catch(() => null)
  if (!exists) {
    await fs.mkdir(testDir, { recursive: true })
    await fs.writeFile(
      path.join(testDir, 'smoke.test.js'),
      `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n\ntest('projeto estruturado', () => {\n  assert.ok(true)\n})\n`,
      'utf8'
    )
  }
}

/** Remove workspace (só pode ser chamado pelo dono do projeto). */
export async function deleteWorkspace(projectId: string): Promise<void> {
  const root = projectRoot(projectId)
  // dupla verificação: caminho resolvido dentro de workspacesRoot
  const resolved = path.resolve(root)
  if (!resolved.startsWith(path.resolve(STUDIO_CONFIG.executor.workspacesRoot) + path.sep)) {
    throw new Error('recusa de exclusão fora do root de workspaces')
  }
  await fs.rm(resolved, { recursive: true, force: true })
}

/** Lista árvore de arquivos para a UI (painel FILES). */
export async function workspaceTree(root: string, maxEntries = 500): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
  const out: Array<{ path: string; type: 'file' | 'dir' }> = []
  const walk = async (dir: string, prefix: string) => {
    if (out.length >= maxEntries) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (['node_modules', '.git'].includes(e.name)) continue
        out.push({ path: rel, type: 'dir' })
        await walk(path.join(dir, e.name), rel)
      } else {
        out.push({ path: rel, type: 'file' })
      }
    }
  }
  await walk(root, '')
  return out
}

/** Detecta MIME para preview de arquivos. */
export function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
  }
  return map[ext] ?? 'application/octet-stream'
}

export function newProjectId(): string {
  return crypto.randomBytes(8).toString('hex')
}
