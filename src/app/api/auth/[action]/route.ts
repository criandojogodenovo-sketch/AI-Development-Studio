import { NextResponse } from 'next/server'
import { registerUser, loginUser, getSessionUser, destroySession, pruneSessions } from '@/lib/studio/security/auth'
import { rateLimitApi, clientIp } from '@/lib/studio/security/rate-limit'
import { STUDIO_CONFIG } from '@/lib/studio/config'

export const dynamic = 'force-dynamic'

/** Define cookie HttpOnly de sessão (usado por iframes de preview). */
function withSessionCookie(res: NextResponse, token: string): NextResponse {
  res.cookies.set('studio_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: STUDIO_CONFIG.security.sessionTtlHours * 3600,
  })
  return res
}

const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params
  const ip = clientIp(req)
  const rl = rateLimitApi(ip + ':' + action)
  if (!rl.allowed) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 })

  if (action === 'register') {
    const { email, name, password } = await req.json().catch(() => ({}))
    if (!validEmail(String(email ?? ''))) return NextResponse.json({ error: 'EMAIL_INVÁLIDO' }, { status: 400 })
    if (!name || String(name).trim().length < 2) return NextResponse.json({ error: 'NOME_CURTO' }, { status: 400 })
    if (!password || String(password).length < 8) return NextResponse.json({ error: 'SENHA_CURTA (mín 8 caracteres)' }, { status: 400 })
    try {
      const { token, user } = await registerUser(String(email).toLowerCase(), String(name).trim(), String(password))
      return withSessionCookie(
        NextResponse.json({ token, user: { id: user.id, email: user.email, name: user.name } }),
        token
      )
    } catch (e) {
      if ((e as Error).message === 'EMAIL_ALREADY_REGISTERED') {
        return NextResponse.json({ error: 'EMAIL_JÁ_REGISTRADO' }, { status: 409 })
      }
      return NextResponse.json({ error: (e as Error).message }, { status: 500 })
    }
  }

  if (action === 'login') {
    const { email, password } = await req.json().catch(() => ({}))
    try {
      const { token, user } = await loginUser(String(email ?? '').toLowerCase(), String(password ?? ''))
      return withSessionCookie(
        NextResponse.json({ token, user: { id: user.id, email: user.email, name: user.name } }),
        token
      )
    } catch {
      return NextResponse.json({ error: 'CREDENCIAIS_INVÁLIDAS' }, { status: 401 })
    }
  }

  if (action === 'logout') {
    const auth = req.headers.get('authorization')
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
    if (token) await destroySession(token)
    const res = NextResponse.json({ ok: true })
    res.cookies.delete('studio_session')
    return res
  }

  return NextResponse.json({ error: 'AÇÃO_DESCONHECIDA' }, { status: 404 })
}

export async function GET(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params
  if (action === 'me') {
    const user = await getSessionUser(req)
    if (!user) return NextResponse.json({ error: 'NÃO_AUTENTICADO' }, { status: 401 })
    return NextResponse.json({ user })
  }
  return NextResponse.json({ error: 'AÇÃO_DESCONHECIDA' }, { status: 404 })
}
