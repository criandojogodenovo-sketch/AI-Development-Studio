'use client'

// ============================================================
// GIT VIEW — Git real (isomorphic-git) + GitHub integrado
// status · diff · log · branches · commit · checkout ·
// connect repo · push · pull · clone — token NUNCA na UI
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { useStudio } from '@/hooks/use-studio'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { statusColor, statusLabel, timeAgo } from './ui-helpers'
import {
  GitBranch, GitCommitVertical, RefreshCw, Upload, Download, Plus, Link2, Unlink2,
  FilePlus, FilePen, FileMinus, ChevronDown, ChevronRight, Loader2, GitPullRequest,
} from 'lucide-react'
import { toast } from 'sonner'

interface GitStatusInfo {
  initialized: boolean
  branch: string | null
  changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>
  commits: Array<{ oid: string; message: string; author: string; timestamp: number }>
  branches: string[]
  repo: { connected: boolean; fullName: string | null }
}

const STATUS_CHANGE_ICON = {
  added: FilePlus,
  modified: FilePen,
  deleted: FileMinus,
}

export function GitView(): React.ReactElement {
  const { api, projects, activeProjectId } = useStudio()
  const [status, setStatus] = useState<GitStatusInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [repoInput, setRepoInput] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [diff, setDiff] = useState<string | null>(null)
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const projectId = activeProjectId ?? projects[0]?.id ?? null

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const d = await api<{ status: GitStatusInfo }>(`/api/git?project=${projectId}`)
      setStatus(d.status)
      if (d.status.repo.connected && !repoInput) setRepoInput(d.status.repo.fullName ?? '')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [api, projectId, repoInput])

  useEffect(() => { load() }, [load])

  const action = async (name: string, body: Record<string, unknown>) => {
    if (!projectId) return
    setBusy(name)
    try {
      const d = await api<Record<string, unknown>>('/api/git', {
        method: 'POST',
        body: JSON.stringify({ project: projectId, ...body }),
      })
      toast.success(`${name}: ${JSON.stringify(d).slice(0, 120)}`)
      await load()
      return d
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const loadDiff = async (path?: string) => {
    if (!projectId) return
    setDiffPath(path ?? null)
    try {
      const d = await api<{ diff: string }>(`/api/git?project=${projectId}&diff=${encodeURIComponent(path ?? '')}`)
      setDiff(d.diff)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!projectId) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-bold flex items-center gap-2"><GitBranch className="w-5 h-5 text-emerald-400" /> Git</h1>
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardContent className="p-8 text-center text-sm text-zinc-500">Selecione um projeto primeiro.</CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-bold flex items-center gap-2">
          <GitBranch className="w-5 h-5 text-emerald-400" />
          Git
        </h1>
        {status?.branch && <Badge variant="outline" className="bg-emerald-600/15 text-emerald-400 border-emerald-600/30">{status.branch}</Badge>}
        {status?.repo.connected && (
          <span className="text-xs text-zinc-500 font-mono truncate">{status.repo.fullName}</span>
        )}
        <Button variant="ghost" size="icon" onClick={load} className="ml-auto">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* repositório GitHub */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-xs text-zinc-400 flex items-center gap-1.5"><Link2 className="w-3.5 h-3.5" /> Repositório GitHub</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              placeholder="owner/name (ex: usuario/meu-projeto)"
              className="font-mono text-xs bg-zinc-950 border-zinc-800"
            />
            <Button size="sm" onClick={() => action('connect', { action: 'connect', repo: repoInput })} disabled={busy === 'connect' || !repoInput.trim()}>
              {busy === 'connect' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />} Conectar
            </Button>
          </div>
          <p className="text-[10px] text-zinc-600">
            O token de acesso fica somente no backend (nunca aparece aqui). Push e pull usam a branch ativa.
          </p>
          {status?.repo.connected && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={() => action('push', { action: 'push' })} disabled={busy === 'push'} className="border-emerald-900/60 text-emerald-400 hover:bg-emerald-950/40">
                {busy === 'push' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Push
              </Button>
              <Button size="sm" variant="outline" onClick={() => action('pull', { action: 'pull' })} disabled={busy === 'pull'}>
                {busy === 'pull' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Pull
              </Button>
              <Button size="sm" variant="ghost" onClick={() => action('disconnect', { action: 'disconnect' })} className="text-zinc-500 hover:text-red-400">
                <Unlink2 className="w-3.5 h-3.5" /> Desconectar
              </Button>
            </div>
          )}
          {!status?.initialized && (
            <Button size="sm" variant="outline" onClick={() => action('init', { action: 'init' })} disabled={busy === 'init'}>
              <GitCommitVertical className="w-3.5 h-3.5" /> Inicializar repositório local
            </Button>
          )}
        </CardContent>
      </Card>

      {/* mudanças + commit */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3">
          <CardTitle className="text-xs text-zinc-400 flex items-center gap-1.5">
            <FilePen className="w-3.5 h-3.5" />
            Mudanças {status?.changes.length ? `(${status.changes.length})` : ''}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {status?.changes.length === 0 && (
            <p className="text-xs text-zinc-500">{status?.initialized ? 'Working tree limpo — nada a commitar.' : 'Repositório não inicializado.'}</p>
          )}
          <div className="max-h-56 overflow-y-auto text-[11px] font-mono">
            {status?.changes.map((c) => {
              const Icon = STATUS_CHANGE_ICON[c.status]
              const isOpen = expanded === c.path
              return (
                <div key={c.path}>
                  <button
                    onClick={() => { setExpanded(isOpen ? null : c.path); if (!isOpen) loadDiff(c.path) }}
                    className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-800/50 text-left"
                  >
                    {isOpen ? <ChevronDown className="w-3 h-3 text-zinc-600" /> : <ChevronRight className="w-3 h-3 text-zinc-600" />}
                    <Icon className={`w-3 h-3 shrink-0 ${c.status === 'added' ? 'text-emerald-400' : c.status === 'deleted' ? 'text-red-400' : 'text-amber-400'}`} />
                    <span className="truncate text-zinc-300">{c.path}</span>
                    <Badge variant="outline" className="ml-auto scale-[0.8] bg-zinc-800/60 text-zinc-400">{c.status}</Badge>
                  </button>
                  {isOpen && diff && (
                    <ScrollArea className="h-48 mx-2 mb-2 rounded bg-zinc-950 border border-zinc-900">
                      <pre className="p-2 text-[10px] font-mono whitespace-pre-wrap break-words text-zinc-400">{diff}</pre>
                    </ScrollArea>
                  )}
                </div>
              )
            })}
          </div>

          {/* commit */}
          {status?.initialized && (
            <div className="flex gap-2 pt-1">
              <Input
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                placeholder="mensagem do commit (mín 3)"
                className="text-xs bg-zinc-950 border-zinc-800"
                onKeyDown={(e) => e.key === 'Enter' && commitMsg.trim().length >= 3 && action('commit', { action: 'commit', message: commitMsg })}
              />
              <Button size="sm" onClick={() => action('commit', { action: 'commit', message: commitMsg }).then(() => setCommitMsg(''))} disabled={busy === 'commit' || commitMsg.trim().length < 3 || status.changes.length === 0}>
                {busy === 'commit' ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitCommitVertical className="w-4 h-4" />} Commit
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* branches */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-xs text-zinc-400 flex items-center gap-1.5"><GitPullRequest className="w-3.5 h-3.5" /> Branches</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {status?.branches.map((b) => (
              <button
                key={b}
                onClick={() => b !== status.branch && action('checkout', { action: 'checkout', name: b })}
                className={`px-2 py-1 rounded-md text-[11px] font-mono border ${
                  b === status.branch
                    ? 'bg-emerald-950/50 text-emerald-300 border-emerald-900/60'
                    : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:border-zinc-600'
                }`}
              >
                {b}
              </button>
            ))}
            {status?.branches.length === 0 && <p className="text-xs text-zinc-600">(sem branches)</p>}
          </div>
          <div className="flex gap-2">
            <Input
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder="nova branch (ex: feature/vidas)"
              className="text-xs font-mono bg-zinc-950 border-zinc-800"
            />
            <Button size="sm" variant="outline" onClick={() => action('branch', { action: 'branch', name: newBranch }).then(() => setNewBranch(''))} disabled={busy === 'branch' || !newBranch.trim()}>
              <Plus className="w-4 h-4" /> Criar
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* histórico */}
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-xs text-zinc-400 flex items-center gap-1.5"><GitCommitVertical className="w-3.5 h-3.5" /> Commits</CardTitle></CardHeader>
        <CardContent>
          {status?.commits.length === 0 && <p className="text-xs text-zinc-500">Nenhum commit ainda — faça o primeiro commit acima.</p>}
          <div className="space-y-1">
            {status?.commits.map((c) => (
              <div key={c.oid} className="flex items-center gap-2 text-[11px] border-b border-zinc-800/40 pb-1">
                <span className="font-mono text-emerald-400/80 shrink-0">{c.oid}</span>
                <span className="text-zinc-300 truncate flex-1">{c.message}</span>
                <span className="text-zinc-600 text-[10px] shrink-0 hidden sm:inline">{timeAgo(new Date(c.timestamp).toISOString())}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
