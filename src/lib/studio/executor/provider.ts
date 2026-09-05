// ============================================================
// EXECUTOR — ExecutionProvider (abstração de isolamento)
// Fluxo: Agent → Tool → Executor → Sandbox/Workspace
//
// Honestidade arquitetural: este ambiente NÃO possui Docker.
// Implementamos LocalExecutionProvider (funcional, com limites
// de timeout/memória/saída/allowlist) e definimos a interface
// para DockerExecutionProvider / RemoteSandboxProvider futuros.
// Nada aqui "finge" isolamento que não existe.
// ============================================================

import { STUDIO_CONFIG } from '../config'
import { executeAllowedCommand, type ExecResult } from '../security/commands'

export interface ExecutionRequest {
  command: string
  cwd: string
  label?: string // ex: "run_tests", "install_deps"
}

export interface ExecutionRecord extends ExecResult {
  provider: string
  command: string
  label?: string
}

export interface ExecutionProvider {
  readonly name: string
  readonly supportsIsolation: boolean
  execute(req: ExecutionRequest, onProcess?: (pid: number | undefined) => void): Promise<ExecutionRecord>
}

/** Provider LOCAL — real, com limites rígidos de segurança. */
export class LocalExecutionProvider implements ExecutionProvider {
  readonly name = 'local'
  readonly supportsIsolation = false // HONESTO: processo local, não container

  async execute(req: ExecutionRequest, onProcess?: (pid: number | undefined) => void): Promise<ExecutionRecord> {
    const res = await executeAllowedCommand(req.command, req.cwd, onProcess)
    return { ...res, provider: this.name, command: req.command, label: req.label }
  }
}

/** Provider DOCKER — placeholder explícito (não disponível neste ambiente). */
export class DockerExecutionProvider implements ExecutionProvider {
  readonly name = 'docker'
  readonly supportsIsolation = true

  async execute(): Promise<ExecutionRecord> {
    throw new Error(
      'DOCKER_PROVIDER_NAO_IMPLEMENTADO: este ambiente não possui Docker. Configure EXECUTION_PROVIDER=local ou implemente este provider com uma imagem sandbox.'
    )
  }
}

/** Provider REMOTO — placeholder explícito. */
export class RemoteSandboxProvider implements ExecutionProvider {
  readonly name = 'remote'
  readonly supportsIsolation = true

  async execute(): Promise<ExecutionRecord> {
    throw new Error(
      'REMOTE_SANDBOX_PROVIDER_NAO_IMPLEMENTADO: defina REMOTE_SANDBOX_URL e implemente o protocolo do provedor.'
    )
  }
}

/** Fábrica conforme configuração. */
export function getExecutionProvider(): ExecutionProvider {
  switch (STUDIO_CONFIG.executor.provider) {
    case 'docker':
      return new DockerExecutionProvider()
    case 'remote':
      return new RemoteSandboxProvider()
    case 'local':
    default:
      return new LocalExecutionProvider()
  }
}
