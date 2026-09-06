// ============================================================
// MODEL ROUTER — coração do roteamento de modelos
// Regras:
//   1. GLM-5.3-Flash    → MASTER/ORCHESTRATOR
//   2. Qwen3.8-Flash    → CODING
//   3. Hy3              → REVIEW/QA
//   4. DeepSeek-V4-Flash → DESATIVADO POR PADRÃO (ENABLE_DEEPSEEK=false)
//      Somente se: explicitamente habilitado + problema difícil +
//      modelos gratuitos falharam + limites diários permitirem.
//
// PROVIDERS FÍSICOS — chain por versão do Poskli (POSKLI_VERSION):
//   0.1       : B.AI
//   0.2       : B.AI → NVIDIA
//   0.3.1     : B.AI → NVIDIA → EXPLABS (somente tarefas difíceis)
//   1.0-flash : NVIDIA → EXPLABS → B.AI (reserva)
// Sem chaves B.AI (sandbox): SDK local (zai) substitui o B.AI.
//
// POLÍTICA INVARIÁVEL: 429/rate limit NUNCA faz failover (nem entre
// chaves B.AI, nem entre providers). Falhas elegíveis (rede/5xx/
// timeout/401-403) avançam no chain — 1 tentativa por provider.
// Uso registrado por modelo LÓGICO (ModelUsage) — rastreabilidade.
// ============================================================

import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { BAIProvider } from './providers/bai-provider'
import { ZAIProvider } from './providers/zai-provider'
import { NVIDIAProvider, NVIDIA_MODEL_CATALOG } from './providers/nvidia.ts'
import { ExperientialProvider, EXPLABS_MODEL_CATALOG } from './providers/experiential.ts'
import {
  executeWithChain,
  normalizeVersion,
  resolveChain,
  type ChainContext,
  type ChainEntry,
  type Difficulty,
  type PoskliVersion,
  type ProviderName,
} from './chain'
import type { ChatMessage, CompletionResult, LLMProvider, ModelDefinition, ModelRole } from './types'

// ---------- REGISTRO DE MODELOS LÓGICOS ----------
// O id lógico é o nome no provider PRIMÁRIO (B.AI) e permanece
// estável para uso/auditoria (ModelUsage, UI). Cada entrada mapeia
// o modelo FÍSICO de cada provider — o chain decide qual usar em
// tempo de execução.

function baiKeysPresent(): boolean {
  const k1 = (process.env.BAI_API_KEY_1 ?? '').trim()
  const k2 = (process.env.BAI_API_KEY_2 ?? '').trim()
  return Boolean(k1 || k2)
}

function buildRegistry(): ModelDefinition[] {
  return [
    {
      id: STUDIO_CONFIG.models.master,
      label: 'GLM-5.3-Flash',
      role: 'master',
      enabledByDefault: true,
      description: 'Master Agent / Orquestrador — análise, planejamento, decisões',
      physical: {
        bai: STUDIO_CONFIG.models.master,
        zai: STUDIO_CONFIG.models.master,
        nvidia: NVIDIA_MODEL_CATALOG.master,
        explabs: EXPLABS_MODEL_CATALOG.master,
      },
    },
    {
      id: STUDIO_CONFIG.models.coding,
      label: 'Qwen3.8-Flash',
      role: 'coding',
      enabledByDefault: true,
      description: 'Coding Agent — implementação de código e correções',
      physical: {
        bai: STUDIO_CONFIG.models.coding,
        zai: STUDIO_CONFIG.models.coding,
        nvidia: NVIDIA_MODEL_CATALOG.coding,
        explabs: EXPLABS_MODEL_CATALOG.coding,
      },
    },
    {
      id: STUDIO_CONFIG.models.review,
      label: 'Hy3',
      role: 'review',
      enabledByDefault: true,
      description: 'Review/QA — revisão de código, qualidade, segurança',
      physical: {
        bai: STUDIO_CONFIG.models.review,
        zai: STUDIO_CONFIG.models.review,
        nvidia: NVIDIA_MODEL_CATALOG.review,
        explabs: EXPLABS_MODEL_CATALOG.review,
      },
    },
    {
      id: STUDIO_CONFIG.models.deepseek,
      label: 'DeepSeek-V4-Flash',
      role: 'deepseek',
      enabledByDefault: false, // DESATIVADO POR PADRÃO — regra de negócio
      description: 'Fallback para problemas difíceis. Requer ENABLE_DEEPSEEK=true.',
      physical: {
        bai: STUDIO_CONFIG.models.deepseek,
        zai: STUDIO_CONFIG.models.deepseek,
      },
    },
  ]
}

export const MODEL_REGISTRY: ModelDefinition[] = buildRegistry()

export class ModelRouter {
  private providers: Record<string, LLMProvider>

  constructor() {
    this.providers = {
      bai: new BAIProvider(),
      zai: new ZAIProvider(),
      nvidia: new NVIDIAProvider(),
      explabs: new ExperientialProvider(),
    }
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

  // ---------- CHAIN (providers físicos por versão do Poskli) ----------

  private activeVersion(): PoskliVersion {
    return normalizeVersion(STUDIO_CONFIG.router.poskliVersion)
  }

  private chainContext(difficulty?: Difficulty): ChainContext {
    return {
      baiConfigured: baiKeysPresent(),
      nvidiaConfigured: (this.providers.nvidia as NVIDIAProvider).isConfigured(),
      explabsConfigured: (this.providers.explabs as ExperientialProvider).isConfigured(),
      difficulty,
    }
  }

  /** Entradas do chain (provider + modelo físico) para um modelo lógico. */
  private entriesFor(
    def: ModelDefinition,
    difficulty?: Difficulty
  ): { entries: ChainEntry[]; version: PoskliVersion; chain: ProviderName[] } {
    const version = this.activeVersion()
    const chain = resolveChain(version, this.chainContext(difficulty))
    const entries: ChainEntry[] = []
    for (const name of chain) {
      const llm = this.providers[name]
      const model = def.physical[name]
      if (!llm || !model) continue
      entries.push({ provider: name, llm, model })
    }
    return { entries, version, chain }
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

  /** Disponibilidade do modelo (providers do chain funcionais + regras). */
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

    const { entries, version } = this.entriesFor(def)
    if (entries.length === 0) {
      return { available: false, reason: `nenhum provider do chain (versão ${version}) serve este modelo` }
    }
    for (const e of entries) {
      try {
        if (await e.llm.isAvailable()) return { available: true }
      } catch { /* provider indisponível — tenta o próximo do chain */ }
    }
    return { available: false, reason: 'providers do chain indisponíveis' }
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
   * Chamada principal: percorre o chain da versão ativa com failover
   * CONTROLADO (429 nunca; elegíveis avançam; 1 tentativa por provider).
   * DeepSeek só passa se TODAS as condições forem satisfeitas.
   */
  async chat(
    modelId: string,
    messages: ChatMessage[],
    opts?: { temperature?: number; maxTokens?: number; difficulty?: Difficulty }
  ): Promise<CompletionResult> {
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

    const { entries, version } = this.entriesFor(def, opts?.difficulty)
    if (entries.length === 0) {
      throw Object.assign(
        new Error(
          `PROVIDER_AUSENTE: nenhum provider do chain (versão ${version}) serve ${modelId}`
        ),
        { code: 'UNAVAILABLE' }
      )
    }

    let result: CompletionResult
    try {
      await this.throttle()
      const executed = await executeWithChain(entries, {
        messages,
        temperature: opts?.temperature,
        maxTokens: opts?.maxTokens,
      })
      result = executed.result
      if (executed.provider !== entries[0]?.provider) {
        console.warn(
          `[ModelRouter] failover do chain: ${entries[0]?.provider} → ${executed.provider} (model lógico ${modelId}, versão ${version})`
        )
      }
      await this.recordUsage(modelId, result)
      return result
    } catch (err) {
      await this.recordUsage(modelId, null, true)
      throw err
    }
  }

  /** Atalho: chat por papel (master/coding/review...). */
  async chatRole(
    role: ModelRole,
    messages: ChatMessage[],
    opts?: { temperature?: number; maxTokens?: number; difficulty?: Difficulty }
  ) {
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

  /** Registra uso no agregado diário por modelo lógico. */
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
          totalTokens: (result?.promptTokens ?? 0) + (result?.completionTokens ?? 0),
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
    const version = this.activeVersion()
    const chain = resolveChain(version, this.chainContext())
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
      chain: { version, providers: chain },
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
