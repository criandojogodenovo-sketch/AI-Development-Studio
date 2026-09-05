'use client'

// ============================================================
// STUDIO / UI HELPERS — badges de status, cores, formatação
// Ícones LUCIDE (nunca emojis — regra FASE 2)
// ============================================================

import {
  Zap, CircleCheck, CircleAlert, CircleX, Play, CircleCheckBig, Ban,
  Wrench, CircleSlash, FlaskConical, CircleDot, CircleDotDashed, Search,
  ThumbsUp, FilePlus, ClipboardList, RotateCw, Loader, Rocket, Flag,
  FolderTree, LifeBuoy, OctagonAlert, Save, GitBranch, ArrowUp, GitPullRequest,
  Gamepad2, Globe, MonitorSmartphone, AppWindow, Plug, Package,
  Brain, Code, SearchCheck, Github, Bot,
} from 'lucide-react'

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EVENT_ICONS: Record<string, any> = {
  'agent.started': Zap, 'agent.completed': CircleCheck, 'agent.failed': CircleAlert,
  'poskli.state': Loader,
  'task.started': Play, 'task.completed': CircleCheckBig, 'task.failed': CircleX,
  'tool.called': Wrench, 'tool.completed': Wrench, 'tool.denied': CircleSlash,
  'test.started': FlaskConical, 'test.passed': CircleDot, 'test.failed': CircleDotDashed,
  'review.started': Search, 'review.approved': ThumbsUp, 'review.changes_requested': ClipboardList, 'review.failed': Search,
  'pipeline.started': Rocket, 'pipeline.completed': Flag, 'pipeline.failed': OctagonAlert,
  'project.created': FolderTree, 'fix.created': RotateCw, 'repeated_failure.detected': LifeBuoy,
  'limits.reached': Ban, 'github.commit.created': Save, 'github.branch.created': GitBranch,
  'github.push.completed': ArrowUp, 'github.push.failed': CircleX, 'github.pr.created': GitPullRequest,
}

/** Ícone Lucide do evento (componente JSX). */
export function EventIcon({ type, className }: { type: string; className?: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Icon = (EVENT_ICONS as Record<string, any>)[type] ?? CircleDot
  return <Icon className={className ?? 'w-3.5 h-3.5'} />
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TEMPLATE_ICONS: Record<string, any> = {
  MINI_GAME: Gamepad2, GAME_2D: Gamepad2, LANDING_PAGE: Globe, WEB_APP: AppWindow,
  PWA: MonitorSmartphone, API: Plug, EMPTY_PROJECT: Package,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AGENT_ICONS: Record<string, any> = {
  master: Brain, coding: Code, review: SearchCheck, testing: FlaskConical, github: Github, user: Bot,
}

/** Renderiza o ícone Lucide de um agente. */
export function AgentIcon({ id, className }: { id?: string; className?: string }) {
  const Icon = AGENT_ICONS[id ?? ''] ?? Bot
  return <Icon className={className ?? 'w-4 h-4'} />
}

// ---------- LINGUAGEM DE PRODUTO (não expõe nomes técnicos) ----------

export const AGENT_LABELS: Record<string, string> = {
  master: 'Planejador',
  coding: 'Engenheiro de Implementação',
  testing: 'Verificador de Testes',
  review: 'Revisor de Qualidade',
  github: 'Agente de Publicação',
}

export function agentLabel(id?: string): string {
  return AGENT_LABELS[id ?? ''] ?? 'Agente'
}

export const STATUS_LABELS: Record<string, string> = {
  CREATED: 'Criado',
  PLANNING: 'Planejando',
  RUNNING: 'Em execução',
  REVIEW: 'Em revisão',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
  PARTIAL: 'Parcial',
  PENDING: 'Aguardando',
  BLOCKED: 'Bloqueada',
  CANCELLED: 'Cancelada',
  STARTED: 'Iniciada',
  REPEATED_FAILURE: 'Falha repetida',
  MAX_LIMITS_REACHED: 'Limite atingido',
  TIMEOUT: 'Tempo esgotado',
  OK: 'OK',
  ERROR: 'Erro',
  DENIED: 'Negado',
}

export function statusLabel(s?: string): string {
  return STATUS_LABELS[s ?? ''] ?? (s ?? '—')
}

export const RUN_TYPE_LABELS: Record<string, string> = {
  PLAN: 'Planejamento',
  EXECUTE: 'Execução',
  IMPLEMENT: 'Implementação',
  REVIEW: 'Revisão',
  TEST: 'Testes',
  FIX: 'Correção',
}

export function runTypeLabel(t?: string): string {
  return RUN_TYPE_LABELS[t ?? ''] ?? (t ?? '')
}

/** Papel de produto a partir de um identificador técnico de modelo (histórico de uso). */
export function modelRoleLabel(modelId?: string): string {
  const id = String(modelId ?? '')
  if (id.startsWith('glm')) return 'Planejador'
  if (id.startsWith('qwen')) return 'Engenheiro de Implementação'
  if (id.startsWith('hy3')) return 'Revisor de Qualidade'
  if (id.startsWith('deepseek')) return 'Reserva técnica'
  return 'Motor de IA'
}
