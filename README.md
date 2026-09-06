# AI DEVELOPMENT STUDIO

Sistema multi-agente de desenvolvimento assistido por IA. Agentes reais com ferramentas reais: leem arquivos, escrevem código, executam testes, analisam erros, corrigem, revisam e preparam Git — dentro de workspaces isolados, com limites rígidos e evidências verificáveis.

> **Princípio da verdade:** nada é afirmado sem evidência. "Testes passaram" só existe depois de executar os testes.

---

## Arquitetura

```
USER
  ↓
MASTER AGENT (GLM-5.3-Flash)  ── análise, plano, task graph
  ↓
TASK GRAPH (grafo com dependências)
  ↓
AGENTES ESPECIALIZADOS (Qwen3.8-Flash / Hy3)
  coding · testing · review · github (+10 futuros)
  ↓
TOOL LAYER (schema, validação, permissões, auditoria)
  fs · exec · git · github
  ↓
EXECUTION PROVIDER (Local real; Docker/Remote preparados)
  ↓
ENGINEERING PERFECTION LOOP
  IMPLEMENT → TEST → ANALYZE → FIX → TEST AGAIN →
  REVIEW → (CHANGES? CREATE_FIX_TASK) → APPROVE → DONE
  ↓
PREVIEW / GIT (branches agent/*, commits verificados, PR)
```

### Estrutura

```
src/
  app/
    page.tsx                  # Studio SPA (mobile-first, única rota visível)
    api/                      # auth, projects, run, files, terminal,
                              # preview, models, agents, activity, github
  lib/studio/
    config.ts                 # limites e variáveis (server-side)
    models/                   # ModelRouter + BAIKeyManager + providers
                              # (B.AI OpenAI-compatible + SDK sandbox)
    agents/                   # definições, prompts, loop ReAct (base.ts)
    tools/                    # Tool Layer: fs, exec, git, github
    executor/                 # ExecutionProvider (local/docker/remote)
    orchestrator/             # pipeline, task graph, perfection loop,
                              # loop-detector (REPEATED_FAILURE)
    context/                  # ContextManager + Project Memory
    security/                 # path traversal, allowlist, auth, rate limit
    events/                   # event bus (DB + websocket)
    projects/                 # templates reais + workspaces isolados
    github/                   # (tools github-tools.ts)
mini-services/
  events-service/             # socket.io (3003) + ingest HTTP (3004)
prisma/schema.prisma          # 10 tabelas: users, sessions, projects,
                              # tasks, agent_runs, tool_calls, activity,
                              # settings, github_connections, model_usage
workspaces/<projectId>/       # 1 workspace isolado por projeto
```

### Modelos

| Papel | Modelo (env) | Estado |
|---|---|---|
| Master/Orquestrador | GLM-5.3-Flash (`GLM_MODEL`) | ativo |
| Coding | Qwen3.8-Flash (`QWEN_MODEL`) | ativo |
| Review/QA | Hy3 (`HY3_MODEL`) | ativo |
| Fallback difícil | DeepSeek-V4-Flash (`DEEPSEEK_MODEL`) | **DESATIVADO** (`ENABLE_DEEPSEEK=false`) |

Todos os modelos são acessados por um **chain de providers** definido pela versão do Poskli (`POSKLI_VERSION` — ou pelo **seletor de modelos** da UI, que envia `poskliVersion` por requisição e sobrepõe a env):

| Versão | Master | Coding | Review | Comportamento em 429 |
|---|---|---|---|---|
| 0.1 | Qwen (B.AI) | Hy3 (B.AI) | Qwen (B.AI) | backoff 5s/10s/20s (máx 3) → `QUOTA_EXHAUSTED` |
| 0.2 (default) | GLM 5.3 Flash | Qwen 3.8 Flash → DeepSeek V4 (NVIDIA) | Hy3 → GPT-OSS-20B (NVIDIA) | backoff 3 tentativas → `QUOTA_EXHAUSTED` |
| 0.3.1 | Hy3 (B.AI) | Qwen → **GLM imediato** (mesma conta) | **GPT-OSS-20B (NVIDIA)** → GPT-5.6 Luna (B.AI) | smart-fallback por parada |
| 1.0-flash | **Nemotron 3 Super (NVIDIA)** | **DeepSeek V4 Flash (NVIDIA)** → Qwen (B.AI) | **GPT-OSS-20B (NVIDIA)** → Luna (B.AI) | NVIDIA: 1 retry (5s) → B.AI reserva |
| superagent | GLM (B.AI) → Nemotron (NVIDIA) | **Hy3 → Qwen (dupla)** → DeepSeek (NVIDIA) | GPT-OSS-20B (NVIDIA) → Luna (B.AI) | smart-fallback por parada |

**Review principal**: GPT-OSS-20B (NVIDIA) em 0.3.1 / 1.0-flash / superagent; fallback GPT-5.6 Luna (B.AI) apenas se o NVIDIA falhar por quota/região.

**Experiential Labs: ELIMINADA** (Tarefa C) — o provider, env vars (`EXPLABS_*`) e as versões `expposkli-1.0`/`expposkli-1.1` foram removidos por completo do código e da UI.

### Estratégia anti-rate-limit (Tarefa C)

- **Backoff progressivo em 429**: 5s → 10s → 20s (máx 3 tentativas no mesmo modelo). Após a 3ª falha, o run **para imediatamente** com `QUOTA_EXHAUSTED` — honestidade acima de tudo.
- **NUNCA correções para erros de quota**: `QUOTA_EXHAUSTED` é terminal — o orquestrador aborta o run (estado BLOCKED) sem criar tarefas de correção (economia de tokens).
- **Fallback inteligente por modelo**: 0.3.1 — Qwen 429 → GLM **imediatamente** (mesma conta B.AI); 1.0-flash — NVIDIA 429 → 1 retry → B.AI como reserva (NVIDIA é prioritário, mas não infinito).
- **Rotação de chaves B.AI**: apenas em falhas elegíveis (rede/5xx); **429 nunca rotaciona chaves**.
- **Truncagem de contexto**: outputs de ferramentas (`run_tests`, `run_command`, `read_file`, …) são cortados em **2.000 chars** com o marcador `[Output truncado - 2k chars]` antes de ir ao LLM.
- **Correções via diff**: o agente de correção recebe apenas o **diff** (linhas alteradas) + erro resumido — nunca o código completo ou o histórico inteiro.
- **Ciclos de revisão reduzidos**: `MAX_REVIEW_CYCLES` = **1** para tarefas simples, **2** para difíceis (jogos/apps complexas) — derivado do pedido automaticamente.

- **B.AI** (`BAI_API_KEY_1`/`BAI_API_KEY_2`) com **BAIKeyManager** — failover controlado:

- `KEY 1` → falha **elegível** (rede, 5xx, timeout, 401) → `KEY 2` → ambas falham → **erro controlado**;
- **rate limit (429) NUNCA dispara failover** (regra de uso do serviço);
- máximo de 2 tentativas HTTP por chamada (1 por chave) — **sem rotação infinita**;
- cooldown por chave após falhas elegíveis consecutivas;
- logs apenas com índice da chave e classe do erro — **a chave nunca aparece em logs, UI, código ou mensagens a modelos**.

- **NVIDIA** (`NVIDIA_API_KEY`, NIM OpenAI-compatible): master `nvidia/nemotron-3-super-120b-a12b`, coding `deepseek-ai/deepseek-v4-flash-0731`, review `openai/gpt-oss-20b` (ids validados ao vivo contra `/v1/models`).

**Seletor de modelos (UI)**: no Command Center (painel do Poskli), um dropdown com as 5 versões (**superagent** com badge violeta). A escolha é persistida em `localStorage` (`poskli-version`) e enviada ao backend no corpo (`poskliVersion`) e header (`x-poskli-version`) das chamadas Poskli; o backend valida contra `POSKLI_VERSIONS` e envelopa o run (AsyncLocalStorage) — **requisição > env `POSKLI_VERSION`**, que segue como default quando nada é enviado. Valor inválido explícito → `400` honesto. Valores antigos (ex.: `expposkli-1.0`) são ignorados na leitura do localStorage.

Failover entre providers (ProviderChain — `src/lib/studio/models/chain.ts`): falhas **elegíveis** (rede/5xx/timeout/401-403) avançam no chain; 429 segue a **política anti-rate-limit** por parada (switch-now / retry-then-switch / retry-backoff — ver acima); `CLIENT_ERROR`/`UNKNOWN` não avançam (conservador). Sem chaves B.AI no sandbox, o SDK local (`z-ai`) substitui o B.AI — a arquitetura de agentes não muda.

DeepSeek só é usado se: explicitamente habilitado + problema difícil + modelos gratuitos falharam + limite diário não atingido. O `ModelRouter` bloqueia qualquer uso acidental. O sistema funciona **completamente sem DeepSeek**.

### Banco de dados — Neon PostgreSQL

- Prisma `provider = "postgresql"`, connection string **exclusivamente** via `DATABASE_URL` (env);
- migrations em `prisma/migrations/` (init completo, 10 tabelas);
- nunca hardcode, nunca `NEXT_PUBLIC_DATABASE_URL`, nunca em logs;
- economia de créditos: registro agregado de uso por modelo (`ModelUsage`) com limites configuráveis (chamadas por tarefa, retries, ciclos de review, tool calls, tamanho de contexto) e detecção de loops.

### Segurança

- Autenticação por sessão (scrypt, tokens opacos hasheados)
- Isolamento de workspace por projeto/usuário (nenhuma API acessa projeto alheio)
- Path traversal protection em TODA operação de arquivo
- Command allowlist — negação por padrão (deny-first)
- Timeouts, limites de memória/saída/arquivos/processos
- Rate limiting (API, pipelines, terminal)
- Secrets só no servidor (nunca `NEXT_PUBLIC_*`)
- Eventos sanitizados (tokens/passwords/apikeys redigidos)
- Push direto em `main` bloqueado no GitAgent

### Loop infinito: IMPOSSÍVEL por construção

`MAX_AGENT_STEPS` · `MAX_TASK_ATTEMPTS` · `MAX_REVIEW_CYCLES` · `MAX_TOOL_CALLS` · `MAX_TOTAL_EXECUTION_TIME` · `REPEATED_FAILURE_THRESHOLD` (mesma assinatura de erro N vezes → para, muda estratégia, reporta).

### Templates de projeto (código real e testável)

`MINI_GAME` `GAME_2D` `LANDING_PAGE` `WEB_APP` `PWA` `API` `EMPTY_PROJECT` — cada um com arquivos funcionais, testes node:test e preview servido do próprio workspace.

---

## Rodando

```bash
cp .env.example .env       # preencha DATABASE_URL (Neon), BAI_API_KEY_1/2, AUTH_SECRET
npm install
npx prisma generate         # gera o client PostgreSQL
npx prisma migrate deploy   # aplica as migrations
npm run dev                 # studio em :3000
cd mini-services/events-service && bun install && bun run dev   # eventos (3003/3004, opcional)
```

Abra o Studio, registre-se, crie um projeto e escreva na barra de comando:

> "Cria um mini-game 2D de sobrevivência para celular."

O Master planeja, os agentes implementam, testam de verdade e revisam.

## Deploy (Vercel + Neon) — futuro próximo

1. Importe o repositório na Vercel;
2. Configure as Environment Variables: `DATABASE_URL` (Neon), `BAI_API_KEY_1`, `BAI_API_KEY_2`, `AUTH_SECRET`, `BAI_BASE_URL`, modelos (`GLM_MODEL`...);
3. `npx prisma migrate deploy` (a Vercel roda o build; a migration pode ser aplicada via Neon ou um passo de build);
4. Testes pós-deploy.

Sem configurações específicas de Vercel por enquanto — projeto preparado como Next.js padrão (`output: standalone`).

## Segurança de credenciais (regras rígidas)

- `BAI_API_KEY_1/2`, `DATABASE_URL`, `GITHUB_TOKEN`: **somente servidor**;
- nunca `NEXT_PUBLIC_*` para secrets; nunca em logs; nunca enviados a modelos; nunca commitados (`.env` é gitignored; `.env.example` contém apenas placeholders);
- GitHub: preferir credencial temporária rotacionável; integração futura via OAuth ou GitHub App.

## Estado atual (honesto)

- ✅ Funcional: auth, workspaces isolados, templates, ModelRouter, agentes ReAct, tool layer com auditoria, perfection loop, task graph, eventos em tempo real, preview, terminal allowlisted, dashboard mobile-first
- 🚧 Git/GitHub: operações locais funcionais; push/PR requerem `GITHUB_TOKEN` (o agente informa honestamente quando não configurado)
- 🐳 Docker/Remote sandbox: interfaces prontas, implementação futura (`EXECUTION_PROVIDER`)

## Repositório oficial

https://github.com/criandojogodenovo-sketch/AI-Development-Studio
