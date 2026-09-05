'use client'

// ============================================================
// STUDIO / UI HELPERS — badges de status, cores, formatação
// ============================================================

export const STATUS_COLORS: Record<string, string> = {
  CREATED: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  PLANNING: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  RUNNING: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  REVIEW: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
  COMPLETED: 'bg-emerald-600/15 text-emerald-400 border-emerald-600/30',
  FAILED: 'bg-red-500/15 text-red-400 border-red-500/30',
  PARTIAL: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  PENDING: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  BLOCKED: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  CANCELLED: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  STARTED: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  REPEATED_FAILURE: 'bg-red-600/15 text-red-400 border-red-600/30',
  MAX_LIMITS_REACHED: 'bg-red-500/15 text-red-300 border-red-500/30',
  TIMEOUT: 'bg-orange-600/15 text-orange-400 border-orange-600/30',
  OK: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  ERROR: 'bg-red-500/15 text-red-400 border-red-500/30',
  DENIED: 'bg-red-700/15 text-red-300 border-red-700/30',
  APPROVE: 'bg-emerald-600/15 text-emerald-400 border-emerald-600/30',
  CHANGES_REQUESTED: 'bg-amber-600/15 text-amber-400 border-amber-600/30',
}

export function statusColor(s?: string): string {
  return STATUS_COLORS[s ?? ''] ?? 'bg-slate-500/15 text-slate-400 border-slate-500/30'
}

export const EVENT_ICONS: Record<string, string> = {
  'agent.started': '⚡', 'agent.completed': '✅', 'agent.failed': '💥',
  'task.started': '▶', 'task.completed': '✔', 'task.failed': '✖',
  'tool.called': '🔧', 'tool.completed': '🔧', 'tool.denied': '⛔',
  'test.started': '🧪', 'test.passed': '🟢', 'test.failed': '🔴',
  'review.started': '🔍', 'review.approved': '👍', 'review.changes_requested': '📝', 'review.failed': '🔍',
  'pipeline.started': '🚀', 'pipeline.completed': '🏁', 'pipeline.failed': '💀',
  'project.created': '📁', 'fix.created': '🔁', 'repeated_failure.detected': '🌀',
  'limits.reached': '🛑', 'github.commit.created': '💾', 'github.branch.created': '🌿',
  'github.push.completed': '⬆', 'github.pr.created': '🔀',
}

export function eventIcon(type: string): string {
  return EVENT_ICONS[type] ?? '•'
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

export function timeAgo(iso?: string): string {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s atrás`
  if (s < 3600) return `${Math.floor(s / 60)}min atrás`
  if (s < 86400) return `${Math.floor(s / 3600)}h atrás`
  return `${Math.floor(s / 86400)}d atrás`
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

export const TEMPLATE_ICONS: Record<string, string> = {
  MINI_GAME: '🎮', GAME_2D: '🕹️', LANDING_PAGE: '🌐', WEB_APP: '💻',
  PWA: '📱', API: '🔌', EMPTY_PROJECT: '📦',
}

export const AGENT_ICONS: Record<string, string> = {
  master: '🧠', coding: '👨‍💻', review: '🔍', testing: '🧪', github: '🐙',
}
