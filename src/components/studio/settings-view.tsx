'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useStudio } from '@/hooks/use-studio'
import { AGENT_ICONS, agentLabel } from './ui-helpers'
import { LogOut, Shield, KeyRound, Github, Server, Lock } from 'lucide-react'

export function SettingsView() {
  const { user, logout, api } = useStudio()
  const [github, setGithub] = useState<any>(null)
  const [agents, setAgents] = useState<any>(null)

  useEffect(() => {
    api<any>('/api/github').then(setGithub).catch(() => {})
    api<any>('/api/agents').then(setAgents).catch(() => {})
  }, [api])

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Configurações</h2>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-sm">Sessão</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-zinc-500">Usuário</span><span>{user?.name}</span></div>
          <div className="flex justify-between"><span className="text-zinc-500">E-mail</span><span className="font-mono text-xs">{user?.email}</span></div>
          <Button variant="outline" size="sm" onClick={logout} className="text-red-400 border-red-900/50 hover:bg-red-950/30">
            <LogOut className="w-4 h-4 mr-1" /> Sair
          </Button>
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-sm flex items-center gap-2"><Github className="w-4 h-4" /> Integração GitHub</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between items-center">
            <span className="text-zinc-500">Token de acesso</span>
            <Badge variant="outline" className={github?.status?.tokenConfigured ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'}>
              {github?.status?.tokenConfigured ? 'conectado' : 'não configurado'}
            </Badge>
          </div>
          <p className="text-xs text-zinc-500">{github?.setup}</p>
          <p className="text-xs text-zinc-500">Workflow: {github?.workflow?.branches}</p>
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-sm flex items-center gap-2"><Server className="w-4 h-4" /> Agentes & Ferramentas</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {(agents?.agents ?? []).map((a: any) => (
            <div key={a.id} className="flex items-center gap-2 text-xs border-b border-zinc-800/50 pb-1.5">
              <span className="shrink-0">{AGENT_ICONS[a.id] ?? '🤖'}</span>
              <span className="text-zinc-300 w-40 truncate shrink-0">{agentLabel(a.id)}</span>
              <Badge variant="outline" className={`scale-90 shrink-0 ${a.enabled ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-zinc-500/15 text-zinc-500 border-zinc-500/30'}`}>
                {a.enabled ? 'ATIVO' : 'EM BREVE'}
              </Badge>
              <span className="text-zinc-500 truncate flex-1" title={a.description}>{a.description}</span>
            </div>
          ))}
          <p className="text-[11px] text-zinc-600">{agents?.tools?.length ?? 0} ferramentas registradas com schema, validação, permissões e auditoria.</p>
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="py-3"><CardTitle className="text-sm flex items-center gap-2"><Shield className="w-4 h-4" /> Segurança</CardTitle></CardHeader>
        <CardContent className="text-xs text-zinc-500 space-y-1">
          <p className="flex items-center gap-2"><Lock className="w-3 h-3" /> Workspaces isolados por projeto e por usuário</p>
          <p className="flex items-center gap-2"><Lock className="w-3 h-3" /> Path traversal protection em toda operação de arquivo</p>
          <p className="flex items-center gap-2"><Lock className="w-3 h-3" /> Command allowlist — negação por padrão</p>
          <p className="flex items-center gap-2"><Lock className="w-3 h-3" /> Rate limiting em API e pipelines</p>
          <p className="flex items-center gap-2"><KeyRound className="w-3 h-3" /> Secrets exclusivamente server-side (nunca NEXT_PUBLIC_*)</p>
          <p className="flex items-center gap-2"><Lock className="w-3 h-3" /> Eventos sanitizados — sem tokens/logs de secrets</p>
        </CardContent>
      </Card>
    </div>
  )
}
