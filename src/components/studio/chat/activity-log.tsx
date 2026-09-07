'use client'

// ============================================================
// ACTIVITY LOG — histórico legível das ações do agente
// ============================================================
// Componente central da reconstrução conversacional: mostra o
// que o agente está a fazer AGORA ("A criar arquivo
// src/index.html…", "A executar comando npm test…", "A pesquisar
// na web…") em linguagem de produto — SEM terminal, SEM código,
// SEM nomes técnicos de modelos.
// ============================================================

import { Loader2, CheckCircle2, XCircle, MessageCircleQuestion } from 'lucide-react'
import type { ChatActivityEvent } from '@/lib/poskli-chat'

export function ActivityLog({ entries, max = 30 }: { entries: ChatActivityEvent[]; max?: number }) {
  if (entries.length === 0) return null
  const shown = entries.slice(-max)
  return (
    <div className="space-y-0.5" role="log" aria-label="Atividade do agente">
      {shown.map((a) => {
        const asked = a.tool === 'ask_user_question' && a.status === 'PENDING'
        return (
          <div key={a.id} className="flex items-center gap-2 text-[11px] leading-relaxed">
            <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center">
              {a.running && !asked ? (
                <Loader2 className="w-3 h-3 text-violet-400 animate-spin" />
              ) : a.failed ? (
                <XCircle className="w-3 h-3 text-red-400/80" />
              ) : asked ? (
                <MessageCircleQuestion className="w-3 h-3 text-amber-400" />
              ) : (
                <CheckCircle2 className="w-3 h-3 text-zinc-600" />
              )}
            </span>
            <span
              className={
                asked
                  ? 'text-amber-300'
                  : a.failed
                    ? 'text-red-300/80'
                    : a.running
                      ? 'text-zinc-200'
                      : 'text-zinc-500'
              }
            >
              {a.label}
              {a.detail ? <span className="text-zinc-500 font-mono"> {a.detail}</span> : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}
