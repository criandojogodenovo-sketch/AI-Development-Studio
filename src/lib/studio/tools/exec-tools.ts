// ============================================================
// TOOLS / EXEC — Execução de comandos e testes
// run_command e run_tests passam pela allowlist de segurança
// e pelo ExecutionProvider (local/docker/remote).
// ============================================================

import { getExecutionProvider } from '../executor/provider'
import { emitEvent } from '../events/bus'
import type { ToolDefinition, ToolResult } from './types'

function trimOutput(s: string, max = 6000): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + `\n...[saída truncada ${s.length} chars]` : s
}

function summarizeExec(res: {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  command: string
}): string {
  const head = `COMANDO: ${res.command}\nEXIT_CODE: ${res.exitCode} | ${res.durationMs}ms${res.timedOut ? ' | TIMEOUT' : ''}`
  const out = trimOutput(res.stdout)
  const err = trimOutput(res.stderr)
  return [head, out ? `--- STDOUT ---\n${out}` : '', err ? `--- STDERR ---\n${err}` : '']
    .filter(Boolean)
    .join('\n')
}

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description:
    'Executa um comando permitido (allowlist: node, npm, npx, bun, git, python3, ls, cat, mkdir, find, grep) no workspace. Retorna exit code, stdout e stderr.',
  category: 'exec',
  permissions: ['exec:command'],
  params: [{ name: 'command', type: 'string', required: true, description: 'Comando com argumentos (sem shell)' }],
  async execute(args, ctx): Promise<ToolResult> {
    const command = String(args.command)
    const provider = getExecutionProvider()
    const res = await provider.execute({ command, cwd: ctx.workspaceRoot }, undefined)

    await emitEvent({
      type: 'tool.completed',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      tool: 'run_command',
      action: command.slice(0, 120),
      status: res.exitCode === 0 ? 'OK' : 'ERROR',
      message: `run_command: ${command} → exit ${res.exitCode}`,
      durationMs: res.durationMs,
      data: { exitCode: res.exitCode, timedOut: res.timedOut, denied: res.stderr.startsWith('COMANDO NEGADO') },
    })

    return {
      ok: res.exitCode === 0,
      output: summarizeExec(res),
      data: { exitCode: res.exitCode, durationMs: res.durationMs, timedOut: res.timedOut },
    }
  },
}

/**
 * run_tests — executa testes conforme o tipo do projeto.
 * O pipeline chama esta tool após implementações (Perfection Loop).
 */
export const runTestsTool: ToolDefinition = {
  name: 'run_tests',
  description:
    'Executa a suíte de testes do projeto. Detecta automaticamente o runner (package.json scripts, node --test, python -m unittest). Retorno inclui stdout/stderr e exit code.',
  category: 'exec',
  permissions: ['exec:tests'],
  params: [
    { name: 'command', type: 'string', required: false, description: 'Comando customizado de teste (opcional)' },
  ],
  async execute(args, ctx): Promise<ToolResult> {
    await emitEvent({
      type: 'test.started',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      message: 'Executando testes do projeto',
    })

    const custom = args.command ? String(args.command) : undefined
    const candidates = custom
      ? [custom]
      : [
          'node --test',              // auto-discovery (invocação correta Node 22+)
          'node --test test/game.test.js',
          'node --test test/*.test.js',
          'npm test',
          'python3 -m unittest discover -s tests',
        ]

    const provider = getExecutionProvider()
    let last: ReturnType<typeof summarizeExec> extends never ? never : string = ''
    for (const cmd of candidates) {
      const res = await provider.execute({ command: cmd, cwd: ctx.workspaceRoot, label: 'run_tests' })
      last = summarizeExec(res)
      // exit 0 = sucesso; exit != 0 mas com saída de "no tests" = tenta próximo
      if (res.exitCode === 0) {
        await emitEvent({
          type: 'test.passed',
          projectId: ctx.projectId,
          runId: ctx.runId,
          agent: ctx.agentId,
          status: 'PASSED',
          message: `Testes aprovados (${cmd}) em ${res.durationMs}ms`,
          durationMs: res.durationMs,
        })
        return { ok: true, output: `TESTES_PASSARAM (${cmd})\n${last}`, data: { command: cmd, exitCode: 0 } }
      }
      // Se rodou algo real (havia runner configurado), não tenta demais
      // Heurística: saída contém contagem de testes → os testes RODARAM (falha real)
      const ranTests = /tests\s+\d|pass\s+\d|fail\s+\d|✔|✖/.test(res.stdout + res.stderr)
      if (ranTests || cmd === 'npm test' || custom) break
    }

    await emitEvent({
      type: 'test.failed',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      status: 'FAILED',
      message: 'Testes falharam ou runner não encontrado',
    })
    return {
      ok: false,
      output: `TESTES_FALHARAM (ou runner ausente)\n${last}`,
      data: { command: custom ?? candidates.join(' | ') },
    }
  },
}
