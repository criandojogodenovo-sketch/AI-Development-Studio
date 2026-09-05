// ============================================================
// ORCHESTRATOR / LOOP-DETECTOR — Detecção de REPEATED_FAILURE
// Identifica quando o agente repete a MESMA estratégia falha:
//   Erro A → correção X → Erro A → correção X → Erro A
// Com N repetições da mesma assinatura → parar e reportar.
// ============================================================

import crypto from 'crypto'

interface FailureRecord {
  signature: string
  count: number
  lastObservation: string
  lastTool: string
}

export class RepeatedFailureDetector {
  private records: FailureRecord[] = []
  private threshold: number

  constructor(threshold = 3) {
    this.threshold = Math.max(2, threshold)
  }

  /** Assinatura: ferramenta + hash estável da observação de erro (normalizada). */
  private signatureOf(tool: string, observation: string): string {
    // Normaliza: remove números voláteis, caminhos e durações
    const normalized = observation
      .replace(/\d+/g, 'N')          // números → N
      .replace(/\d+ms/g, 'Nms')
      .replace(/"[^"]*"/g, '"S"')    // strings → S
      .replace(/'[^']*'/g, "'S'")
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400)
    const hash = crypto.createHash('sha256').update(`${tool}::${normalized}`).digest('hex').slice(0, 12)
    return `${tool}#${hash}`
  }

  /** Registra uma falha. Retorna nº de repetições da assinatura. */
  record(tool: string, args: Record<string, unknown>, observation: string): number {
    const sig = this.signatureOf(tool, observation)
    const existing = this.records.find((r) => r.signature === sig)
    if (existing) {
      existing.count++
      existing.lastObservation = observation
      return existing.count
    }
    this.records.push({ signature: sig, count: 1, lastObservation: observation, lastTool: tool })
    return 1
  }

  /** Há repetição acima do limiar? */
  isRepeating(): { signature: string; lastObservation: string } | null {
    const hit = this.records.find((r) => r.count >= this.threshold)
    if (!hit) return null
    return { signature: hit.signature, lastObservation: hit.lastObservation }
  }

  getRepeats(): number {
    return Math.max(0, ...this.records.map((r) => r.count))
  }

  /** Diagnóstico para relatório de falha. */
  report(): string {
    if (!this.records.length) return 'nenhuma falha registrada'
    const top = [...this.records].sort((a, b) => b.count - a.count).slice(0, 3)
    return top
      .map((r) => `- ${r.lastTool} (${r.count}x): ${r.lastObservation.slice(0, 120)}`)
      .join('\n')
  }
}
