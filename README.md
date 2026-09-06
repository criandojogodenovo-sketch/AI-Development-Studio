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

Todos os modelos são acessados por um **chain de providers** definido pela versão do Poskli (`POSKLI_VERSION`):

| Versão | Chain |
|---|---|
| 0.1 | B.AI |
| 0.2 (default) | B.AI → NVIDIA |
| 0.3.1 | B.AI → NVIDIA → Experiential (tarefas difíceis) |
| 1.0-flash | NVIDIA → Experiential → B.AI (reserva) |

- **B.AI** (`BAI_API_KEY_1`/`BAI_API_KEY_2`) com **BAIKeyManager** — failover controlado:

- `KEY 1` → falha **elegível** (rede, 5xx, timeout, 401) → `KEY 2` → ambas falham → **erro controlado**;
- **rate limit (429) NUNCA dispara failover** (regra de uso do serviço);
- máximo de 2 tentativas HTTP por chamada (1 por chave) — **sem rotação infinita**;
- cooldown por chave após falhas elegíveis consecutivas;
- logs apenas com índice da chave e classe do erro — **a chave nunca aparece em logs, UI, código ou mensagens a modelos**.

- **NVIDIA** (`NVIDIA_API_KEY`, NIM OpenAI-compatible): master `nvidia/nemotron-3-super-120b-a12b`, coding `deepseek-ai/deepseek-v4-flash-0731`, review `openai/gpt-oss-20b` (ids validados ao vivo contra `/v1/models`).
- **Experiential Labs** (`EXPLABS_API_KEY`): master `gpt-6-astra` (com retry regional para `claude-fable-5.1`), coding/review `claude-fable-5.1`.

Failover entre providers (ProviderChain — `src/lib/studio/models/chain.ts`): falhas **elegíveis** (rede/5xx/timeout/401-403) avançam no chain; **429 nunca**; `CLIENT_ERROR`/`UNKNOWN` não avançam (conservador). Sem chaves B.AI no sandbox, o SDK local (`z-ai`) substitui o B.AI — a arquitetura de agentes não muda.

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
