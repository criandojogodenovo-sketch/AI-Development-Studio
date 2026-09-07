'use client'

// ============================================================
// CHAT BUBBLES — mensagens estilizadas do chat conversacional
// ============================================================
// O utilizador escreve; o agente responde como mensagens de
// sistema estilizadas (bolhas de progresso) — nunca terminal,
// nunca código cru, nunca nomes de modelos.
// ============================================================

import { Brain, Ban, Activity, Send, BadgeCheck, CircleAlert, ShieldQuestion, Square, XCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '../markdown'
import { formatDuration } from '../ui-helpers'
import { ActivityLog } from './activity-log'
import { QUOTA_EXHAUSTED_MESSAGE, type ChatActivityEvent } from '@/lib/poskli-chat'
import type { ClarifyQuestion } from '@/lib/studio/projects/intent-router'

function AgentAvatar({ tone = 'default' }: { tone?: 'default' | 'amber' }) {
  return (
    <span
      className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border ${
        tone === 'amber'
          ? 'bg-amber-500/15 border-amber-800/60'
          : 'bg-zinc-800/80 border-zinc-700'
      }`}
    >
      <Brain className={tone === 'amber' ? 'w-3.5 h-3.5 text-amber-400' : 'w-3.5 h-3.5 text-emerald-400'} />
    </span>
  )
}

/** Mensagem do utilizador — bolha à direita. */
export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-emerald-600/15 border border-emerald-800/40 px-3.5 py-2 text-[13px] text-zinc-100 whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  )
}

/** Resposta final do agente — markdown renderizado. */
export function AgentBubble({ markdown }: { markdown: string }) {
  return (
    <div className="flex gap-2.5">
      <AgentAvatar />
      <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-zinc-900/70 border border-zinc-800/60 px-3.5 py-2.5">
        <Markdown content={markdown} compact />
      </div>
    </div>
  )
}

/** "A pensar durante Xs…" — indicador de raciocínio. `note`
 *  opcional: aviso honesto quando o modelo demora (>30s sem
 *  ação) — o utilizador nunca fica sem explicação. */
export function ThinkingBubble({ seconds, note }: { seconds: number; note?: string }) {
  return (
    <div className="flex gap-2.5">
      <AgentAvatar />
      <div className="rounded-2xl rounded-bl-md bg-zinc-900/40 border border-zinc-800/40 px-3.5 py-2 text-[12px] text-zinc-400 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="flex gap-1" aria-hidden>
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse [animation-delay:0.2s]" />
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse [animation-delay:0.4s]" />
          </span>
          A pensar durante {seconds}s…
        </div>
        {note && <span className="text-[11px] text-amber-300/80">{note}</span>}
      </div>
    </div>
  )
}

/** Estado atual do agente (ex.: "A escrever código…") — usado
 *  enquanto ainda não há ações de ferramenta para mostrar. */
export function StatusBubble({ label }: { label: string }) {
  return (
    <div className="flex gap-2.5">
      <AgentAvatar />
      <div className="rounded-2xl rounded-bl-md bg-zinc-900/40 border border-zinc-800/40 px-3.5 py-2 text-[12px] text-zinc-400 flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin" aria-hidden />
        {label}
      </div>
    </div>
  )
}

/** Bolha de progresso — log de atividade do agente em curso. */
export function ActivityCard({ entries, running }: { entries: ChatActivityEvent[]; running: boolean }) {
  return (
    <div className="flex gap-2.5">
      <AgentAvatar />
      <div className="flex-1 min-w-0 max-w-[85%] rounded-2xl rounded-bl-md bg-zinc-900/40 border border-zinc-800/40 px-3 py-2 space-y-1">
        <p className="text-[9px] uppercase tracking-wider text-zinc-600 flex items-center gap-1">
          <Activity className="w-3 h-3" />
          Atividade {running ? 'em andamento' : 'desta mensagem'}
        </p>
        <ActivityLog entries={entries} />
      </div>
    </div>
  )
}

/** Cota esgotada (429) — mensagem honesta, sem loops. */
export function QuotaBubble() {
  return (
    <div className="flex gap-2.5">
      <AgentAvatar tone="amber" />
      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-amber-800/50 bg-amber-950/20 px-3.5 py-2.5 text-[12.5px] text-amber-200 flex items-start gap-2">
        <Ban className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <span className="break-words">{QUOTA_EXHAUSTED_MESSAGE}</span>
      </div>
    </div>
  )
}

/** Fim de turno — selo terminal discreto. */
export function TerminalBadge({ state, label, durationMs }: { state: string; label: string; durationMs?: number }) {
  const ok = state === 'COMPLETED'
  const partial = state === 'PARTIAL'
  const cancelled = state === 'CANCELLED'
  const Icon = ok ? BadgeCheck : partial ? CircleAlert : cancelled ? Square : state === 'BLOCKED' ? ShieldQuestion : XCircle
  return (
    <div className="flex items-center gap-2 text-[11px] text-zinc-500 pl-9.5">
      <Icon
        className={`w-3.5 h-3.5 shrink-0 ${
          ok ? 'text-emerald-500' : partial ? 'text-amber-500' : cancelled ? 'text-zinc-500' : 'text-red-400/80'
        }`}
      />
      <span className="font-medium">{label}</span>
      {durationMs !== undefined && durationMs > 0 && (
        <span className="text-zinc-600">· {formatDuration(durationMs)}</span>
      )}
    </div>
  )
}

/** Pergunta de clarificação INLINE (criação automática de projeto):
 *  o contexto era ambíguo ("Cria uma app") e o agente pergunta
 *  antes de criar — opções clicáveis + resposta livre. */
export function ClarifyCard({
  question,
  onAnswer,
  onDismiss,
  busy,
}: {
  question: ClarifyQuestion
  onAnswer: (answer: string) => void
  onDismiss: () => void
  busy?: boolean
}) {
  return (
    <div className="flex gap-2.5">
      <AgentAvatar tone="amber" />
      <div className="max-w-[85%] flex-1 rounded-2xl rounded-bl-md border border-amber-900/40 bg-zinc-900/60 px-3.5 py-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {question.header && (
              <p className="text-[9px] uppercase tracking-wider text-amber-500/80 mb-0.5">{question.header}</p>
            )}
            <p className="text-[13px] text-zinc-200 font-medium break-words">{question.question}</p>
          </div>
          <button
            onClick={onDismiss}
            className="p-1 rounded text-zinc-600 hover:text-zinc-300 shrink-0"
            title="dispensar"
            aria-label="dispensar pergunta"
          >
            <XCircle className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="grid gap-1.5">
          {question.options.map((opt) => (
            <button
              key={opt.label}
              onClick={() => onAnswer(opt.label)}
              disabled={busy}
              className="text-left px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900/60 text-[12px] text-zinc-300 hover:border-amber-700/60 hover:text-amber-200 transition-colors disabled:opacity-50"
            >
              <span className="font-medium">{opt.label}</span>
              {opt.description && <span className="block text-[10px] text-zinc-500 mt-0.5">{opt.description}</span>}
            </button>
          ))}
        </div>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            const form = e.currentTarget
            const input = form.elements.namedItem('answer') as HTMLInputElement | null
            const v = (input?.value ?? '').trim()
            if (v) {
              onAnswer(v)
              if (input) input.value = ''
            }
          }}
        >
          <input
            name="answer"
            placeholder="ou escreva outra resposta…"
            maxLength={120}
            disabled={busy}
            className="flex-1 bg-zinc-900/60 border border-zinc-800 rounded-lg px-3 py-2 text-[11.5px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-800/60"
          />
          <Button size="sm" disabled={busy} className="bg-amber-600 hover:bg-amber-500 h-8 shrink-0">
            <Send className="w-3.5 h-3.5" />
          </Button>
        </form>
      </div>
    </div>
  )
}
