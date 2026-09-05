// ============================================================
// SEGURANÇA — Autenticação por sessão (server-side)
// Passwords com scrypt (crypto nativo, sem dependências).
// Tokens de sessão são opacos, armazenados hasheados no DB.
// ============================================================

import crypto from 'crypto'
import { db } from '@/lib/db'

const RETENTION = 90 // dias

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `scrypt:${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = stored.split(':')
    if (scheme !== 'scrypt' || !salt || !hash) return false
    const candidate = crypto.scryptSync(password, salt, 64).toString('hex')
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'))
  } catch {
    return false
  }
}

function newSessionToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

export interface SessionUser {
  id: string
  email: string
  name: string
  role: string
}

/** Cria usuário + primeira sessão. */
export async function registerUser(email: string, name: string, password: string) {
  const existing = await db.user.findUnique({ where: { email } })
  if (existing) throw new Error('EMAIL_ALREADY_REGISTERED')
  const user = await db.user.create({
    data: { email, name, passwordHash: hashPassword(password) },
  })
  return createSession(user.id)
}

/** Valida credenciais e cria sessão. */
export async function loginUser(email: string, password: string) {
  const user = await db.user.findUnique({ where: { email } })
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new Error('INVALID_CREDENTIALS')
  }
  return createSession(user.id)
}

/** Cria sessão e retorna token + usuário. */
export async function createSession(userId: string) {
  const token = newSessionToken()
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  await db.session.create({ data: { userId, token: tokenHash, expiresAt } })
  const user = await db.user.findUnique({ where: { id: userId } })
  return { token, user: user as SessionUser }
}

/** Valida token de sessão (do header Authorization ou cookie). */
export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  try {
    let token: string | undefined
    const authHeader = request.headers.get('authorization')
    if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7)
    if (!token) {
      const cookie = request.headers.get('cookie') ?? ''
      const m = cookie.match(/studio_session=([^;]+)/)
      if (m) token = m[1]
    }
    if (!token) return null
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const session = await db.session.findUnique({
      where: { token: tokenHash },
      include: { user: true },
    })
    if (!session || session.expiresAt < new Date()) return null
    return { id: session.user.id, email: session.user.email, name: session.user.name, role: session.user.role }
  } catch {
    return null
  }
}

/** Remove sessão (logout). */
export async function destroySession(token: string): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  await db.session.deleteMany({ where: { token: tokenHash } })
}

/** Limpa sessões expiradas (higiene periódica). */
export async function pruneSessions(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION * 24 * 60 * 60 * 1000)
  await db.session.deleteMany({ where: { expiresAt: { lt: cutoff } } })
}
