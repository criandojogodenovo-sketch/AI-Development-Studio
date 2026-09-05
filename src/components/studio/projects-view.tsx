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
import { statusColor, timeAgo, TEMPLATE_ICONS } from './ui-helpers'
import { Loader2, Plus, Trash2, Play, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'

export function ProjectsView({ onOpenProject, presetRequest }: {
  onOpenProject: (id: string) => void
  presetRequest?: string | null
}) {
  const { projects, templates, api, refreshProjects } = useStudio()
  const [open, setOpen] = useState(Boolean(presetRequest))
  const [name, setName] = useState('')
  const [type, setType] = useState('MINI_GAME')
  const [description, setDescription] = useState('')
  const [approvalMode, setApprovalMode] = useState('ASSISTED')
  const [busy, setBusy] = useState(false)

  const suggestType = (req: string) => {
    if (/game|jogo|sobreviv|plataforma/i.test(req)) return 'MINI_GAME'
    if (/landing|página|site/i.test(req)) return 'LANDING_PAGE'
    if (/api|backend/i.test(req)) return 'API'
    return 'WEB_APP'
  }

  const create = async () => {
    setBusy(true)
    try {
      const d = await api<{ project: { id: string } }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: name || 'Novo Projeto', type, description: description || presetRequest || '', approvalMode }),
      })
      await refreshProjects()
      toast.success('Projeto criado com template real')
      setOpen(false)
      setName(''); setDescription('')
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
            <p className="text-sm text-zinc-600">Crie um projeto — templates reais (jogo, landing, API) já vêm com código funcional e testes.</p>
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
                    <span className="text-lg">{TEMPLATE_ICONS[p.type] ?? '📦'}</span>
                    <span className="font-semibold truncate">{p.name}</span>
                  </div>
                  <p className="text-xs text-zinc-500 truncate mt-0.5">{p.description || p.type}</p>
                </button>
                <Badge variant="outline" className={statusColor(p.status)}>{p.status}</Badge>
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-zinc-900 border-zinc-800 max-w-md">
          <DialogHeader>
            <DialogTitle>Novo projeto</DialogTitle>
            <DialogDescription>
              Template gera código real e testes executáveis no workspace isolado.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Nome</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Meu Mini Game" />
            </div>
            {presetRequest && (
              <div className="rounded-md border border-emerald-800/40 bg-emerald-950/20 p-2 text-xs text-emerald-300">
                Pedido inicial: &quot;{presetRequest}&quot; (enviado ao Master Agent ao iniciar)
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent className="bg-zinc-900 border-zinc-800">
                  {templates.map((t) => (
                    <SelectItem key={t.type} value={t.type}>
                      {TEMPLATE_ICONS[t.type]} {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-zinc-600">{templates.find((t) => t.type === type)?.description}</p>
            </div>
            <div className="space-y-1.5">
              <Label>Descrição (opcional)</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="O que é este projeto" />
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
            <Button onClick={create} disabled={busy} className="bg-emerald-600 hover:bg-emerald-500 w-full">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Criar projeto'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
