// ============================================================
// SEGURANÇA — Proteção de caminhos (path traversal) e validação
// Toda operação de arquivo dos agentes passa por aqui.
// ============================================================

import path from 'path'
import fs from 'fs/promises'
import { STUDIO_CONFIG } from '../config'

/**
 * Resolve e valida um caminho relativo DENTRO de um workspace.
 * Lança erro se detectar path traversal ou caminho bloqueado.
 */
export function safeResolve(workspaceRoot: string, relativePath: string): string {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('INVALID_PATH: caminho vazio ou inválido')
  }
  // Normaliza separadores
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  // Rejeita tentativas explícitas de traversal ANTES de resolver
  if (normalized.includes('..') || normalized.includes('\0')) {
    throw new Error(`PATH_TRAVERSAL_BLOCKED: "${relativePath}"`)
  }
  const root = path.resolve(workspaceRoot)
  const resolved = path.resolve(root, normalized)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`PATH_TRAVERSAL_BLOCKED: "${relativePath}" escapa do workspace`)
  }
  // Bloqueia segmentos proibidos (node_modules, .git internals, etc.)
  const rel = path.relative(root, resolved)
  for (const blocked of STUDIO_CONFIG.files.blockedPaths) {
    const seg = blocked.replace(/\/$/, '')
    if (rel === seg || rel.startsWith(seg + path.sep)) {
      throw new Error(`BLOCKED_PATH: "${rel}" (segmento proibido: ${seg})`)
    }
  }
  return resolved
}

/** Valida nome/extensão de arquivo para escrita. */
export function validateFilePath(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase()
  if (STUDIO_CONFIG.files.blockedExtensions.includes(ext)) {
    throw new Error(`BLOCKED_EXTENSION: "${ext}" não é permitido`)
  }
  const base = path.basename(filePath)
  if (base === '.env' || base.startsWith('.env.')) {
    throw new Error('BLOCKED_FILE: arquivos .env são proibidos no workspace')
  }
  if (/[<>:"|?*\x00-\x1f]/.test(base)) {
    throw new Error(`INVALID_FILENAME: "${base}"`)
  }
}

/** Verifica tamanho de conteúdo antes de escrever. */
export function validateFileSize(content: string | Buffer, what = 'arquivo'): void {
  const size = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length
  if (size > STUDIO_CONFIG.files.maxFileSize) {
    throw new Error(
      `FILE_TOO_LARGE: ${what} tem ${size} bytes (máximo ${STUDIO_CONFIG.files.maxFileSize})`
    )
  }
}

/** Tamanho total do workspace (bytes) — respeita MAX_PROJECT_SIZE. */
export async function getWorkspaceSize(workspaceRoot: string): Promise<number> {
  let total = 0
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
        if (STUDIO_CONFIG.files.blockedPaths.some((b) => full.includes(b.replace(/\/$/, '')))) continue
        await walk(full)
      } else {
        try {
          const st = await fs.stat(full)
          total += st.size
        } catch {
          /* arquivo removido durante varredura */
        }
      }
    }
  }
  await walk(path.resolve(workspaceRoot))
  return total
}

/** Garante que o workspace não excederá o limite ao adicionar bytes. */
export async function assertWorkspaceQuota(workspaceRoot: string, incomingBytes: number): Promise<void> {
  const current = await getWorkspaceSize(workspaceRoot)
  if (current + incomingBytes > STUDIO_CONFIG.files.maxProjectSize) {
    throw new Error(
      `PROJECT_TOO_LARGE: ${current + incomingBytes} bytes excederia ${STUDIO_CONFIG.files.maxProjectSize}`
    )
  }
}
