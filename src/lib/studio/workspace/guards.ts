// ============================================================
// WORKSPACE API GUARDS — autenticação + posse de projeto
// Compartilhado por todas as rotas /api/workspace/*
// ============================================================

import { db } from '@/lib/db'
import { getSessionUser, type SessionUser } from '@/lib/studio/security/auth'

export interface OwnedContext {
  user: SessionUser
  projectId: string
}

export interface GuardResult {
  status?: number // 401 | 404 quando falhou
  ctx?: OwnedContext // presente quando ok
}

/** 401 sem sessão; 404 sem posse; ctx quando ok. */
export async function guard(req: Request, projectId: string): Promise<GuardResult> {
  const user = await getSessionUser(req)
  if (!user) return { status: 401 }
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) return { status: 404 }
  const project = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: { id: true },
  })
  if (!project) return { status: 404 }
  return { ctx: { user, projectId } }
}

/** Mapa de erro de domínio → status HTTP honesto. */
export function domainError(e: unknown): Response {
  const msg = (e as Error).message ?? 'ERRO'
  const status = /TRAVERSAL|BLOCKED/i.test(msg)
    ? 403
    : /NÃO_ENCONTRADO|GRANDE_DEMAIS/i.test(msg)
      ? 404
      : /GRANDE|SNAPSHOT_GRANDE/i.test(msg)
        ? 413
        : /INVÁLIDO|JÁ_EXISTE|diretório|DESTINO|BUSCA/i.test(msg)
          ? 400
          : 500
  return Response.json({ error: msg }, { status })
}
