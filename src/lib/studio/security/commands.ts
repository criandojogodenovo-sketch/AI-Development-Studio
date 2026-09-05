// ============================================================
// SEGURANÇA — Allowlist de comandos executáveis pelos agentes
// Nenhum comando fora da allowlist é executado. Sem exceções.
// ============================================================

import { spawn } from 'child_process'
import { STUDIO_CONFIG } from '../config'

/** Comandos permitidos e seus argumentos permitidos (prefixos). */
const COMMAND_ALLOWLIST: Record<string, string[]> = {
  node: ['--version', '--test', '-e', '--experimental-vm-modules', '--reporter'],
  npm: ['install', 'run', 'test', '--version', 'init', 'ci', 'ls', 'start', 'build', 'exec', 'publish'],
  npx: ['--yes', 'create-', 'http-server', 'vitest', 'tsc', 'typescript', 'jest', 'serve'],
  bun: ['install', 'run', 'test', '--version', 'x', 'add'],
  git: ['status', 'diff', 'log', 'add', 'commit', 'branch', 'checkout', 'init', 'config', 'push', 'pull', 'merge', 'stash', 'show', 'rev-parse', '--version', 'worktree'],
  python3: ['--version', '-c', '-m'],
  ls: ['-la', '-a', '-l'],
  cat: [],
  echo: [],
  mkdir: ['-p'],
  pwd: [],
  wc: [],
  find: ['.', '-name', '-type', '-maxdepth'],
  grep: ['-r', '-i', '--include', '-n', '-E'],
  rg: ['--files', '-n', '-i', '-g'],
  rm: ['-rf', '-r', '-f', 'node_modules', 'dist', '.next', '.cache', 'coverage', 'tmp'],
}

/** Comandos explicitamente proibidos mesmo que prefixados. */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /rm\s+-rf?\s+\//,            // rm na raiz
  /mkfs/,                       // formatação
  /:\(\)\{.*\};:/,              // fork bomb
  /curl.*\|\s*(ba)?sh/,         // pipe para shell
  /wget.*\|\s*(ba)?sh/,
  /\/dev\/sd/,                  // escrita em dispositivo
  /chmod\s+777\s+\//,           // chmod recursivo na raiz
  /shutdown|reboot|halt/,
  /sudo/,
  /nc\s+-l/,                    // netcat listener
  /ssh-keygen/,
  /--no-sandbox/,
  /eval\s*["']/,
  /\/etc\/|\/root\/|\/proc\/|\/sys\//, // caminhos de sistema
  /169\.254\.169\.254/,         // metadata endpoint (SSRF)
]

/**
 * Argumento posicional SEGURO: caminho relativo dentro do workspace,
 * sem '..' (traversal), sem caminho absoluto, charset controlado.
 * Metacaracteres de shell já são bloqueados globalmente.
 */
function isSafePositional(arg: string): boolean {
  if (!arg || arg.startsWith('-')) return false
  if (arg.startsWith('/') || arg.includes('..') || arg.includes('\0')) return false
  // caminho/identificador/pacote/mensagem relativo (aspas literais são
  // inofensivas: NUNCA usamos shell — spawn direto sem interpretação)
  return /^[\w."'][\w./@:=+ "'-]*$/.test(arg) && arg.length <= 300
}

export interface CommandCheck {
  allowed: boolean
  reason?: string
  cmd: string
  args: string[]
}

/** Valida um comando contra a allowlist. */
export function checkCommand(commandLine: string): CommandCheck {
  const trimmed = commandLine.trim()
  if (!trimmed) return { allowed: false, reason: 'comando vazio', cmd: '', args: [] }

  // Rejeita shell metacharacters perigosos (não usamos shell: true)
  if (/[;&|`$><]/.test(trimmed.replace(/\$\{[^}]*\}/g, ''))) {
    return { allowed: false, reason: 'metacaracteres de shell proibidos', cmd: '', args: [] }
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `padrão proibido detectado (${pattern})`, cmd: '', args: [] }
    }
  }

  const parts = trimmed.split(/\s+/)
  const cmd = parts[0]
  const args = parts.slice(1)

  const allowedArgs = COMMAND_ALLOWLIST[cmd]
  if (!allowedArgs) {
    return { allowed: false, reason: `"${cmd}" não está na allowlist de comandos`, cmd, args }
  }
  if (args.length > 20) {
    return { allowed: false, reason: 'número excessivo de argumentos', cmd, args }
  }
  for (const arg of args) {
    if (arg.length > 500) {
      return { allowed: false, reason: 'argumento excessivamente longo', cmd, args }
    }
    const known = allowedArgs.some((prefix) => arg === prefix || arg.startsWith(prefix))
    const generic = arg.startsWith('-') && arg.length <= 40 && /^-{1,3}[a-zA-Z0-9-]+$/.test(arg)
    // caminhos relativos do workspace como argumento posicional
    const positional = isSafePositional(arg)
    // rm só aceita alvos gerados (nunca código-fonte do usuário)
    const rmSafe = cmd !== 'rm' || /^[\w-]+$/.test(arg) && ['node_modules', 'dist', '.next', '.cache', 'coverage', 'tmp'].includes(arg)
    if (!known && !generic && !(positional && rmSafe)) {
      return {
        allowed: false,
        reason: `argumento "${arg}" não permitido para "${cmd}"`,
        cmd,
        args,
      }
    }
  }
  return { allowed: true, cmd, args }
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  killed: boolean
}

/**
 * Executa um comando validado SEM shell (spawn direto),
 * com timeout, limite de memória e truncamento de saída.
 */
export function executeAllowedCommand(
  commandLine: string,
  cwd: string,
  onProcess?: (pid: number | undefined) => void
): Promise<ExecResult> {
  const check = checkCommand(commandLine)
  if (!check.allowed) {
    return Promise.resolve({
      exitCode: 126,
      stdout: '',
      stderr: `COMANDO NEGADO: ${check.reason}`,
      durationMs: 0,
      timedOut: false,
      killed: false,
    })
  }

  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(check.cmd, check.args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: cwd, // HOME = workspace: isola configs do usuário
        CI: 'true',
        NODE_ENV: 'development',
        npm_config_yes: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    onProcess?.(child.pid)

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killed = false

    const maxOut = STUDIO_CONFIG.executor.maxOutputBytes
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < maxOut) stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < maxOut) stderr += d.toString('utf8')
    })

    const timer = setTimeout(() => {
      timedOut = true
      killed = true
      child.kill('SIGKILL')
    }, STUDIO_CONFIG.executor.maxCommandTimeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        exitCode: 127,
        stdout,
        stderr: stderr + `\nEXEC_ERROR: ${err.message}`,
        durationMs: Date.now() - started,
        timedOut,
        killed,
      })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      // Trunca saídas gigantes (economia de tokens e memória)
      const trunc = (s: string) =>
        s.length > maxOut ? s.slice(0, maxOut) + `\n...[saída truncada em ${maxOut} bytes]` : s
      resolve({
        exitCode: code ?? 1,
        stdout: trunc(stdout),
        stderr: trunc(stderr),
        durationMs: Date.now() - started,
        timedOut,
        killed,
      })
    })
  })
}
