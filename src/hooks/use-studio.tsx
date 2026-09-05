'use client'

// ============================================================
// STUDIO CONTEXT — estado global (auth, projetos, eventos WS)
// ============================================================

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

export interface SessionUser { id: string; email: string; name: string; role: string }
export interface ProjectSummary {
  id: string; name: string; description: string; type: string; status: string
  approvalMode: string; createdAt: string; updatedAt: string
  tasksTotal: number; tasksCompleted: number; percent: number
}
export interface TemplateSummary { type: string; label: string; description: string; testCommand: string }
export interface StudioEvent {
  id?: string; projectId?: string; taskId?: string; type: string; agent?: string
  tool?: string; status?: string; message: string; createdAt?: string; durationMs?: number
}

interface StudioState {
  user: SessionUser | null
  authChecked: boolean
  token: string | null
  login: (email: string, password: string) => Promise<void>
  register: (email: string, name: string, password: string) => Promise<void>
  logout: () => void
  api: <T>(path: string, init?: RequestInit) => Promise<T>
  projects: ProjectSummary[]
  templates: TemplateSummary[]
  refreshProjects: () => Promise<void>
  activeProjectId: string | null
  setActiveProject: (id: string | null) => void
  events: StudioEvent[]
  liveEvents: StudioEvent[]
  clearLiveEvents: () => void
  wsConnected: boolean
}

const Ctx = createContext<StudioState | null>(null)

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [events, setEvents] = useState<StudioEvent[]>([])
  const [liveEvents, setLiveEvents] = useState<StudioEvent[]>([])
  const [wsConnected, setWsConnected] = useState(false)
  const socketRef = useRef<Socket | null>(null)

  // ---- inicialização: token do localStorage ----
  // setState ocorre em callback de timer (padrão assíncrono permitido)
  useEffect(() => {
    const t = typeof window !== 'undefined' ? localStorage.getItem('studio_token') : null
    const timer = setTimeout(() => {
      if (!t) {
        setAuthChecked(true)
        return
      }
      fetch('/api/auth/me', { headers: { authorization: `Bearer ${t}` } })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => {
          setToken(t)
          setUser(d.user)
        })
        .catch(() => {
          localStorage.removeItem('studio_token')
        })
        .finally(() => setAuthChecked(true))
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  // ---- API autenticada ----
  const api = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string>) }
      if (token) headers.authorization = `Bearer ${token}`
      const res = await fetch(path, { ...init, headers })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status })
      return data as T
    },
    [token]
  )

  const refreshProjects = useCallback(async () => {
    if (!token) return
    try {
      const d = await api<{ projects: ProjectSummary[]; templates: TemplateSummary[] }>('/api/projects')
      setProjects(d.projects)
      setTemplates(d.templates)
    } catch {
      /* sessão expirada etc */
    }
  }, [api, token])

  useEffect(() => {
    if (!user) return
    const timer = setTimeout(() => {
      refreshProjects()
      api<{ events: StudioEvent[] }>('/api/activity?take=60')
        .then((d) => setEvents(d.events))
        .catch(() => {})
    }, 0)
    return () => clearTimeout(timer)
  }, [user, refreshProjects, api])

  // ---- WebSocket: eventos em tempo real ----
  useEffect(() => {
    if (!user) return
    const socket = io('/?XTransformPort=3003', { transports: ['websocket', 'polling'] })
    socketRef.current = socket
    socket.on('connect', () => setWsConnected(true))
    socket.on('disconnect', () => setWsConnected(false))
    socket.on('studio:event', (event: StudioEvent) => {
      setLiveEvents((prev) => [event, ...prev].slice(0, 200))
      // refresh de projetos quando pipeline muda estado
      if (event.type?.startsWith('pipeline.') || event.type === 'task.completed' || event.type === 'project.created') {
        refreshProjects()
      }
    })
    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [user, refreshProjects])

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'falha no login')
    localStorage.setItem('studio_token', data.token)
    setToken(data.token)
    setUser(data.user)
  }, [])

  const register = useCallback(async (email: string, name: string, password: string) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, name, password }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'falha no registro')
    localStorage.setItem('studio_token', data.token)
    setToken(data.token)
    setUser(data.user)
  }, [])

  const logout = useCallback(() => {
    if (token) {
      fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {})
    }
    localStorage.removeItem('studio_token')
    setToken(null)
    setUser(null)
    setProjects([])
    setEvents([])
    setLiveEvents([])
    setActiveProjectId(null)
  }, [token])

  const value: StudioState = {
    user, authChecked, token, login, register, logout, api,
    projects, templates, refreshProjects,
    activeProjectId, setActiveProject: setActiveProjectId,
    events, liveEvents, clearLiveEvents: () => setLiveEvents([]),
    wsConnected,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStudio(): StudioState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useStudio fora do provider')
  return ctx
}
