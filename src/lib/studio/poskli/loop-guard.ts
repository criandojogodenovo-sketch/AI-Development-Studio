// ============================================================
// POSKLI / LOOP GUARD (NÚCLEO PURO)
// Detecção de loops a NÍVEL DE PLANO — o que faltava ao
// RepeatedFailureDetector (que age por ação isolada):
//
//   1. Falha de testes com a MESMA assinatura 2x seguidas
//      → as correções não estão resolvendo → PARAR.
//   2. Correção "aplicada" sem NENHUMA alteração no repositório
//      → o agente está girando sem produzir diff → PARAR.
//
// Regra profissional: parar honestamente ("Loop detetado") em
// vez de continuar queimando tokens. ZERO imports de runtime.
// ============================================================

const SIGNATURE_CHARS = 400

/** Assinatura estável de uma falha: linhas de erro normalizadas
 *  (primeiras N chars) — ignora timestamps/durações/ordem de
 *  testes individuais, foca no TIPO do erro. */
export function failureSignature(stdout: string, stderr: string): string {
  const relevant = `${stdout}\n${stderr}`
    .split('\n')
    .filter((l) => /error|fail|assert|expected|actual|✖|not ok|throw|SCRIPT ERROR|PARSE ERROR|Cannot|Failed|expected/i.test(l))
    .map((l) => l.replace(/\d+(\.\d+)?(ms|s)\b/g, 'N').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(' | ')
  return relevant.slice(0, SIGNATURE_CHARS)
}

/** Assinatura vazia = sem erros identificáveis → não comparar. */
export function hasFailureSignature(stdout: string, stderr: string): boolean {
  return failureSignature(stdout, stderr).length > 0
}

export interface LoopGuardVerdict {
  stop: boolean
  reason: 'SAME_FAILURE' | 'NO_REPO_CHANGE' | ''
  message: string
}

/**
 * Decide se o ciclo de correções deve PARAR:
 * - sameSignatures: assinaturas das falhas em ORDEM cronológica
 *   (as 2 últimas iguais e não vazias → SAME_FAILURE)
 * - repoChangedAfterCorrection: se a última correção aplicada não
 *   alterou NADA no repositório → NO_REPO_CHANGE
 */
export function shouldStopCorrectionCycle(input: {
  sameSignatures: string[]
  repoChangedAfterCorrection: boolean | null
}): LoopGuardVerdict {
  const sigs = input.sameSignatures.filter((s) => s.length > 0)
  const last2 = sigs.slice(-2)
  if (last2.length === 2 && last2[0] === last2[1]) {
    return {
      stop: true,
      reason: 'SAME_FAILURE',
      message:
        'LOOP_DETECTADO: as falhas dos testes são as MESMAS após a correção anterior ' +
        '(assinatura idêntica) — ciclos interrompidos para evitar desperdício de tokens. ' +
        'Reporte honestamente: os problemas persistem e exigem intervenção/decisão humana.',
    }
  }
  if (input.repoChangedAfterCorrection === false) {
    return {
      stop: true,
      reason: 'NO_REPO_CHANGE',
      message:
        'LOOP_DETECTADO: a correção anterior não alterou NENHUM arquivo do repositório ' +
        '(diff vazio) — o agente está repetindo raciocínio sem produzir mudanças. ' +
        'Ciclos interrompidos honestamente.',
    }
  }
  return { stop: false, reason: '', message: '' }
}

// ============================================================
// LOOP AGÊNTICO (substitui o pipeline fixo Corrigindo/Revisando)
// Estilo Claude Code/Codex: o agente vê o output dos testes e
// edita os arquivos DIRETAMENTE. O orquestrador apenas limita
// o número de rodadas de edição e detecta loops.
// ============================================================

/** Teto de rodadas de edição após falha de testes (spec: 2). */
export const MAX_FIX_ATTEMPTS = 2

/**
 * Orçamento efetivo de correções agênticas: o menor entre o teto
 * fixo (2 edições) e o máximo de iterações do run.
 */
export function agenticFixBudget(maxIterations: number, cap: number = MAX_FIX_ATTEMPTS): number {
  const iters = Number.isFinite(maxIterations) ? Math.floor(maxIterations) : 1
  return Math.max(1, Math.min(cap, Math.max(1, iters)))
}

export interface AgenticFixDecision {
  continueFix: boolean
  reason?: 'FIX_BUDGET_EXHAUSTED' | 'LOOP_GUARD' | ''
  message: string
}

/**
 * Decide se o orquestrador deve iniciar MAIS uma rodada de
 * edição agêntica (agente vê erro → edita arquivo diretamente):
 * - fixAttempts >= fixBudget → parar (orçamento de edições)
 * - loop-guard (mesma assinatura 2x / repo sem mudança) → parar
 * O loop termina quando npm test passa, quando o orçamento de
 * edições esgota ou quando o loop-guard detecta repetição.
 */
export function agenticFixDecision(input: {
  fixAttempts: number
  fixBudget: number
  sameSignatures: string[]
  repoChangedAfterFix: boolean | null
}): AgenticFixDecision {
  if (input.fixAttempts >= input.fixBudget) {
    return {
      continueFix: false,
      reason: 'FIX_BUDGET_EXHAUSTED',
      message:
        `TETO_DE_EDICOES: ${input.fixAttempts} rodada(s) de edição agêntica usada(s) ` +
        `(teto ${input.fixBudget}). O agente decide parar honestamente — reporte o estado ` +
        'real dos testes no resultado final.',
    }
  }
  const guard = shouldStopCorrectionCycle({
    sameSignatures: input.sameSignatures,
    repoChangedAfterCorrection: input.repoChangedAfterFix,
  })
  if (guard.stop) {
    return { continueFix: false, reason: 'LOOP_GUARD', message: guard.message }
  }
  return { continueFix: true, reason: '', message: '' }
}
