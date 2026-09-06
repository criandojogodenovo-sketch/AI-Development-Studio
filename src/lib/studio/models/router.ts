// ============================================================
// MODEL ROUTER — coração do roteamento de modelos (Tarefa C)
//
// ROTAS POR VERSÃO × PAPEL (VERSION_ROUTES do chain.ts):
//   0.1        : master Qwen · coding Hy3 · review Qwen (B.AI puro)
//   0.2        : master GLM · coding Qwen→DeepSeek(NV) ·
//                review Hy3→GPT-OSS(NV)
//   0.3.1      : master Hy3 · coding Qwen→GLM(429) ·
//                review GPT-OSS(NV)→Luna(B.AI)
//   1.0-flash  : NVIDIA prioritário (Nemotron/DeepSeek/GPT-OSS) →
//                B.AI reserva (429 → 1 retry → troca)
//   superagent : master GLM→Nemotron · coding Hy3→Qwen→DeepSeek ·
//                review GPT-OSS(NV)→Luna
//
// EXPERIENTIAL LABS: ELIMINADA (Tarefa C §2) — nenhum import,
// provider, env var ou versão a referencia. ProviderNames
// válidos: bai | zai (sandbox) | nvidia.
//
// POLÍTICA ANTI-RATE-LIMIT (chain.ts): 429 → backoff 5s/10s/20s
// (máx 3 tentativas) → QUOTA_EXHAUSTED para o RUN honestamente;
// fallback inteligente por parada (switch-now / retry-then-switch).
// Falhas elegíveis (rede/5xx/timeout/401-403) avançam no chain.
// Uso registrado por modelo LÓGICO (ModelUsage) — rastreabilidade.
// ============================================================

import { db } from '@/lib/db'
import { STUDIO_CONFIG } from '../config'
import { BAIProvider } from './providers/bai-provider'
import { ZAIProvider } from './providers/zai-provider'
import { NVIDIAProvider, NVIDIA_MODEL_CATALOG } from './providers/nvidia.ts'
import {
  executeWithChain,
  normalizeVersion,
  resolveChain,
  VERSION_ROUTES,
  type ChainContext,
  type ChainEntry,
  type Difficulty,
  type LogicalModelKey,
  type PoskliVersion,
  type ProviderName,
  type RouteRole,
} from './chain'
import { requestPoskliVersion } from './version-context.ts'
import type { ChatMessage, CompletionResult, LLMProvider, ModelDefinition, ModelRole } from './types'

// ---------- REGISTRO DE MODELOS LÓGICOS ----------
// O id lógico é o nome no provider PRIMÁRIO (B.AI) e permanece
// estável para uso/auditoria (ModelUsage, UI). Cada entrada mapeia
// o modelo FÍSICO de cada provider — a ROTA da versão decide qual
// usar em tempo de execução.

function baiKeysPresent(): boolean {
  const k1 = (process.env.BAI_API_KEY_1 ?? '').trim()
  const k2 = (process.env.BAI_API_KEY_2 ?? '').trim()
  return Boolean(k1 || k2)
}

/** Chaves lógicas (VERSION_ROUTES) → id do registro (env-configurável). */
const LOGICAL_TO_REGISTRY: Record<LogicalModelKey, string> = {
  glm: STUDIO_CONFIG.models.master,
  qwen: STUDIO_CONFIG.models.coding,
  hy3: STUDIO_CONFIG.models.review,
  deepseek: STUDIO_CONFIG.models.deepseek,
  luna: STUDIO_CONFIG.models.luna,
  'gpt-oss': 'gpt-oss-20b',
  nemotron: 'nemotron-3-super',
}

function buildRegistry(): ModelDefinition[] {
  return [
    {
      id: STUDIO_CONFIG.models.master,
      label: 'GLM-5.3-Flash',
      role: 'master',
      enabledByDefault: true,
      description: 'Master/Orquestrador — análise, planejamento, decisões (B.AI). Master nas versões 0.2/superagent e reserva da 1.0-flash.',
      physical: {
        bai: STUDIO_CONFIG.models.master,
        zai: STUDIO_CONFIG.models.master,
      },
    },
    {
      id: STUDIO_CONFIG.models.coding,
      label: 'Qwen3.8-Flash',
      role: 'coding',
      enabledByDefault: true,
      description: 'Coding Agent — implementação e correções (B.AI). Coding na 0.2/0.3.1/1.0-flash e 2ª parada da superagent.',
      physical: {
        bai: STUDIO_CONFIG.models.coding,
        zai: STUDIO_CONFIG.models.coding,
      },
    },
    {
      id: STUDIO_CONFIG.models.review,
      label: 'Hy3',
      role: 'review',
      enabledByDefault: true,
      description: 'Review/QA via B.AI — review na 0.2, coding na 0.1/superagent, master na 0.3.1.',
      physical: {
        bai: STUDIO_CONFIG.models.review,
        zai: STUDIO_CONFIG.models.review,
      },
    },
    {
      id: STUDIO_CONFIG.models.deepseek,
      label: 'DeepSeek-V4-Flash',
      role: 'deepseek',
      enabledByDefault: false, // DESATIVADO POR PADRÃO como papel; ativo como parada NVIDIA
      description: 'Coding pela NVIDIA NIM (deepseek-v4-flash) — parada de coding em 0.2/1.0-flash/superagent; papel emergência B.AI requer ENABLE_DEEPSEEK.',
      physical: {
        bai: STUDIO_CONFIG.models.deepseek,
        zai: STUDIO_CONFIG.models.deepseek,
        nvidia: NVIDIA_MODEL_CATALOG.coding,
      },
    },
    {
      id: STUDIO_CONFIG.models.luna,
      label: 'GPT-5.6-Luna',
      role: 'review',
      enabledByDefault: true,
      description: 'Fallback de REVIEW (B.AI) quando o NVIDIA falha por quota/região — versões 0.3.1 / 1.0-flash / superagent.',
      physical: {
        bai: STUDIO_CONFIG.models.luna,
        zai: STUDIO_CONFIG.models.luna,
      },
    },
    {
      id: 'gpt-oss-20b',
      label: 'GPT-OSS-20B (NVIDIA)',
      role: 'review',
      enabledByDefault: true,
      description: 'Review PRINCIPAL pela NVIDIA NIM — versões 0.3.1 / 1.0-flash / superagent.',
      physical: {
        nvidia: NVIDIA_MODEL_CATALOG.review,
      },
    },
    {
      id: 'nemotron-3-super',
      label: 'Nemotron-3-Super (NVIDIA)',
      role: 'master',
      enabledByDefault: true,
      description: 'Master pela NVIDIA NIM — prioritário na 1.0-flash, reserva da superagent.',
      physical: {
        nvidia: NVIDIA_MODEL_CATALOG.master,
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

  // ---------- VERSÃO ATIVA (seletor da UI — ALS > env) ----------

  private activeVersion(): PoskliVersion {
    return requestPoskliVersion() ?? normalizeVersion(STUDIO_CONFIG.router.poskliVersion)
  }

  private chainContext(difficulty?: Difficulty): ChainContext {
    return {
      baiConfigured: baiKeysPresent(),
      nvidiaConfigured: (this.providers.nvidia as NVIDIAProvider).isConfigured(),
      difficulty,
    }
  }

  /** Paradas da rota (provider + modelo físico) para um papel na versão ativa.
   *  Sandbox sem chaves B.AI: zai substitui o bai; sem NVIDIA: paradas
   *  nvidia são omitidas (rota encurta honestamente). */
  private routeEntries(
    role: RouteRole,
    difficulty?: Difficulty
  ): { entries: ChainEntry[]; version: PoskliVersion } {
    const version = this.activeVersion()
    const ctx = this.chainContext(difficulty)
    const stops = VERSION_ROUTES[version][role]
    const entries: ChainEntry[] = []
    for (const stop of stops) {
      let provider: ProviderName = stop.provider
      if (provider === 'bai' && !ctx.baiConfigured) provider = 'zai'
      if (provider === 'nvidia' && !ctx.nvidiaConfigured) continue
      const def = MODEL_REGISTRY.find((d) => d.id === LOGICAL_TO_REGISTRY[stop.model])
      if (!def) continue
      const physical = def.physical[provider]
      if (!physical) continue
      const llm = this.providers[provider]
      if (!llm) continue
      entries.push(
        stop.onRateLimit
          ? { provider, llm, model: physical, onRateLimit: stop.onRateLimit }
          : { provider, llm, model: physical }
      )
    }
    return { entries, version }
  }

  /** Mapeia papel do agente → papel da rota (testes usam review; github usa master). */
  private routeRoleOf(role: ModelRole): RouteRole | null {
    switch (role) {
      case 'master':
      case 'github':
        return 'master'
      case 'coding':
        return 'coding'
      case 'review':
      case 'testing':
        return 'review'
      default:
        return null // deepseek e papéis especiais: caminho legado
    }
  }

  /** Modelo lógico PRINCIPAL do papel na versão ativa (auditoria/DB). */
  modelForRole(role: ModelRole): string {
    if (role === 'deepseek') return STUDIO_CONFIG.models.deepseek
    const r3 = this.routeRoleOf(role)
    if (r3) {
      const version = this.activeVersion()
      const stops = VERSION_ROUTES[version][r3]
      const first = stops[0]
      if (first) return LOGICAL_TO_REGISTRY[first.model]
    }
    return STUDIO_CONFIG.models.master
  }

  /** Disponibilidade do modelo (rota do papel funcional + regras). */
  async isModelAvailable(modelId: string): Promise<{ available: boolean; reason?: string }> {
    const def = MODEL_REGISTRY.find((m) => m.id === modelId)
    if (!def) return { available: false, reason: 'modelo não registrado' }

    if (def.id === STUDIO_CONFIG.models.deepseek && def.role === 'deepseek') {
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
      return { available: true }
    }

    const r3 = this.routeRoleOf(def.role)
    if (!r3) return { available: false, reason: `papel ${def.role} sem rota (versão ${this.activeVersion()})` }
    const { entries, version } = this.routeEntries(r3)
    const logicalKey = (Object.keys(LOGICAL_TO_REGISTRY) as LogicalModelKey[]).find(
      (k) => LOGICAL_TO_REGISTRY[k] === def.id
    )
    const inRoute = VERSION_ROUTES[version][r3].some((s) => s.model === logicalKey)
    if (!inRoute) {
      return {
        available: false,
        reason: `modelo fora da rota ${r3} da versão ${version} (master/coding/review são definidos por versão)`,
      }
    }
    if (entries.length === 0) {
      return { available: false, reason: `nenhuma parada da rota ${r3} está configurada (versão ${version})` }
    }
    for (const e of entries) {
      try {
        if (await e.llm.isAvailable()) return { available: true }
      } catch { /* parada indisponível — tenta a próxima da rota */ }
    }
    return { available: false, reason: 'paradas da rota indisponíveis' }
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
   * Chamada por PAPEL: percorre a rota da versão ativa com failover
   * CONTROLADO + política anti-rate-limit (429 → backoff/smart-fallback;
   * 3x 429 → QUOTA_EXHAUSTED que PARA o run — nunca corrige quota).
   */
  async chatRole(
    role: ModelRole,
    messages: ChatMessage[],
    opts?: { temperature?: number; maxTokens?: number; difficulty?: Difficulty }
  ): Promise<CompletionResult> {
    const r3 = this.routeRoleOf(role)
    if (!r3) {
      // papéis sem rota (deepseek legado): caminho direto por modelo
      return this.chat(this.modelForRole(role), messages, opts)
    }
    const { entries, version } = this.routeEntries(r3, opts?.difficulty)
    if (entries.length === 0) {
      throw Object.assign(
        new Error(`PROVIDER_AUSENTE: nenhuma parada da rota ${r3} configurada (versão ${version})`),
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
          `[ModelRouter] failover da rota ${r3}: ${entries[0]?.provider} → ${executed.provider} (versão ${version})`
        )
      }
      await this.recordUsage(this.modelForRole(role), result)
      return result
    } catch (err) {
      await this.recordUsage(this.modelForRole(role), null, true)
      throw err
    }
  }

  /**
   * Chamada por MODELO LÓGICO (legado/compat): o modelo deve participar
   * da rota do seu papel na versão ativa; a execução percorre a rota
   * completa (failover + anti-rate-limit idênticos ao chatRole).
   */
  async chat(
    modelId: string,
    messages: ChatMessage[],
    opts?: { temperature?: number; maxTokens?: number; difficulty?: Difficulty }
  ): Promise<CompletionResult> {
    const def = MODEL_REGISTRY.find((m) => m.id === modelId)
    if (!def) throw Object.assign(new Error(`MODELO_DESCONHECIDO: ${modelId}`), { code: 'UNAVAILABLE' })

    // DeepSeek como PAPEL emergência (legado): gated por regras de negócio
    if (def.id === STUDIO_CONFIG.models.deepseek && def.role === 'deepseek') {
      const gate = await this.isModelAvailable(def.id)
      if (!gate.available) {
        throw Object.assign(new Error(`DEEPSEEK_BLOQUEADO: ${gate.reason}`), { code: 'DISABLED' })
      }
      const provider = baiKeysPresent() ? this.providers.bai : this.providers.zai
      const physical = def.physical[baiKeysPresent() ? 'bai' : 'zai']
      if (!physical) {
        throw Object.assign(
          new Error(`PROVIDER_AUSENTE: ${modelId} sem modelo físico no provider primário`),
          { code: 'UNAVAILABLE' }
        )
      }
      await this.throttle()
      const result = await provider.complete({
        messages,
        temperature: opts?.temperature,
        maxTokens: opts?.maxTokens,
        model: physical,
      })
      await this.recordUsage(modelId, result)
      return result
    }

    // Modelos de rota: delega para a rota do papel (comportamento unificado)
    const r3 = this.routeRoleOf(def.role)
    if (!r3) {
      throw Object.assign(new Error(`MODELO_SEM_ROTA: ${modelId}`), { code: 'UNAVAILABLE' })
    }
    return this.chatRole(r3 === 'master' ? 'master' : r3 === 'coding' ? 'coding' : 'review', messages, opts)
  }

  /**
   * Fallback CONTROLADO para DeepSeek (legado) — somente quando:
   * habilitado + dificuldade difícil + falha dos modelos da rota.
   */
  async chatWithDeepseekFallback(
    primaryRole: ModelRole,
    messages: ChatMessage[],
    opts?: { temperature?: number; maxTokens?: number; difficulty?: 'easy' | 'medium' | 'hard' }
  ): Promise<{ result: CompletionResult; usedFallback: boolean }> {
    try {
      const result = await this.chatRole(primaryRole, messages, opts)
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

  /** Snapshot para a UI (Models/Usage) — sem secrets.
   *  A versão exibida é a do contexto ALS (seletor da UI) ou a env. */
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
      routes: {
        master: VERSION_ROUTES[version].master.map((s) => `${s.provider}:${s.model}`),
        coding: VERSION_ROUTES[version].coding.map((s) => `${s.provider}:${s.model}`),
        review: VERSION_ROUTES[version].review.map((s) => `${s.provider}:${s.model}`),
      },
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
