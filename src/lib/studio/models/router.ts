// ============================================================
// MODEL ROUTER — coração do roteamento de modelos
// Regras:
//   1. GLM-5.3-Flash    → MASTER/ORCHESTRATOR
//   2. Qwen3.8-Flash    → CODING
//   3. Hy3              → REVIEW/QA
//   4. DeepSeek-V4-Flash → DESATIVADO POR PADRÃO (ENABLE_DEEPSEEK=false)
//      Somente se: explicitamente habilitado + problema difícil +
//      modelos gratuitos falharam + limites diários permitirem.
// Provedor físico: B.AI (BAI_API_KEY_1/2 com failover controlado)
// quando configurado; neste sandbox, fallback para o SDK local.
// Também: verificação de disponibilidade, controles de limite,
// registro de uso (ModelUsage) — nunca uso acidental do DeepSeek.
// ============================================================

import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { BAIProvider } from './providers/bai-provider'
import { ZAIProvider } from './providers/zai-provider'
import type { ChatMessage, CompletionResult, LLMProvider, ModelDefinition, ModelRole } from './types'

// ---------- REGISTRO DE MODELOS LÓGICOS ----------
// O provider físico real (B.AI ou SDK sandbox) é decidido em tempo de
// execução: chaves B.AI configuradas → 'bai'; caso contrário → 'zai'.
// Modelos lógicos diferenciam-se por papel, prompt e parâmetros,
// e o uso é registrado por modelo lógico (rastreabilidade real).

// Nome de provider físico ativo (server-side only, sem secrets)
function activeProviderName(): 'bai' | 'zai' {
  const k1 = (process.env.BAI_API_KEY_1 ?? '').trim()
  const k2 = (process.env.BAI_API_KEY_2 ?? '').trim()
  return k1 || k2 ? 'bai' : 'zai'
}

function buildRegistry(): ModelDefinition[] {
  const provider = activeProviderName()
  return [
    {
      id: STUDIO_CONFIG.models.master,
      label: 'GLM-5.3-Flash',
      role: 'master',
      provider,
      enabledByDefault: true,
      description: 'Master Agent / Orquestrador — análise, planejamento, decisões',
    },
    {
      id: STUDIO_CONFIG.models.coding,
      label: 'Qwen3.8-Flash',
      role: 'coding',
      provider,
      enabledByDefault: true,
      description: 'Coding Agent — implementação de código e correções',
    },
    {
      id: STUDIO_CONFIG.models.review,
      label: 'Hy3',
      role: 'review',
      provider,
      enabledByDefault: true,
      description: 'Review/QA — revisão de código, qualidade, segurança',
    },
    {
      id: STUDIO_CONFIG.models.deepseek,
      label: 'DeepSeek-V4-Flash',
      role: 'deepseek',
      provider,
      enabledByDefault: false, // DESATIVADO POR PADRÃO — regra de negócio
      description: 'Fallback para problemas difíceis. Requer ENABLE_DEEPSEEK=true.',
    },
  ]
}

export const MODEL_REGISTRY: ModelDefinition[] = buildRegistry()

export class ModelRouter {
  private providers: Record<string, LLMProvider>

  constructor() {
    // Provider físico: B.AI (com failover de chaves) quando configurado;
    // caso contrário, SDK do sandbox — a arquitetura de agentes não muda.
    this.providers =
      activeProviderName() === 'bai'
        ? { bai: new BAIProvider() }
        : { zai: new ZAIProvider() }
  }
  // Throttle global: intervalo mínimo entre chamadas LLM (evita 429)
  private lastCallAt = 0
  private readonly minIntervalMs = 1500

  private async throttle(): Promise<void> {
    const now = Date.now()
    const wait = this.lastCallAt + this.minIntervalMs - now
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastCallAt = Date.now()
  }

  /** Mapeia papel lógico → modelo configurado. */
  modelForRole(role: ModelRole): string {
    switch (role) {
      case 'master':
        return STUDIO_CONFIG.models.master
      case 'coding':
        return STUDIO_CONFIG.models.coding
      case 'review':
      case 'testing':
        return STUDIO_CONFIG.models.review
      case 'github':
        return STUDIO_CONFIG.models.master
      case 'deepseek':
        return STUDIO_CONFIG.models.deepseek
    }
  }

  /** Disponibilidade do modelo (provider funcional + regras). */
  async isModelAvailable(modelId: string): Promise<{ available: boolean; reason?: string }> {
    const def = MODEL_REGISTRY.find((m) => m.id === modelId)
    if (!def) return { available: false, reason: 'modelo não registrado' }

    if (def.id === STUDIO_CONFIG.models.deepseek) {
      if (!STUDIO_CONFIG.models.enableDeepseek) {
        return { available: false, reason: 'ENABLE_DEEPSEEK=false (desativado por padrão)' }
      }
      const used = await this.deepseekUsageToday()
      if (used >= STUDIO_CONFIG.models.deepseekMaxDailyRequests) {
        return {
          available: false,
          reason: `limite diário do DeepSeek atingido (${used}/${STUDIO_CONFIG.models.deepseekMaxDailyRequests})`,
        }
      }
    }
    const provider = this.providers[def.provider]
    if (!provider) return { available: false, reason: `provider ${def.provider} não implementado` }
    const ok = await provider.isAvailable()
    return ok ? { available: true } : { available: false, reason: 'provider indisponível' }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10)
  }

  private async deepseekUsageToday(): Promise<number> {
    const rec = await db.modelUsage.findUnique({
      where: { day_model: { day: this.today(), model: STUDIO_CONFIG.models.deepseek } },
    })
    return rec?.requests ?? 0
  }

  /**
   * Chamada principal com registro de uso.
   * DeepSeek só passa se TODAS as condições forem satisfeitas.
   */
  async chat(modelId: string, messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<CompletionResult> {
    const def = MODEL_REGISTRY.find((m) => m.id === modelId)
    if (!def) throw Object.assign(new Error(`MODELO_DESCONHECIDO: ${modelId}`), { code: 'UNAVAILABLE' })

    if (def.id === STUDIO_CONFIG.models.deepseek) {
      const gate = await this.isModelAvailable(def.id)
      if (!gate.available) {
        throw Object.assign(
          new Error(`DEEPSEEK_BLOQUEADO: ${gate.reason}`),
          { code: 'DISABLED' }
        )
      }
    }

    const provider = this.providers[def.provider]
    if (!provider) {
      throw Object.assign(
        new Error(`PROVIDER_AUSENTE: ${def.provider}`),
        { code: 'UNAVAILABLE' }
      )
    }

    let result: CompletionResult
    try {
      await this.throttle()
      result = await provider.complete({ model: modelId, messages, ...opts })
      await this.recordUsage(modelId, result)
      return result
    } catch (err) {
      await this.recordUsage(modelId, null, true)
      throw err
    }
  }

  /** Atalho: chat por papel (master/coding/review...). */
  async chatRole(role: ModelRole, messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }) {
    return this.chat(this.modelForRole(role), messages, opts)
  }

  /**
   * Fallback CONTROLADO para DeepSeek — somente quando:
   * habilitado + dificuldade difícil + falha dos modelos gratuitos.
   */
  async chatWithDeepseekFallback(
    primaryRole: ModelRole,
    messages: ChatMessage[],
    opts?: { temperature?: number; maxTokens?: number; difficulty?: 'easy' | 'medium' | 'hard' }
  ): Promise<{ result: CompletionResult; usedFallback: boolean }> {
    const primary = this.modelForRole(primaryRole)
    try {
      const result = await this.chat(primary, messages, opts)
      return { result, usedFallback: false }
    } catch (primaryErr) {
      const difficulty = opts?.difficulty ?? 'medium'
      const wantFallback =
        STUDIO_CONFIG.models.enableDeepseek &&
        difficulty === 'hard' &&
        (primaryErr as { code?: string }).code !== 'DISABLED'

      if (wantFallback) {
        const gate = await this.isModelAvailable(STUDIO_CONFIG.models.deepseek)
        if (gate.available) {
          const result = await this.chat(STUDIO_CONFIG.models.deepseek, messages, opts)
          return { result, usedFallback: true }
        }
      }
      throw primaryErr
    }
  }

  /** Registra uso no agregado diário por modelo. */
  private async recordUsage(model: string, result: CompletionResult | null, isError = false): Promise<void> {
    try {
      await db.modelUsage.upsert({
        where: { day_model: { day: this.today(), model } },
        create: {
          day: this.today(),
          model,
          requests: 1,
          promptTokens: result?.promptTokens ?? 0,
          completionTokens: result?.completionTokens ?? 0,
          totalTokens: result?.promptTokens + result?.completionTokens ?? 0,
          errors: isError ? 1 : 0,
        },
        update: {
          requests: { increment: 1 },
          promptTokens: { increment: result?.promptTokens ?? 0 },
          completionTokens: { increment: result?.completionTokens ?? 0 },
          totalTokens: { increment: (result?.promptTokens ?? 0) + (result?.completionTokens ?? 0) },
          errors: { increment: isError ? 1 : 0 },
        },
      })
    } catch (e) {
      // uso não crítico: falha de métricas não deve derrubar o pipeline
      console.error('[ModelRouter] falha ao registrar uso:', (e as Error).message)
    }
  }

  /** Snapshot para a UI (Models/Usage) — sem secrets. */
  async overview() {
    const usage = await db.modelUsage.findMany({ orderBy: { day: 'desc' }, take: 60 })
    const models = await Promise.all(
      MODEL_REGISTRY.map(async (m) => {
        const gate = await this.isModelAvailable(m.id)
        return {
          id: m.id,
          label: m.label,
          role: m.role,
          description: m.description,
          enabledByDefault: m.enabledByDefault,
          available: gate.available,
          reason: gate.reason,
        }
      })
    )
    const todayUsage = usage.filter((u) => u.day === this.today())
    return {
      models,
      today: todayUsage,
      enableDeepseek: STUDIO_CONFIG.models.enableDeepseek,
      totalsToday: todayUsage.reduce(
        (acc, u) => ({
          requests: acc.requests + u.requests,
          totalTokens: acc.totalTokens + u.totalTokens,
          errors: acc.errors + u.errors,
        }),
        { requests: 0, totalTokens: 0, errors: 0 }
      ),
    }
  }
}

// Nota: NÃO usamos singleton em globalThis — isso faria instâncias antigas
// (com código pré-correção) sobreviverem a hot-reloads do dev server.
// Cada módulo compilado usa seu próprio router; o throttle é por instância.
export const modelRouter = new ModelRouter()
