'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useStudio } from '@/hooks/use-studio'
import { statusColor, statusLabel, timeAgo, TEMPLATE_ICONS } from './ui-helpers'
import { projectNameFromMessage, type ClarifyQuestion } from '@/lib/studio/projects/intent-router'
import { Package, MessageCircleQuestion } from 'lucide-react'
import { Loader2, Plus, Trash2, Play, FolderOpen, ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'

export function ProjectsView({ onOpenProject, presetRequest }: {
  onOpenProject: (id: string) => void
  presetRequest?: string | null
}) {
  const { projects, templates, api, refreshProjects } = useStudio()
  const [open, setOpen] = useState(Boolean(presetRequest))
  const [name, setName] = useState('')
  const [description, setDescription] = useState(presetRequest ?? '')
  const [approvalMode, setApprovalMode] = useState('ASSISTED')
  const [busy, setBusy] = useState(false)
  // clarificação: o contexto era ambíguo e o agente PERGUNTOU
  const [clarifying, setClarifying] = useState<ClarifyQuestion | null>(null)
  const [resolvedType, setResolvedType] = useState<string | null>(null)

  const create = async (answer?: string) => {
    const pedido = description || presetRequest || ''
    setBusy(true)
    try {
      const d = await api<
        { project: { id: string; type: string } } |
        { needsClarification: true; question: ClarifyQuestion }
      >('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: name || projectNameFromMessage(pedido) || 'Novo Projeto',
          description: pedido,
          approvalMode,
          ...(resolvedType || answer ? { resolvedType: resolvedType ?? answer } : {}),
        }),
      })
      if ('needsClarification' in d) {
        // SEM seletor de tipo na UI: o agente pergunta no diálogo
        setClarifying(d.question)
        return
      }
      await refreshProjects()
      const typeLabel = templates.find((t) => t.type === d.project.type)?.label ?? d.project.type
      toast.success(`Projeto criado — tipo detetado automaticamente: ${typeLabel}`)
      setOpen(false)
      setClarifying(null)
      setResolvedType(null)
      setName('')
      setDescription('')
      onOpenProject(d.project.id)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Excluir projeto e workspace? Esta ação é irreversível.')) return
    try {
      await api(`/api/projects/${id}?confirm=true`, { method: 'DELETE' })
      await refreshProjects()
      toast.success('Projeto removido')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Projetos</h2>
        <Button onClick={() => setOpen(true)} className="bg-emerald-600 hover:bg-emerald-500" size="sm">
          <Plus className="w-4 h-4 mr-1" /> Novo
        </Button>
      </div>

      {projects.length === 0 && (
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="p-8 text-center space-y-2">
            <FolderOpen className="w-10 h-10 mx-auto text-zinc-700" />
            <p className="text-zinc-400">Nenhum projeto ainda.</p>
            <p className="text-sm text-zinc-600">
              Descreva o que quer construir — o agente cria tudo automaticamente, sem escolher templates.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid md:grid-cols-2 gap-3">
        {projects.map((p) => (
          <Card key={p.id} className="border-zinc-800 bg-zinc-900/60 hover:border-emerald-800/50 transition-colors">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <button onClick={() => onOpenProject(p.id)} className="text-left min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {(() => { const TIcon = TEMPLATE_ICONS[p.type] ?? Package; return <TIcon className="w-5 h-5 text-emerald-400" /> })()}
                    <span className="font-semibold truncate">{p.name}</span>
                  </div>
                  <p className="text-xs text-zinc-500 truncate mt-0.5">{p.description || p.type}</p>
                </button>
                <Badge variant="outline" className={statusColor(p.status)}>{statusLabel(p.status)}</Badge>
              </div>
              <Progress value={p.percent} className="h-1.5" />
              <div className="flex items-center justify-between text-[11px] text-zinc-600">
                <span>{p.tasksCompleted}/{p.tasksTotal} tarefas · {p.approvalMode}</span>
                <span>{timeAgo(p.updatedAt)}</span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="flex-1 border-zinc-700" onClick={() => onOpenProject(p.id)}>
                  <Play className="w-3 h-3 mr-1" /> Abrir
                </Button>
                <Button size="sm" variant="ghost" className="text-red-400 hover:bg-red-950/40" onClick={() => remove(p.id)}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setClarifying(null); setResolvedType(null) } }}>
        <DialogContent className="bg-zinc-900 border-zinc-800 max-w-md">
          {clarifying ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <MessageCircleQuestion className="w-4 h-4 text-amber-400" />
                  O agente precisa de um detalhe
                </DialogTitle>
                <DialogDescription>{clarifying.question}</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                {clarifying.options.map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => { setResolvedType(opt.label); void create(opt.label) }}
                    disabled={busy}
                    className="w-full text-left px-3 py-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 text-[12.5px] text-zinc-300 hover:border-amber-700/60 hover:text-amber-200 transition-colors disabled:opacity-50"
                  >
                    <span className="font-medium">{opt.label}</span>
                    {opt.description && <span className="block text-[10.5px] text-zinc-500 mt-0.5">{opt.description}</span>}
                  </button>
                ))}
              </div>
              <DialogFooter>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setClarifying(null); setResolvedType(null) }}
                  className="text-zinc-400"
                >
                  <ArrowLeft className="w-3.5 h-3.5 mr-1" /> voltar
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Novo projeto</DialogTitle>
                <DialogDescription>
                  Descreva o que quer construir — o agente escolhe o template automaticamente
                  (jogo, landing page, API…) a partir do contexto.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>Nome (opcional)</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Deixe vazio — derivo do pedido" />
                </div>
                {presetRequest && (
                  <div className="rounded-md border border-emerald-800/40 bg-emerald-950/20 p-2 text-xs text-emerald-300">
                    Pedido inicial: &quot;{presetRequest}&quot;
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>O que você quer construir?</Label>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    placeholder="ex: um jogo de naves para celular, uma landing page para a minha loja…"
                  />
                  <p className="text-[11px] text-zinc-600">
                    Contexto ambíguo? O agente pergunta antes de criar — sem seletores manuais.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>Modo de aprovação</Label>
                  <Select value={approvalMode} onValueChange={setApprovalMode}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-zinc-900 border-zinc-800">
                      <SelectItem value="MANUAL">MANUAL — aprovar cada ação crítica</SelectItem>
                      <SelectItem value="ASSISTED">ASSISTED — IA trabalha, aprova críticas</SelectItem>
                      <SelectItem value="AUTONOMOUS">AUTONOMOUS — IA trabalha dentro dos limites</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => { void create() }}
                  disabled={busy || (description.trim().length < 5 && !presetRequest)}
                  className="bg-emerald-600 hover:bg-emerald-500 w-full"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Criar projeto'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
