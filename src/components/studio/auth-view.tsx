'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useStudio } from '@/hooks/use-studio'
import { Loader2, Terminal, Shield, Bot } from 'lucide-react'

export function AuthView() {
  const { login, register } = useStudio()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'login') await login(email, password)
      else await register(email, name, password)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-zinc-950">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 text-2xl font-bold text-emerald-400">
            <Bot className="w-8 h-8" />
            AI Development Studio
          </div>
          <p className="text-zinc-400 text-sm">
            Agentes de IA que constroem projetos reais — do pedido ao código testado.
          </p>
        </div>

        <Card className="border-zinc-800 bg-zinc-900/80">
          <CardHeader>
            <CardTitle className="text-lg">{mode === 'login' ? 'Entrar' : 'Criar conta'}</CardTitle>
            <CardDescription>Acesso seguro ao seu estúdio de agentes</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={mode} onValueChange={(v) => setMode(v as 'login' | 'register')}>
              <TabsList className="grid w-full grid-cols-2 mb-4">
                <TabsTrigger value="login">Entrar</TabsTrigger>
                <TabsTrigger value="register">Registrar</TabsTrigger>
              </TabsList>
              <TabsContent value={mode}>
                <form onSubmit={submit} className="space-y-4">
                  {mode === 'register' && (
                    <div className="space-y-2">
                      <Label htmlFor="name">Nome</Label>
                      <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Seu nome" required minLength={2} />
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="email">E-mail</Label>
                    <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@exemplo.com" required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Senha</Label>
                    <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="mínimo 8 caracteres" required minLength={8} />
                  </div>
                  {error && <p className="text-red-400 text-sm">{error}</p>}
                  <Button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-500" disabled={busy}>
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : mode === 'login' ? 'Entrar' : 'Criar conta e entrar'}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <div className="grid grid-cols-3 gap-3 text-center text-xs text-zinc-500">
          <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/50 space-y-1">
            <Bot className="w-5 h-5 mx-auto text-emerald-500" />
            <p>Multi-agente real com tools</p>
          </div>
          <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/50 space-y-1">
            <Shield className="w-5 h-5 mx-auto text-emerald-500" />
            <p>Workspaces isolados</p>
          </div>
          <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/50 space-y-1">
            <Terminal className="w-5 h-5 mx-auto text-emerald-500" />
            <p>Testes executados de verdade</p>
          </div>
        </div>
      </div>
    </div>
  )
}
