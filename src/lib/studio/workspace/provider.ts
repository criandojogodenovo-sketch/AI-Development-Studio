// ============================================================
// WORKSPACE PROVIDER — Abstração de storage do workspace
//
// A aplicação NUNCA fala com o storage diretamente: usa esta
// interface. Hoje: DatabaseWorkspaceProvider (Postgres/Neon —
// fonte da verdade, sobrevive ao serverless). Amanhã: trocar
// por Blob/S3 = implementar a mesma interface.
//
// DISCO (/tmp em serverless) = apenas CAMADA DE MATERIALIALIZAÇÃO
// para o Execution Engine (ver ./sync.ts). Nunca fonte da verdade.
// ============================================================

export interface TreeNode {
  path: string
  type: 'file' | 'dir'
}

export interface FileContent {
  path: string
  content: string
  encoding: 'utf8' | 'base64'
  size: number
}

export interface SearchResult {
  path: string
  line: number
  text: string
}

export interface SnapshotInfo {
  id: string
  label: string
  reason: string
  fileCount: number
  totalBytes: number
  createdAt: string
}

export interface WriteOptions {
  /** sobrescreve mesmo se o arquivo existir (default: true) */
  overwrite?: boolean
  /** uso interno (sync de git/execution): permite caminhos .git/** */
  internal?: boolean
}

export interface WorkspaceProvider {
  readonly name: string
  /** Árvore de arquivos (caminhos relativos, sem .git/node_modules) */
  tree(projectId: string, opts?: { maxEntries?: number }): Promise<TreeNode[]>
  /** Lê um arquivo (texto ou base64) */
  readFile(projectId: string, path: string): Promise<FileContent | null>
  /** Grava um arquivo (cria pais implícitos). Atualiza disco se materializado */
  writeFile(projectId: string, path: string, content: string, encoding?: 'utf8' | 'base64', opts?: WriteOptions): Promise<{ bytes: number }>
  /** Cria diretório (persiste dir vazio) */
  createDir(projectId: string, path: string, opts?: { internal?: boolean }): Promise<void>
  /** Remove arquivo ou diretório (recursivo) */
  deleteEntry(projectId: string, path: string, opts?: { internal?: boolean }): Promise<{ removed: number }>
  /** Renomeia/move arquivo ou diretório */
  rename(projectId: string, from: string, to: string, opts?: { internal?: boolean }): Promise<{ moved: number }>
  /** Busca textual em todos os arquivos de texto */
  search(projectId: string, query: string, opts?: { maxResults?: number }): Promise<SearchResult[]>
  /** Snapshot versionado do workspace inteiro */
  snapshot(projectId: string, label: string, reason?: string): Promise<{ id: string; fileCount: number; totalBytes: number }>
  /** Lista snapshots */
  listSnapshots(projectId: string, take?: number): Promise<SnapshotInfo[]>
  /** Restaura snapshot (substitui o estado atual) */
  restoreSnapshot(projectId: string, snapshotId: string): Promise<{ restored: number }>
}

/** Normaliza um caminho relativo de workspace (validação dura). */
export function normalizeWorkspacePath(input: string, opts?: { internal?: boolean }): string {
  if (typeof input !== 'string') throw new Error('INVALID_PATH: caminho inválido')
  let p = input.replace(/\\/g, '/').trim()
  // remove barras iniciais e duplicadas
  p = p.replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!p || p === '.') throw new Error('INVALID_PATH: caminho vazio')
  if (p.includes('\0')) throw new Error('INVALID_PATH: null byte')
  // traversal absoluto
  const segments = p.split('/')
  for (const seg of segments) {
    if (seg === '..') throw new Error(`PATH_TRAVERSAL_BLOCKED: "${input}"`)
    if (seg === '') throw new Error(`INVALID_PATH: segmento vazio em "${input}"`)
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) throw new Error(`INVALID_FILENAME: "${seg}"`)
  }
  // .git é domínio do GitService/sync (interno) — bloqueado para usuários e agentes
  if (!opts?.internal && (p === '.git' || p.startsWith('.git/'))) {
    throw new Error('BLOCKED_PATH: .git é gerenciado pelo sistema')
  }
  if (p.length > 512) throw new Error('INVALID_PATH: caminho excessivamente longo')
  return p
}
