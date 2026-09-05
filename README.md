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
    models/                   # ModelRouter + providers (ZAI real)
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

| Papel | Modelo | Estado |
|---|---|---|
| Master/Orquestrador | GLM-5.3-Flash | ativo |
| Coding | Qwen3.8-Flash | ativo |
| Review/QA | Hy3 | ativo |
| Fallback difícil | DeepSeek-V4-Flash | **DESATIVADO** (`ENABLE_DEEPSEEK=false`) |

DeepSeek só é usado se: explicitamente habilitado + problema difícil + modelos gratuitos falharam + limite diário não atingido. O `ModelRouter` bloqueia qualquer uso acidental.

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
cp .env.example .env       # configure AUTH_SECRET e GITHUB_TOKEN (opcional)
bun run db:push            # cria o banco SQLite
bun run dev                # studio em :3000
cd mini-services/events-service && bun install && bun run dev   # eventos (3003/3004)
```

Abra o Studio, registre-se, crie um projeto e escreva na barra de comando:

> "Cria um mini-game 2D de sobrevivência para celular."

O Master planeja, os agentes implementam, testam de verdade e revisam.

## Estado atual (honesto)

- ✅ Funcional: auth, workspaces isolados, templates, ModelRouter, agentes ReAct, tool layer com auditoria, perfection loop, task graph, eventos em tempo real, preview, terminal allowlisted, dashboard mobile-first
- 🚧 Git/GitHub: operações locais funcionais; push/PR requerem `GITHUB_TOKEN` (o agente informa honestamente quando não configurado)
- 🐳 Docker/Remote sandbox: interfaces prontas, implementação futura (`EXECUTION_PROVIDER`)

## Repositório oficial

https://github.com/criandojogodenovo-sketch/AI-Development-Studio
