// ============================================================
// TOOLS / EXEC — Execução de comandos e testes
// run_command e run_tests passam pela allowlist de segurança
// e pelo ExecutionProvider (local/docker/remote).
// ============================================================

import fs from 'fs/promises'
import path from 'path'
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
 * FASE 2 — auditoria: deteta o runner pelo package.json ANTES de
 * spawnar (a cascata fixa de 5 candidatos custava até 5 processos
 * por chamada; `node --test test/*.test.js` nunca funcionou sem
 * shell — glob literal — e o runner python rodava em projetos JS).
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
    // 1º candidato: runner declarado no package.json (0 spawns extras)
    const candidates = custom
      ? [custom]
      : await detectTestCandidates(ctx.workspaceRoot)

    const provider = getExecutionProvider()
    let last = ''
    for (const cmd of candidates) {
      const res = await provider.execute({ command: cmd, cwd: ctx.workspaceRoot, label: 'run_tests' })
      last = summarizeExec(res)
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
      if (ranTests || cmd === candidates[candidates.length - 1] || custom) break
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

/** Detecta os candidatos de teste SEM spawns: package.json primeiro. */
async function detectTestCandidates(workspaceRoot: string): Promise<string[]> {
  // 1) package.json → script test (npm test)
  try {
    const pkgRaw = await fs.readFile(path.join(workspaceRoot, 'package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> }
    if (pkg.scripts?.test && !pkg.scripts.test.includes('echo')) return ['npm test']
  } catch { /* sem package.json — segue */ }
  // 2) pasta test/ JS → node --test (auto-discovery — MÁX 2 spawns)
  try {
    const entries = await fs.readdir(path.join(workspaceRoot, 'test')).catch(() => [])
    const hasJs = entries.some((e) => e.endsWith('.test.js') || e.endsWith('.test.mjs') || e.endsWith('.test.ts'))
    if (hasJs) return ['node --test', 'npm test']
  } catch { /* sem pasta test — segue */ }
  // 3) projetos Python
  try {
    const entries = await fs.readdir(path.join(workspaceRoot, 'tests')).catch(() => [])
    const hasPy = entries.some((e) => e.endsWith('.py'))
    if (hasPy) return ['python3 -m unittest discover -s tests']
  } catch { /* segue */ }
  // 4) fallback universal (auto-discovery do Node)
  return ['node --test']
}
