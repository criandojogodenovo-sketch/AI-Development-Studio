// ============================================================
// TOOLS / GAME — Validação Godot headless (CLI real)
//
// godot_check: valida que o projeto Godot 4 COMPILA:
//   - modo "check": `godot --headless --path . --check-only`
//     (parse de scripts .gd — rápido, sem rodar o jogo)
//   - modo "run": `godot --headless --path . --quit-after N`
//     (carrega a cena principal e roda N frames — smoke test real)
//
// Capability detection: se a CLI não existir no executor
// (ex.: serverless), o retorno é HONESTO — o agente nunca finge
// que validou. Requer project.godot no workspace.
// ============================================================

import fs from 'fs/promises'
import path from 'path'
import { getExecutionProvider } from '../executor/provider'
import { emitEvent } from '../events/bus'
import { summarizeGodotOutput, godotUnavailableMessage } from './game-format.ts'
import type { ToolDefinition, ToolResult } from './types'

const GODOT_TIMEOUT_MS = 90_000

export const godotCheckTool: ToolDefinition = {
  name: 'godot_check',
  description:
    'Valida um projeto Godot 4 HEADLESS (compilação real): modo "check" faz parse de todos os scripts .gd; ' +
    'modo "run" carrega a cena principal e roda N frames (smoke test). Use SEMPRE após criar/editar scripts ' +
    'Godot — é a evidência de que o jogo compila. Requer project.godot no workspace.',
  category: 'exec',
  permissions: ['exec:command'],
  params: [
    { name: 'mode', type: 'string', required: false, description: '"check" (default: parse de scripts) ou "run" (smoke de N frames)' },
    { name: 'frames', type: 'number', required: false, description: 'frames a rodar no modo run (default 60)' },
  ],
  timeoutMs: GODOT_TIMEOUT_MS,
  async execute(args, ctx): Promise<ToolResult> {
    // ---- 1) projeto Godot existe? ----
    const projectFile = path.join(ctx.workspaceRoot, 'project.godot')
    const hasProject = await fs.stat(projectFile).catch(() => null)
    if (!hasProject) {
      return {
        ok: false,
        output:
          'PROJETO_GODOT_AUSENTE: nenhum project.godot no workspace. ' +
          'Para jogos Godot, crie a estrutura completa (project.godot, cenas .tscn, scripts .gd) ANTES de validar.',
      }
    }

    const provider = getExecutionProvider()

    // ---- 2) capability: a CLI existe neste executor? ----
    const ver = await provider.execute({ command: 'godot --version', cwd: ctx.workspaceRoot, label: 'godot_check' })
    if (ver.exitCode !== 0) {
      const detail = (ver.stderr || ver.stdout || 'binário não encontrado').trim()
      return { ok: false, output: godotUnavailableMessage(detail) }
    }
    const version = ver.stdout.trim().split('\n').pop() ?? ''

    // ---- 3) validação headless ----
    const mode = String(args.mode ?? 'check') === 'run' ? 'run' : 'check'
    const frames = Number.isFinite(args.frames as number) ? Math.min(Math.max(Number(args.frames), 1), 600) : 60
    const command =
      mode === 'run'
        ? `godot --headless --path . --quit-after ${frames}`
        : 'godot --headless --path . --check-only'

    const res = await provider.execute({ command, cwd: ctx.workspaceRoot, label: 'godot_check' })

    // exit 0 = compila; saída com SCRIPT ERROR = falha real
    const summary = summarizeGodotOutput(res.stdout, res.stderr)
    const passed = res.exitCode === 0 && !summary.hasErrors

    await emitEvent({
      type: passed ? 'test.passed' : 'test.failed',
      projectId: ctx.projectId,
      runId: ctx.runId,
      agent: ctx.agentId,
      tool: 'godot_check',
      status: passed ? 'PASSED' : 'FAILED',
      message: passed
        ? `Godot OK (${mode}) — projeto compila`
        : `Godot FALHOU (${mode}) — ${summary.errorCount} erro(s) de script`,
      durationMs: res.durationMs,
      data: { mode, frames: mode === 'run' ? frames : undefined, exitCode: res.exitCode },
    })

    const head = `GODOT ${passed ? 'OK' : 'FALHOU'} (${mode}${mode === 'run' ? `, ${frames} frames` : ''}) · ${version} · exit ${res.exitCode} · ${res.durationMs}ms`
    return {
      ok: passed,
      output: `${head}\n${summary.text}`,
      data: { mode, exitCode: res.exitCode, errorCount: summary.errorCount },
    }
  },
}

/** Registro das tools de jogo (godot_check). */
export const GODOT_TOOLS: ToolDefinition[] = [godotCheckTool]
