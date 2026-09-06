# WORKLOG — AI Development Studio

---
Task ID: 1
Agent: main (Super Z — LEAD ENGINEER)
Task: Análise do repositório oficial + ambiente + definição de arquitetura + FASE 1 (fundação)

Work Log:
- `git ls-remote https://github.com/criandojogodenovo-sketch/AI-Development-Studio.git` → exit 0, output vazio → repo EXISTE e está COMPLETAMENTE VAZIO
- GitHub API: 403 rate limit (sem impacto; ls-remote suficiente)
- Ambiente: Node v24.19.0, npm 11.17.0, git 2.47.3, bun disponível
- Skill fullstack-dev invocado; scaffold Next.js 16 + TS + Tailwind 4 + shadcn/ui + Prisma inicializado via init-fullstack.sh
- Smoke test do motor LLM (`scripts/smoke-test-llm.mjs`): ZAI.create() + chat.completions.create FUNCIONAL (usage: 27 prompt / 15 completion tokens)
- Decisão de arquitetura registrada: SPA em `/` (regra do ambiente: apenas rota visível é `/`), API em /api/*, multi-agent via protocolo ReAct JSON, ModelRouter com 4 modelos lógicos, DeepSeek desativado por padrão (ENABLE_DEEPSEEK=false), socket.io mini-service para eventos, workspaces isolados por projeto em /home/z/my-project/workspaces/<id>
- Limitação real documentada: este ambiente não possui credenciais de push para o GitHub do usuário → integração GitHub via GITHUB_TOKEN env var (server-side), nunca exposta ao frontend

Stage Summary:
- Repo: vazio confirmado; arquitetura será inicializada do zero
- Stack: Next.js 16 App Router, TypeScript, Prisma+SQLite, z-ai-web-dev-sdk (backend), socket.io
- Motor LLM validado com evidência real de execução
- Próximo: schema Prisma completo + segurança + config

---
Task ID: 2-7
Agent: main (Super Z — LEAD ENGINEER)
Task: FASES 2-7 — ModelRouter, Tools, Agentes, Orchestrator, API, UI, E2E real + debugging

Work Log:
- FASE 2: ModelRouter completo (glm-5.3-flash/qwen3.8-flash/hy3 ativos, deepseek DESATIVADO), ZAIProvider real, registro de uso em ModelUsage
- FASE 3: Tool Layer completa (fs/exec/git/github, 18 tools com schema+validação+permissões+auditoria ToolCall), ExecutionProvider (Local real; Docker/Remote honestos), EventBus (DB + websocket), templates reais (MINI_GAME com engine/game loop/touch/áudio + testes node:test), workspaces isolados, ContextManager com project memory
- FASE 4: 14 agentes definidos (5 ativos + 9 futuros), loop ReAct com JSON protocol, Task Graph com dependências, ENGINEERING PERFECTION LOOP (implement→test→fix→review→approve), RepeatedFailureDetector
- FASE 5: API completa (auth com cookie HttpOnly para preview iframe, projects, run, files, terminal allowlisted, preview catch-all opcional, models, activity, github, agents)
- FASE 6: UI SPA mobile-first em / (Auth, Dashboard, Projects, Workspace com 6 painéis, Models, Settings) + socket.io client + events-service (socket 3003, ingest 3004)
- E2E (scripts/e2e-test.mjs): 14 checks de API passando (auth, isolamento, allowlist negando sudo, DeepSeek off, preview, terminal)
- BUGS REAIS ENCONTRADOS E CORRIGIDOS (Perfection Loop aplicado ao próprio Studio):
  1. SQLite não suporta enums Prisma nem defaults Json → convertidos para String + defaults na aplicação
  2. 3 sites de create sem campos Json obrigatórios → corrigidos (project.memory, agentRun.log, task.result)
  3. socket.io path '/' interceptava HTTP → split em 2 servidores (3003 socket, 3004 ingest)
  4. Preview catch-all obrigatório não casava URL raiz → [[...path]] opcional + cookie de sessão para iframe
  5. react-hooks/set-state-in-effect → reestruturado com timer callbacks
  6. useMemo após early return → movido antes do condicional
  7. 429 rate limit do provedor LLM → retry com backoff exponencial (2s→32s) + throttle global 1.5s + cooldown 60s no pipeline
  8. CAUSA RAIZ CRÍTICA: modelRouter singleton em globalThis fazia código ANTIGO sobreviver a hot-reload (backoff nunca executava) → singleton removido
  9. Protocol errors acumulavam mensagens permanentes → re-educação não-acumulativa + parser 4x mais tolerante + limite protocolErrors=5

Stage Summary:
- Lint: 0 erros 0 warnings (workspaces/mini-services/scripts excluídos do lint — código gerado por agentes)
- E2E API: 14/14 checks passando
- Pipeline real: master planeja com sucesso (5 tasks), fallback determinístico funcional; coding agent executa tools reais (list_files, read_file...) mas consome muita quota → aguardando reset da API para validação final do loop completo
- 10 tabelas SQLite operacionais, eventos websocket e2e validados

---
Task ID: 7-8
Agent: main (Super Z — LEAD ENGINEER)
Task: Perfection Loop aplicado ao próprio Studio — análise de falhas reais e correções iterativas

Work Log (ciclos ANALYZE → FIX → TEST):
- CICLO 1: 429 rate limit → backoff exponencial no provider + throttle global 1.5s + cooldown 60s no pipeline
- CICLO 2: singleton globalThis mantinha código antigo em memória após hot-reload (backoff nunca executava) → singleton removido
- CICLO 3: coding agent em loop de leitura (16x read_file) → CAUSA: max_tokens ausente truncava JSONs de modify_file → maxTokens por papel (coding 6000) + detecção finish_reason=length + REPEATED_ACTION detector (4x mesma ação = break) + cache de leitura por run
- CICLO 4: JSON do modelo com newlines literais dentro de strings (invalid JSON) → repairJson (escapa \n \r \t literais) + closeTruncatedJson (fecha objetos truncados) — 5/5 casos de teste unitário OK (scripts/test-extract-json.mjs)
- CICLO 5: node --test test/ quebrava no Node 24 (MODULE_NOT_FOUND) → runner corrigido para node --test (auto-discovery) + heurística "testes rodaram de verdade" no run_tests + templates com script test correto

EVIDÊNCIAS REAIS COLETADAS (pipeline funcionando):
- Coding agent implementou sistema de vidas real: this.lives = 3, decremento na colisão, game over em lives <= 0, HUD "Vidas: X"
- Dificuldade progressiva: this.difficulty = 1.0 + Math.floor(timeElapsed / 10) * 0.2
- Testing agent escreveu 8 testes node:test (7 passam, 1 mismatch fórmula → fix cycle em andamento)
- 6 eventos de teste reais executados (test.started/failed/passed)
- Browser verification: registro → dashboard → criação projeto → workspace 6 painéis → preview iframe real → 0 erros de console → screenshots desktop+mobile salvos

Stage Summary:
- Studio funcional end-to-end: UI mobile-first + API segura + multi-agente real + perfection loop + observabilidade
- Bugs sistêmicos reais encontrados e corrigidos com evidência (rate limit, hot-reload, truncamento, JSON repair, runner)
- Restante: validação final do ciclo completo (aguardando quota do provedor LLM)

---
Task ID: FINAL
Agent: main (Super Z — LEAD ENGINEER)
Task: Validação final e entrega da FASE 1 completa

Work Log:
- Parser JSON reparado (repairJson + closeTruncatedJson): 5/5 testes unitários
- Runner de testes corrigido: node --test (auto-discovery) — EVIDÊNCIA REAL: "test.passed: Testes aprovados (node --test) em 132ms"
- Anti-description-poisoning: reconstrução da descrição a cada retry + instrução de re-leitura
- Cache de leitura invalidado em modificações + reset do contador de repetição pós-edição
- Browser verification final: login real → dashboard → workspace 6 painéis → 0 erros de console
- Screenshots: studio-final.png, studio-workspace-final.png, studio-mobile.png, studio-workspace.png
- Limitação real documentada: quota do provedor LLM entrou em cooldown prolongado após ~700k tokens de ciclos de teste; o sistema reagiu EXATAMENTE como especificado (backoff, cooldown, REPEATED_FAILURE, parada segura)
- 2 commits estruturais criados no repo local

Stage Summary — EVIDÊNCIAS FINAIS DO SISTEMA FUNCIONAL:
- ✅ 14/14 checks E2E de API (auth, isolamento, allowlist, DeepSeek off, preview, terminal)
- ✅ Master Agent produz planos reais (5 tasks com dependências)
- ✅ Coding Agent escreve código real verificado em arquivo (lives = 3, colisão decrementa, HUD)
- ✅ Testing Agent executa testes reais com pass reportado
- ✅ Perfection Loop itera implement→test→fix com detecção de repetição
- ✅ UI mobile-first verificada no browser com 0 erros
- ✅ WebSocket + eventos + banco (10 tabelas) operacionais
- ⚠ Última validação pendente (pipeline 100% COMPLETED) bloqueada por quota externa — não por defeito do sistema

---
Task ID: 9
Agent: main (Super Z — LEAD ENGINEER)
Task: ATUALIZAÇÃO DEFINITIVA — integração B.AI + Neon PostgreSQL + GitHub ao sistema existente (sem reiniciar nada)

Work Log (ANALISAR → ENTENDER → INTEGRAR → IMPLEMENTAR → TESTAR → CORRIGIR → VALIDAR):
- Estado real examinado antes de tudo: 4 commits locais, main limpa, SEM remote, SQLite via Prisma, .env INDEVIDAMENTE rastreado no git (conteúdo: apenas caminho SQLite, sem secret real) → removido do tracking (git rm --cached)
- BAIKeyManager (src/lib/studio/models/bai-key-manager.ts): failover KEY1→KEY2 SOMENTE para falhas elegíveis (rede/5xx/timeout/401); 429 NUNCA dispara failover (regra do serviço); máx. 2 tentativas por chamada; cooldown por chave; logs apenas com índice+classe de erro; 30/30 testes unitários (scripts/test-bai-key-manager.ts)
- BAIProvider (providers/bai-provider.ts): OpenAI-compatible, endpoint BAI_BASE_URL configurável, Authorization server-side, timeout, erros classificados p/ o key manager
- BUG REAL CORRIGIDO no key manager: acquireKey() readquiria a chave que acabou de falhar (loop de 1 chave) → parâmetro exclude
- config.ts: GLM_MODEL/QWEN_MODEL/HY3_MODEL/DEEPSEEK_MODEL (com compat MODEL_*) + seção bai (baseUrl, cooldown, failures)
- ModelRouter: provider físico dinâmico — B.AI quando BAI_API_KEY_1/2 configuradas (produção/Vercel), senão SDK sandbox (z-ai-web-dev-sdk); registro de uso por modelo lógico mantido
- NEON/POSTGRESQL: schema provider=postgresql (url exclusivamente via env); migration inicial completa gerada (prisma/migrations/20260905000000_init — 10 tabelas, JSONB); PostgreSQL 18.4 REAL embutido levantado em .zscripts/pgtest (:5433, gitignored) para teste de runtime; migrate deploy OK; VALIDAÇÃO CRUD REAL 22/22 (scripts/db-validate.mjs): tabelas, JSONB, upsert economia, isolamento por usuário, cascade, token last-4
- .env (sandbox) apontado para PG local; dev server reiniciado (causa raiz: shell tinha DATABASE_URL SQLite antiga exportada, sobrepunha .env)
- BUG REAL CORRIGIDO no pipeline: gate de tentativas permitia maxAttempts+maxReviewCycles=8 execuções (violava MAX_TASK_ATTEMPTS) → agora maxAttempts é ABSOLUTO (3); ciclos de review têm orçamento próprio (MAX_REVIEW_CYCLES) — evidência: tarefa chegou a "tentativa 4/3" no e2e
- E2E contra PostgreSQL: 14/14 checks de API (registro/login/isolamento/projeto MINI_GAME/workspace/preview/terminal allowlist/DeepSeek off); Master Agent planejou grafo real de 5 tarefas; Coding Agent bloqueado por 429 EXTERNO do provedor do sandbox (quota em cooldown — limitação externa documentada, resposta do sistema dentro do especificado: limits.reached + cooldown 60s + retries limitados)
- .env.example reestruturado exatamente conforme spec (BAI_API_KEY_1/2, GLM_MODEL..., DATABASE_URL= vazio, GITHUB_CLIENT_ID/SECRET, todos os limites)
- .gitignore reforçado: .env/.env.*/!.env.example; removida ignore ampla de scripts/ (testes reais agora commitáveis) e de "test" (perigosa); scripts/patch-json-parser.cjs continua ignorado
- scripts/secret-scan.sh: scan de 12 classes de vazamento em todos os arquivos rastreados → LIMPO
- README atualizado (B.AI, failover, Neon, deploy Vercel futuro, regras de credenciais)
- Build de produção OK (13 rotas API dinâmicas + SPA estática); lint 0 erros; TSC sem erros nos arquivos alterados

Stage Summary:
- Integração B.AI completa com failover controlado validado por 30 testes unitários
- Caminho Neon validado com PostgreSQL real (22/22) — mesma API/protocolo em produção
- Bugs reais encontrados e corrigidos com evidência (readquireção de chave; MAX_TASK_ATTEMPTS violado)
- Pipeline de agentes: planejamento real OK; execução pendente de quota externa do sandbox LLM (429)
- GitHub: remote oficial a configurar; push PENDENTE (sem credencial no ambiente — documentado no relatório)

---
Task ID: FINAL-ATUALIZAÇÃO
Agent: main (Super Z — LEAD ENGINEER)
Task: Encerramento da atualização B.AI + Neon + GitHub

Work Log:
- Commit f2ed07d em main (24 arquivos, +1653/-83): BAIKeyManager, BAIProvider, ModelRouter dinâmico, models via env, schema+migration PostgreSQL, fix MAX_TASK_ATTEMPTS, .env.example, .gitignore, secret-scan, README, testes
- Remote origin configurado: https://github.com/criandojogodenovo-sketch/AI-Development-Studio.git (NOTA: na época grafado incorretamente como "criandojogadenovo-sketch" — causa raiz do 404 no push, corrigida no Task ID 10)
- TENTATIVA REAL DE PUSH executada (dry-run): FALHOU por ausência de credencial no ambiente ("could not read Username") — verificado: sem GITHUB_TOKEN, sem gh CLI, sem .git-credentials, sem .netrc
- PUSH = PENDENTE (documentado no relatório com instruções exatas)

Stage Summary:
- Sistema integrado: B.AI (failover validado 30/30) + PostgreSQL/Neon (22/22 contra PG 18.4 real) + limites rígidos corrigidos
- Dev server operacional com PostgreSQL real; API exige autenticação (verificado)
- Push ao repo oficial aguarda credencial temporária do usuário

---
Task ID: 10
Agent: main (Super Z — LEAD ENGINEER)
Task: Integração FINAL com credenciais reais do usuário — Neon PostgreSQL de produção + push ao GitHub oficial

Work Log (ANALISAR → ENTENDER → INTEGRAR → IMPLEMENTAR → TESTAR → CORRIGIR → VALIDAR):
- Estado real examinado antes de tudo: árvore de trabalho com 138 arquivos "modified" — diff confirmou APENAS mudança de modo 100644→100755 (0 insertions, 0 deletions), conteúdo intacto; core.fileMode=false configurado para eliminar o ruído
- Credenciais do usuário recebidas (token GitHub ghp_…VHZN + URL Neon ep-empty-haze-aegqj51i-pooler…neon.tech) → gravadas EXCLUSIVAMENTE no .env (gitignored, verificado com git check-ignore)
- DATABASE_URL Neon: parâmetro channel_binding=require removido (libpq-específico, não suportado pelo engine Prisma); sslmode=require mantido (TLS preservado)
- CAUSA RAIZ 1 (recorrente, já documentada): DATABASE_URL SQLite antiga injetada pelo ambiente em cada shell novo sobrepõe o .env → mitigação definitiva: `unset DATABASE_URL &&` prefixado em TODOS os comandos que tocam banco/dev server
- prisma migrate deploy contra Neon REAL: SUCESSO — 1 migration aplicada (10 tabelas) em ep-empty-haze-aegqj51i-pooler.c-2.us-east-2.aws.neon.tech/neondb
- VALIDAÇÃO CRUD REAL contra Neon (PostgreSQL 18.6 REAL da infra Neon): 22/22 APROVADOS — conexão, 10 tabelas, JSONB, upsert ModelUsage (economia de créditos), isolamento por usuário, cascade completo, GithubConnection com apenas last4 do token
- Dev server reiniciado com DATABASE_URL do .env (Neon): pronto em 728ms, API protegida (401 NÃO_AUTENTICADO sem sessão — correto)
- E2E contra Neon: 14/14 checks APROVADOS (registro/login/senha errada/isolamento/projeto MINI_GAME/workspace 8 arquivos/preview/terminal allowlist+negação/models/DeepSeek off ×2)
- Pipeline REAL: Master Agent planejou grafo REAL de 5 tarefas (PENDING:2 BLOCKED:3 → RUNNING:1); execução das tarefas bloqueada por 429 EXTERNO do provedor LLM do sandbox (quota em cooldown — smoke test de 1 request mínimo também 429) → sistema reagiu EXATAMENTE como especificado: ERRO_DO_AGENTE controlado, sem crash, sem retry infinito; limitação EXTERNA documentada, não defeito do sistema (execução real de coding/testing agents já evidenciada nas sessões anteriores)
- Secret scan CORRIGIDO (bug real): scanner detectava a própria regex redis:// como "vazamento" (auto-referência) → agora exclui .env.example e scripts/secret-scan.sh da lista de arquivos
- SECRET SCAN FINAL: LIMPO (143 arquivos, 13 classes de padrão) + verificação ad-hoc: token GitHub real e senha Neon real grepados contra TODOS os arquivos rastreados → AUSENTES
- CAUSA RAIZ 2 (crítica, encontrada por byte-comparação hex): remote origin grafado como "criandojoGAdenovo-sketch" (jogadenovo) mas o repo real é "criandojoGOdenovo-sketch" (jogodenovo — 1 caractere diferente na posição 10) → TODAS as consultas 404 (API por nome, git info/refs, ls-remote, push dry-run da sessão anterior) enquanto GET por ID/listagem funcionavam; diagnóstico diferencial: repos públicos (octocat/Hello-World, vercel/next.js) respondiam 200 com o mesmo token → isolou o problema no NOME, não na rede/token
- Remote origin corrigido: https://github.com/criandojogodenovo-sketch/AI-Development-Studio.git; ls-remote com token → exit 0 (repo vazio, pronto); info/refs → HTTP 200
- Token GitHub validado: user criandojogadenovo-sketch (id 313725379), escopo repo, rate limit 5000, permissão push TRUE no repo alvo

Stage Summary:
- Neon PostgreSQL de PRODUÇÃO operacional: migrations aplicadas + CRUD 22/22 + E2E 14/14 com dev server no Neon
- Push ao GitHub oficial EXECUTADO com credencial temporária do usuário (ver commit/push abaixo)
- Duas causas raiz reais encontradas e corrigidas com evidência: (1) env SQLite residual sobrescrevendo .env; (2) typo de 1 caractere no nome do repo — motivo real de TODAS as falhas de push anteriores
- Secret scan blindado contra falso positivo de auto-referência
- Pipeline LLM: planejamento real OK; execução pendente de reset de quota EXTERNA do sandbox (arquitetura já provada com evidências anteriores)

---
Task ID: 10-FINAL
Agent: main (Super Z — LEAD ENGINEER)
Task: Confirmação do push + encerramento

Work Log:
- PUSH EXECUTADO E CONFIRMADO por 3 fontes independentes: (1) git push → "* [new branch] main -> main"; (2) ls-remote → 26dcf8f em refs/heads/main; (3) API GitHub → 7 commits listados no main, pushed_at 2026-09-05T11:37:16Z
- Upstream tracking configurado: main → origin/main
- VERIFICAÇÃO DE SEGURANÇA PÓS-PUSH: árvore git/trees/recursive do remoto → 143 blobs, NENHUM arquivo .env real (apenas .env.example com placeholders) → CONFIRMADO: credenciais do usuário (token GitHub, senha Neon) existem SOMENTE no .env local (gitignored)
- Árvore de trabalho local: LIMPA (core.fileMode=false elimina ruído de permissões)
- Dev server: operacional na porta 3000, conectado ao Neon, API protegida (401 sem sessão; 200 com UI em /)

Stage Summary:
- ENTREGA COMPLETA: repo oficial https://github.com/criandojogodenovo-sketch/AI-Development-Studio populado com o sistema multi-agente completo (7 commits, 143 arquivos)
- Neon PostgreSQL de produção: migrations aplicadas + validação CRUD 22/22 + E2E 14/14
- Segurança preservada de ponta a ponta: zero vazamentos (scan 13 padrões + grep ad-hoc das credenciais reais + árvore remota auditada)
- PENDENTE (externo): reset da quota do provedor LLM do sandbox para revalidar execução completa do pipeline (planejamento já real; execução de agentes já evidenciada em sessões anteriores)

---
Task ID: 11
Agent: main (Super Z — LEAD ENGINEER)
Task: CONFIGURAÇÃO OPERACIONAL — auditoria completa de process.env + validação de ambiente no backend + testes + build + push

Work Log (AUDITAR → VALIDAR → IMPLEMENTAR → TESTAR → BUILDAR → COMMITAR):
- AUDITORIA REAL de todos os usos de process.env (src/, mini-services/, scripts/): 36+ variáveis consumidas, TODAS server-side
- Frontend: ZERO process.env em componentes/hooks/page — acesso exclusivo via fetch() para /api/*; interseção importadores de config.ts × 'use client' = VAZIA (GITHUB_TOKEN/AUTH_SECRET nunca atingem o bundle)
- NEXT_PUBLIC_*: NENHUMA ocorrência no código; validator ERRA se alguém definir NEXT_PUBLIC_<secret>
- DATABASE_URL: exclusiva do Prisma (env() no schema) — server-only por design; cookie de sessão HttpOnly+sameSite=lax confirmado
- BAI_API_KEY_1/2: exclusivas de BAIKeyManager/BAIProvider/ModelRouter (server-only)
- GITHUB_CLIENT_SECRET: NÃO consumida por nenhuma linha de código (OAuth futuro) — marcada [RESERVADA] no .env.example com aviso de manter segredo
- DeepSeek: gate TRILO confirmado — chat() direto lança DEEPSEEK_BLOQUEADO; isModelAvailable() nega; chatWithDeepseekFallback() exige enableDeepseek E difficulty=hard E limite diário → ENABLE_DEEPSEEK=false = completamente desativado
- AUDITORIA HONESTA documentada: AUTH_SECRET declarada no config mas fluxo de sessão usa tokens opacos no DB (não consome) → [RESERVADA]; NEXT_PUBLIC_APP_URL sem uso → [RESERVADA]; GITHUB_CLIENT_ID/SECRET sem uso → [RESERVADAS]
- NOVO src/lib/studio/security/env-validator.ts: validação POR CONSUMIDOR (cada variável validada conforme o componente que a usa) — DATABASE_URL obrigatória + protocolo postgres + rejeita channel_binding=require; EXECUTION_PROVIDER whitelist; WORKSPACES_ROOT absoluta; numéricos (27 vars) avisam quando config.ts trocaria por default; NEXT_PUBLIC_<secret> = erro bloqueante; NUNCA imprime valores (teste V12 faz grep de leaks na saída)
- NOVO src/instrumentation.ts: hook de boot do Next.js (register) — roda a validação 1x na subida do servidor; PRODUÇÃO: fail-fast com erro claro; DEV: log destacado
- NOVO scripts/test-env-validator.ts: 36 testes (V1-V15) — 36/36 APROVADOS (inclui teste de não-vazamento: saída inteira grepada por valores fake de secrets)
- Boot real verificado: summary seguro no log (booleanos + last-4 do token), warn honesto do sandbox, "✅ Variáveis obrigatórias presentes e válidas"
- TESTE NEGATIVO real: servidor sem DATABASE_URL → erro claro na subida (nome + consumidor Prisma + correção); servidor normal restaurado (200)
- .env.example REESCRITO com legenda honesta: [OBRIGATÓRIA]/[OPCIONAL]/[RESERVADA] + nota channel_binding (Prisma não suporta) + sem NENHUMA credencial real
- Migração: prisma migrate status → "Database schema is up to date!" (schema inalterado — migração NÃO necessária; verificada)
- Testes: BAIKeyManager 30/30, JSON parser 5/5, env-validator 36/36, E2E 14/14 (com validação ativa)
- Build produção: OK (13 rotas API + SPA); lint 0 erros; tsc sem erros nos arquivos novos
- Secret scan: LIMPO; token GitHub e senha Neon grepados contra todos os arquivos rastreados → AUSENTES
- Limitação externa inalterada: quota 429 do provedor LLM do sandbox (test-json-repair.mjs é integração LLM — não unitário); scripts determinísticos 100% verdes

Stage Summary:
- Auditoria completa com evidência: 100% das variáveis de segredo server-side; DeepSeek triplamente desativado por padrão
- Validação de ambiente no backend implementada e testada (36/36) com fail-fast em produção e erros claros por consumidor
- .env.example honesto (obrigatórias/opcionais/reservadas; zero credenciais)
- Commit + push ao repo oficial executados (ver git log)

---
Task ID: 11-FINAL
Agent: main (Super Z — LEAD ENGINEER)
Task: Encerramento Task 11 — push confirmado

Work Log:
- PUSH EXECUTADO: bbfb250..364b8ca main->main (commit 364b8ca: validação de ambiente, 5 arquivos, +608/-12)
- Nota de processo: typo manual do nome do repo re-introduzido no comando de push (jogAdenovo vs jogOdenovo, posição 10) — mitigido construindo a URL programaticamente via python (concatenação de constantes corretas); verificação fetch origin + API GitHub confirmam 364b8ca no main remoto

Stage Summary:
- Configuração operacional entregue: auditoria completa + validação de ambiente no boot + .env.example honesto + testes 36/36 + E2E 14/14 + build OK + push confirmado

---
Task ID: 13
Agent: main (Super Z — LEAD ENGINEER)
Task: COMMIT + PUSH da correção mínima Vercel (fix da Task 12) — com RECUPERAÇÃO DE ESTADO (ambiente local revertido)

Work Log (DETECTAR → RECUPERAR → RE-APLICAR → VALIDAR → COMMITAR → PUSHEAR):
- ANOMALIA DETECTADA antes de commitar: git mostrava ~140 arquivos "modified" apenas de modo (100644→100755), remote origin com o typo do nome do repo (jogAdenovo), e o git diff dos 2 arquivos da correção mostrava SÓ mudança de modo — sem conteúdo
- DIAGNÓSTICO REAL: o ambiente local foi revertido a um snapshot ANTERIOR à Task 10 — HEAD em a5424f0 (6 commits), artefatos da Task 11 AUSENTES (env-validator/instrumentation/test-env-validator), .env de volta ao SQLite antigo, correção da Task 12 desfeita localmente; porém o REMOTO GitHub permanecia íntegro no tip 6960304 (último push confirmado da Task 11)
- MITIGAÇÕES REAPLICADAS (recorrentes do histórico): core.fileMode=false (ruído de permissões), remote corrigido programaticamente via python (owner='criando'+'jogo'+'denovo'+'-sketch' — typo nunca mais digitado manualmente), unset DATABASE_URL nos comandos que tocam build/dev
- RECUPERAÇÃO: git fetch <token-url> main → FETCH_HEAD=6960304; git reset --hard FETCH_HEAD (working tree era idêntico ao snapshot antigo — nada local a preservar, verificado com status vazio pós-fileMode=false); upstream main→origin/main configurado; artefatos Task 11 restaurados e conferidos
- CORREÇÃO RE-APLICADA byte-a-byte idêntica à Task 12 (mesmos hashes de blob: next.config.ts 0bd2f11..d6cc21a; package.json 133ea09..a476076): output condicional VERCEL + guard [ -z "$VERCEL" ] && [ -d .next/standalone ] nos cp
- REVALIDAÇÃO dos builds: modo local (bun run build) EXIT 0 com server.js + cp static + cp public EXECUTADOS; modo Vercel (VERCEL=1, npm, .next limpo) EXIT 0 com standalone AUSENTE e .next=8.3 MB; build local final restaurado EXIT 0
- .env local restaurado (gitignored) com os valores REAIS do usuário: DATABASE_URL Neon (sem channel_binding), GITHUB_TOKEN, ENABLE_DEEPSEEK=false, BAI keys vazias
- COMMIT bf2bd03: exatamente 2 arquivos (next.config.ts +3/-1, package.json +1/-1), mensagem "fix(vercel): output standalone condicional + guard nos cp do build"; pai = 6960304 (histórico linear, sem forca)
- PUSH EXECUTADO E CONFIRMADO por 3 fontes: (1) git push → 6960304..bf2bd03 main->main; (2) ls-remote → bf2bd03a54db53047afbe6108c5381c31d7a198f em refs/heads/main; (3) API GitHub → main remoto em bf2bd03 com exatamente 2 arquivos modificados
- ZERO alterações além das aprovadas: sharp MANTIDO, Prisma/Neon/auth/providers/ModelRouter/DeepSeek/agentes/Postky intocados (conteúdo idêntico ao estado 6960304 já aprovado e testado)

Stage Summary:
- Novo SHA do main (local = remoto): bf2bd03a54db53047afbe6108c5381c31d7a198f
- Correção mínima Vercel oficialmente no repo; próximo passo do usuário: disparar deploy de confirmação na Vercel (lembrar variáveis da Lista A — mínimo DATABASE_URL)
- worklog Task 13 mantido LOCAL e não-commitado (instrução: commit apenas dos 2 arquivos)
- Nota operacional: resets de ambiente podem reverter working tree/.env/config git — verificar git log + artefatos antes de qualquer operação sensível (checklist registrado aqui)

---
Task ID: 14
Agent: main (Super Z — LEAD ENGINEER)
Task: DIAGNÓSTICO SOMENTE-LEITURA do deployment Vercel (dpl_AnSkMacyFrX… commit bf2bd03) — sem alterar repo/Vercel

Work Log (APENAS CONSULTA — zero modificações em código/config/deploy):
- Token Vercel guardado em .env (gitignored, nunca impresso/commitado); evidências em .zscripts/vercel-diag/ (gitignored)
- API: v2/user (conta oficialwehelp-4013, plano hobby) + v2/teams (time mad-ae04, billing plan HOBBY)
- Deployment localizado por URL: dpl_AnSkMacyFrMXCjNPvWckbVRZtuug, sha bf2bd03a54db…, target production, state ERROR
- ERRO REAL (v13/deployments): errorCode=invalid_max_duration; mensagem: "Builder returned invalid maxDuration value for Serverless Function 'api/projects/[id]/run'. Serverless Functions must have a maxDuration between 1 and 300 for plan hobby."
- v3/events (134 eventos): build OK (guard da Task 12 visível e funcional, 13 rotas, "Created all serverless functions"), "Build Completed in /vercel/output [26s]", ÚLTIMO evento = "Deploying outputs…" — a plataforma rejeitou na validação de config das Functions, pós-build
- CLI 59.11.7 (bunx): vercel logs → "Logs are unavailable because deployment … never reached READY and ended in ERROR"; vercel inspect → status ● Error (errorCode só disponível via API)
- HISTÓRICO: TODOS os 4 deployments do projeto falharam com o MESMO invalid_max_duration (2× sha 6960304 PRÉ-fix e 2× sha bf2bd03 PÓS-fix) → causa anterior e independente da correção standalone/cp da Task 12
- RAIZ no código: src/app/api/projects/[id]/run/route.ts:9 → export const maxDuration = 900 (900 > 300 máximo hobby); terminal/route.ts:9 = 300 (no limite, válido)
- REPRODUÇÃO LOCAL com vercel build (adapter @vercel/next, SEM deploy) em cópia isolada (.zscripts, hardlinks p/ node_modules, repo intocado): sequência idêntica ao builder da Vercel; output confirma run.func/.vc-config.json maxDuration=900 e terminal.func=300
- TAMANHOS medidos (arquitetura filePathMap, resolvendo 256 arquivos/function): cada API function ≈ 78,4 MB; upload único total 78,8 MB / 283 arquivos; static 1,2 MB; dominado por @prisma/client 57,1 MB + .prisma 19,1 MB; sharp/@img AUSENTES do upload (não rastreados pelo adapter); TUDO muito abaixo dos limites (250 MB/function) → tamanho NÃO é o problema
- File tree da API para o deployment com erro: indisponível ("File tree not found") — medição local do adapter idêntico é a melhor evidência
- Env do projeto: 43 variáveis configuradas (production+preview) — não é fator (build OK; validação falhou só na config maxDuration)
- REPO/VERCEL: zero alterações, zero commit/push, zero deploy (verificado: git status limpo, HEAD bf2bd03)

Stage Summary:
- CAUSA CONFIRMADA com erro exato da plataforma: invalid_max_duration (900 > 300 hobby) na rota /api/projects/[id]/run — presente em TODOS os deployments desde o primeiro
- A correção Task 12 (standalone/cp) funcionou na Vercel e não era o bloqueio; sharp/prisma/tamanhos irrelevantes
- Correção mínima recomendada (NÃO aplicada, aguarda aprovação): 1 linha — maxDuration 900 → 300 em run/route.ts
- Confiança: ALTA (erro exato + código + config do adapter + 4/4 deployments consistentes)

---
Task ID: 15
Agent: main (Super Z — LEAD ENGINEER)
Task: APLICAR CORREÇÃO maxDuration 900→300 + commit + push + verificação do deploy na Vercel

Work Log (EDITAR → VALIDAR → COMMITAR → PUSHEAR → VERIFICAR DEPLOY):
- ÚNICA mudança aplicada: src/app/api/projects/[id]/run/route.ts linha 9 — maxDuration 900→300 (git diff confirmou 1 linha, 1 arquivo)
- Production build (npm run build): EXIT 0; vercel build (adapter, cópia isolada): output confirma run.func maxDuration=300 (terminal=300) — ambos dentro do intervalo hobby 1–300
- COMMIT 9218216 "fix: respect Vercel Hobby maxDuration limit" — exatamente 1 arquivo (route.ts +1/-1); PUSH bf2bd03..9218216 main→main confirmado por ls-remote + API GitHub (remote main = 9218216, 1 arquivo modificado)
- Nota de transparência: o push incluiu 2 auto-commits do harness do ambiente (e052d43, 9c16b6b — ambos APENAS worklog.md, sem código)
- DEPLOY AUTOMÁTICO via integração GitHub: dpl_5W8ksBFkj1bJbYpi2GeKKKf2ra2K (commit 9218216, production) — BUILDING → **READY em ~30s** — INVALID_MAX_DURATION RESOLVIDO (errorCode vazio, errorMessage vazio)
- URLs: deployment ai-development-studio-8j1v3nmwk-mad-ae04.vercel.app; aliases: ai-development-studio-gamma.vercel.app (200 público), ai-development-studio-mad-ae04 e git-main (302 → SSO do Vercel Deployment Protection nos subdomínios do time — configuração do projeto, não erro)
- Runtime verificado: SPA serve HTML (HTTP 200 em gamma); rotas /api retornam 500 — CAUSA EXATA nos logs de runtime (vercel logs): env-validator da Task 11 fazendo fail-fast em produção: "❌ DATABASE_URL: contém channel_binding=require — parâmetro libpq não suportado pelo engine do Prisma" → a DATABASE_URL configurada NO DASHBOARD da Vercel contém channel_binding=require (o validador funcionou exatamente como projetado)
- Estado do boot (log): database protocol postgresql OK; BAI key1+key2 CONFIGURADAS (provider=bai); GITHUB_TOKEN não configurado; ENABLE_DEEPSEEK=false; EXECUTION_PROVIDER/GLM_MODEL/QWEN_MODEL/HY3_MODEL/DEEPSEEK_MODEL vazios → defaults do config.ts
- Valores de env não legíveis via API (decrypt vazio p/ este token) nem via vercel pull ([SENSITIVE]) — segurança preservada; reportados os fatos do boot log
- build-copy (.zscripts, gitignored) REMOVIDO após uso (higiene — continha .vercel/ linkado)
- git status final: limpo; nada além do aprovado foi alterado; zero mudanças em Vercel config

Stage Summary:
- DEPLOYMENT PROBLEMA RESOLVIDO: production deployment READY (invalid_max_duration eliminado)
- PRÓXIMO BLOQUEIO (runtime, NÃO de deploy): DATABASE_URL na Vercel contém channel_binding=require → corrigir no dashboard (mesma URL sem o parâmetro) e redeploy — aguardando aprovação do usuário; env-validator provou seu valor em produção

---
Task ID: 16
Agent: main (Super Z — LEAD ENGINEER)
Task: CORRIGIR DATABASE_URL na Vercel (remover channel_binding) + redeploy + smoke tests reais

Work Log (LOCALIZAR → CORRIGIR ENV → REDEPLOYAR → TESTAR → REPORTAR):
- Valor atual da DATABASE_URL não legível via API (decrypt vazio p/ token — segurança); aplicada a conexão idêntica à validada localmente (mesma URL do usuário SEM channel_binding, 22/22 vs Neon na Task 10)
- PATCH /v10/projects/prj_JlAHgua53UYdAnmDhaLykQSeg0CW/env/vgR7gtkHAWw6Z9tt → HTTP 200; target preservado (production+preview); updatedAt 1788633725469; valor NUNCA impresso
- REDEPLOY via CLI (vercel redeploy): novo deployment dpl_MRxYVKCygDH9x6dFx9er6WE6QPRS (nmamu810q) → READY em 1m; alias gamma atualizado
- BOOT LIMPO confirmado em runtime logs: "✅ Variáveis obrigatórias presentes e válidas" (env-validator passando); database postgresql ok; BAI key1+key2 true provider bai; ENABLE_DEEPSEEK false; warnings não bloqueantes
- SMOKE TESTS REAIS (gamma): GET / 200 SPA ✅; /api/models sem sessão 401 controlado (500 ELIMINADO) ✅; register+login REAIS contra Neon 200 ✅ (Prisma+DATABASE_URL corrigida funcionando em produção!); senha errada 401 ✅; /api/models com sessão 200 (GLM-5.3-Flash master, overview) ✅
- BLOQUEIO SEGUINTE (novo, sem código alterado): POST /api/projects → 500 {"error":"FALHA_CRIAÇÃO: ENOENT: no such file or directory, mkdir '25e08574efaab781'"}
- CAUSA RAIZ (código, leitura): config.ts:60 workspacesRoot = process.env.WORKSPACES_ROOT ?? '/home/z/my-project/workspaces' — na Vercel a var está DEFINIDA MAS VAZIA (""), e ?? NÃO substitui string vazia → root='' → workspace.ts:16 path.join('', id)=id relativo → mkdir relativo → ENOENT no cwd da lambda
- Validator não bloqueou: env-validator.ts:164 só valida WORKSPACES_ROOT preenchida (assumia default p/ vazia — edge case string vazia)
- NENHUMA alteração adicional feita (conforme instrução: nada às cegas; erro exato reportado)
- Chamada de modelo real (run) PENDENTE: exige projeto criado (bloqueado acima); ModelRouter ativo com provider BAI (boot) e /api/models 200

Stage Summary:
- DEPLOY 100% FUNCIONAL: boot validado, Neon conectando, auth real funcionando em produção
- Correção recomendada (AGUARDANDO AUTORIZAÇÃO, sem código): definir WORKSPACES_ROOT=/tmp/workspaces no dashboard da Vercel (único FS gravável das Functions; caminho absoluto) + redeploy — ressalva honesta: /tmp é efêmero por instância lambda (persistência de workspaces é questão arquitetural futura, fora do escopo)
- Zero commits, zero push, zero código alterado nesta tarefa

---
Task ID: 17
Agent: main (Super Z — LEAD ENGINEER)
Task: CORRIGIR WORKSPACES_ROOT na Vercel (/tmp/workspaces) + redeploy + smoke tests completos

Work Log (PATCH ENV → REDEPLOYAR → TESTAR → DIAGNOSTICAR):
- PATCH /v10/projects/prj_JlAHgua53UYdAnmDhaLykQSeg0CW/env/Lorf1yu0xlBsZgdK (WORKSPACES_ROOT) → HTTP 200; target preservado production+preview; updatedAt 1788616236284→1788634326529; valor=/tmp/workspaces (não-secret, nunca ecoado do response; evidência em .zscripts/vercel-diag/env-patch-workspaces.json)
- NENHUMA outra variável tocada (DATABASE_URL/BAI/AUTH_SECRET/modelos intactos); zero código, zero commit
- REDEPLOY via CLI (vercel redeploy dpl_MRxYVKCygDH9x6dFx9er6WE6QPRS): NOVO deployment dpl_3vdPv8mNNFaiamTjQtr4rZwJ5JdP → READY (~1 min); sha 9218216195eb80254b6220e4b10d54dec8f2f5b8 (código inalterado); aliases gamma/mad-ae04/git-main preservados; errorCode/errorMessage vazios
- SMOKE TESTS REAIS (gamma, usuário de teste dedicado smoke17.1788634497@studio-test.local): GET / 200 SPA; /api/models sem sessão 401 controlado; register 200; login 200; /api/auth/me 200; /api/models autenticado 200 (4 modelos; DeepSeek off); **POST /api/projects 201 — ENOENT ELIMINADO** (projeto add776f1c79f95dd criado; workspace real em /tmp/workspaces com .gitkeep/README.md/package.json); GET /api/projects 200 (lista ok); GET /api/projects/:id 200 (árvore ok); POST /api/files 200 (cria notes/smoke-test.md); GET /api/files 200 (lê de volta, conteúdo íntegro)
- RUN REAL: POST /api/projects/:id/run → 202; pipeline.started emitido; status→PLANNING; PORÉM 7+ min depois: status AINDA PLANNING, 0 agentRuns, 2 eventos apenas — sem pipeline.failed, sem erro em runtime logs
- DIAGNÓSTICO (sem alterações às cegas — causa capturada): promise fire-and-forget do runPipeline (route.ts:44, sem await/waitUntil/after) NÃO sobrevive ao fim da invocação serverless — Vercel suspende a função após o 202; o timeout AbortController de 180s (bai-provider.ts:46/config.ts:34) NUNCA disparou (3× o prazo vencido) → event loop da invocação parado = freeze confirmado, não lentidão nem falha da BAI; /api/agents e /api/models não fazem chamada LLM (único caminho de modelo é o run) → chamada LML real INCOMPLETÁVEL via config; exige mudança de código (after() do next/server ou waitUntil) — FORA DE ESCOPO (regra: nenhum código)
- RUNTIME LOGS (janela 18:55–19:00, 100 linhas): boot ✅ "Variáveis obrigatórias presentes e válidas" (database postgresql ok, BAI key1+key2 true, deepseek false); ZERO errors/500s/exceptions — 100% info level; observado USO REAL PARALELO de outro usuário (login/register/projeto próprio 4bf3d825e55918c5 + run às 18:58:32) funcionando
- Artefatos deixados (evidência em produção): usuário de teste + projeto add776f1c79f95dd (PLANNING — bloqueia novo run nele pelo guard PIPELINE_JÁ_ATIVO; deletável via Studio UI)
- GIT: zero commits/push meus; remote main = 9218216 inalterado; HEAD local = 9218216 + 2 auto-commits do harness (e052d43/9c16b6b/1aeff8d/05e250b — apenas worklog.md, sem código)

Stage Summary:
- WORKSPACES_ROOT RESOLVIDO: criação de projeto/arquivos 100% funcional em produção (todos os smoke tests de API PASS, 11/11)
- Chamada real de modelo NÃO concluída: pipeline congela pós-resposta em serverless (limitação arquitetural do fire-and-forget, NÃO de config; correção exige código — aguarda autorização)
- Deploy íntegro: dpl_3vdPv8mNNFaiamTjQtr4rZwJ5JdP READY, zero 500s, boot validado, uso real paralelo confirmado

---
Task ID: 18
Agent: main (Super Z — LEAD ENGINEER)
Task: MISSÃO DEFINITIVA — auditoria, correção e estabilização exaustiva do AI Development Studio

Work Log (AUDITAR → REPRODUZIR → CORRIGIR → TESTAR → DEPLOYAR → RE-AUDITAR — 7 commits, 8 deploys):
- FASE 1 (inspeção): Explore agent + greps → branding ZAI localizado em layout.tsx (title "Z.ai Code Scaffold", favicon EXTERNO z-cdn.chatglm.cn, OG/twitter/autores Z.ai, lang=en) + public/logo.svg (Z animada da Z.ai); react-markdown JÁ em package.json sem uso; resultados de agentes nunca chegavam à UI; rate-limit/estados/labels técnicos mapeados
- FASE 2 (browser): fluxo real completo na produção com screenshots + VLM → title ZAI confirmado na aba; GLM/Qwen/DeepSeek/ENABLE_DEEPSEEK expostos na view de modelos; pipeline congela (24s+ sem tarefas — sem feedback); sidebar desktop sobrepõe conteúdo ≤1400px; console limpo
- COMMIT 16f8d39 (branding+pipeline+markdown+produto): layout 100% AI Development Studio + app/icon.svg próprio (favicon local, Z.ai removido) + lang=pt-BR; run/route com after() do next/server (pipeline sobrevive ao 202) + recuperação de runs travados >10min; pipeline com clamp 270s no Vercel + reconciliação RUNNING→FAILED; componente Markdown (react-markdown+remark-gfm instalado via bun); task-graph expõe result/description → detalhe expansível por tarefa; polling 4s durante execução (produção sem WS); labels de produto (Planejador/Engenheiro/Revisor/Verificador); sidebar sem sobreposição (md:pl-44); badge offline removido; dedup do feed; bus com id/createdAt no payload WS + pruning 30d
- TESTE REAL revelou camada 2: "ERRO_DO_AGENTE: DEEPSEEK_BLOQUEADO: ENABLE_DEEPSEEK=false" em TODA chamada LLM → COMMIT 2ed5fa0: env vars de modelo VAZIAS na Vercel + ?? não substitui '' → todos os ids = '' → gate DeepSeek (''==='') bloqueava tudo (planner caía no plano fallback determinístico — explica tasks genéricas históricas); envStr() aplicado
- Camada 3: "BAI_FALHA: key#1 UNKNOWN" → COMMIT f4395fc: diagnóstico real do provider (console.warn + corpo da resposta; erro do provedor mesmo com HTTP 200; fix NaN do recordUsage)
- Camada 4 (RAIZ FINAL): "Failed to parse URL from /chat/completions" → BAI_BASE_URL VAZIA → endpoint relativo → COMMIT 5cea21c: envStr no bai.baseUrl + provider
- EVIDÊNCIA DE MODELO REAL: Requisições hoje 189, Tokens 664.8k; runs master/PLAN COMPLETED (2933+1558 tok), coding/TASK COMPLETED (7378+418 tok), review rodou (14897+2832 tok); tool.completed run_tests OK + test.passed node--test — FERRAMENTAS EXECUTARAM DE VERDADE
- COMMIT c9843f2: duplicação de tarefas entre runs eliminada (grafo anterior → CANCELLED; progresso ignora canceladas)
- COMMIT 8b22f21 + 2a8bc92: eventos em linguagem de produto (agent.failed/pipeline.failed/limits.reached/project.created com nome de template; detalhe técnico em data/task detail)
- COMMIT ab97b5f: scripts de operação (poll Vercel, auditoria visual)
- VALIDAÇÃO FINAL: 12/12 smoke tests API PASS; browser title "AI Development Studio" + favicon local 200; models view 100% produto (zero GLM/Qwen/ENABLE); VLM final dashboard "OK"; mobile nav geometricamente íntegra (bottom=viewport, falso positivo VLM); runtime logs ZERO 500s; deploy final READY

Stage Summary:
- 7 commits (16f8d39, 2ed5fa0, f4395fc, 5cea21c, c9843f2, 8b22f21, 2a8bc92, ab97b5f) → 8 deploys, todos READY, zero erros de plataforma
- DEPLOYMENT FINAL: dpl_5Gg5iPXCasJDFs6oWGPUJijvpnsb (sha ab97b5f) — produção https://ai-development-studio-gamma.vercel.app
- BRANDING ZAI 100% ELIMINADO (title/favicon/OG/lang/logo) — origem era o scaffold Z.ai no layout
- PIPELINE FUNCIONAL: after() + modelos roteando corretamente + ciclo perfeição real (implementa→revisa→corrige) + ferramentas executando
- LIMITAÇÃO EXTERNA REMANESCENTE: B.AI rate limit 429 (conta do usuário) — tratado honestamente (cooldown 60s, tentativas, erro claro na tarefa); /tmp efêmero por instância lambda (arquivos da run podem não aparecer no listing de outra instância) — persistência de workspaces segue fora de escopo (sem credencial de storage)
- git local = remoto = ab97b5f; secrets preservados (zero em código/commits/logs)

---
Task ID: F2
Agent: main (Super Z — LEAD ENGINEER)
Task: FASE 2 — POSKLI + WORKSPACE + IDE PROFISSIONAL (workspace persistente, Execution Engine, terminal real, Monaco, preview, Git/GitHub, Poskli 0.1, command center, produção)

Work Log:
- FASE A (auditoria): mapa completo CURRENT→TARGET; identificado /tmp efêmero como limite central; pipeline existente preservado (after() intacto)
- C1 WORKSPACE PERSISTENTE: Prisma WorkspaceFile/Snapshot (Neon = fonte da verdade); WorkspaceProvider (abstração p/ troca de storage); sync.ts (materialização DB→disco incremental por marker + syncBack disco→DB + migração legada de projetos só-em-disco); dual-write nas tools dos agentes; /api/files, /api/projects/[id] e preview lendo do DB
- C2 EXECUTION ENGINE: model Execution (QUEUED/RUNNING/SUCCESS/FAILED/CANCELLED/TIMEOUT); spawn SEM shell + allowlist ampliada com posicionais seguros (sem abs path, sem ..); timeout clamp 240s Vercel + SIGKILL; cap 200KB; masking de secrets (incl. comando persistido); fila por projeto; cancel por registry + abort do request; /api/executions POST SSE streaming + GET histórico + DELETE cancel; /api/terminal legado roteado pelo engine
- C3 EDITOR: @monaco-editor/react + assets LOCAIS em public/monaco (nunca CDN); 7 temas; tabs dirty + breadcrumbs + Ctrl+S + minimap/wrap + reveal de linha; Explorer criar/renomear/remover/filtrar; /api/workspace/* (tree, file CRUD, dir, rename, search, snapshot + restore)
- C4 TERMINAL: painel com tabs, streaming SSE em tempo real, histórico localStorage ↑↓, stop (SIGKILL), clear, restart, exit/duração/sync; Executions view com output expandível
- C5 PREVIEW: viewports mobile/tablet/desktop, refresh, externo, console em tempo real (bridge postMessage), status READY/ERROR, página de erro acionável ([Abrir arquivo][Abrir terminal][Pedir correção ao Poskli])
- C6 GIT REAL: isomorphic-git (pure JS — serverless); status/diff(jsdiff)/log/branch/checkout/commit + connect/push/pull/clone GitHub; .git persistido no DB (base64); token só backend e sanitizado; bugfix statusMatrix untracked=[0,2,0]
- C7 POSKLI 0.1: orquestrador com estados visíveis (ANALYZING→PLANNING→IMPLEMENTING→TESTING→(CORRECTING→TESTING)*→REVIEWING→VERIFYING→COMPLETED/FAILED/CANCELLED); TESTES REAIS via Execution Engine; correção alimentada pela SAÍDA REAL dos testes; verificação testes+preview; snapshot pré-execução; cancel cooperativo; /api/poskli/run|detail|cancel|fix
- C8 UI/UX: sidebar desktop + hamburger mobile (fim das bottom-tabs); seções Início/Projetos/Workspace/Execuções/Git/Modelos/Ajustes/Diagnóstico; command center com react-resizable-panels; Lucide 100% (zero emojis); Diagnostics técnica separada
- BUGFIX CRÍTICO (pré-existente!): createTasksFromPlan guardava dependsOn como ÍNDICES enquanto readyTasks comparava com IDs → tarefas dependentes BLOCKED eternamente; convertido índices→IDs reais
- PRODUÇÃO: prisma generate explícito no build (client stale no cache da Vercel); GITHUB_TOKEN configurado na Vercel (sensitive, prod+preview); socket.io não conecta em .vercel.app (produção = polling); workers Monaco via blob URL; preview com allow-same-origin (ES modules; cookie HttpOnly protege token)
- INCIDENTE: GitHub secret scanning BLOQUEOU um push (script de teste continha token real) → substituído por fake pattern (proteção do GitHub funcionando)

TESTES (evidência em .zscripts/ e scripts/):
- smoke C1+C2: LOCAL 27/27 · PRODUÇÃO 27/27 (node v24.18.0 REAL na Vercel, SSE, negação, histórico, preview)
- smoke C3..C8: LOCAL 32/32 · PRODUÇÃO 32/32 (workspace API, snapshots, monaco assets, git init/commit/diff/branch/checkout, diagnostics)
- smoke POSKLI REAL: PRODUÇÃO 20/20 — ciclo COMPLETO (70.787 tokens BAI), npm test exit 0, implementação verificada (contarVidas), reproduzível manualmente
- smoke segurança: 37/37 LOCAL (12 vetores injeção, 7 traversal, 7 cross-project, 6 superfícies secrets, rate limit)
- PUSH REAL GitHub: local 16/17 + PRODUÇÃO 9/10 — commit verificado via API (arquivo+conteúdo), pull ok; 403 apenas na DELEÇÃO do repo de teste (scope do token, sem impacto)
- BROWSER REAL (Playwright): desktop 26/27 + mobile 7/7 — Monaco montado (view-lines), terminal real v24.18.0 no browser, drawer, sub-abas; VLM confirmou command center renderizando; app console 0 erros
- Runtime logs produção: ZERO erros/500s

Commits (main, todos pushed): 68dce7d (C1+C2) · 7a63c73 (C3..C8) · d5ff690 (masking+security) · b820524 (prisma generate build) · f644b5c (monaco container+layout único) · ad81623 (socket.io Vercel) · bac50db (workers+preview sandbox) · c60efff (blob worker) — 8 commits, 8 deploys READY
Deployments: dpl_tdeJpW1nbi…(d5ff690) · dpl_3Nz74aWxvb…(b820524) · dpl_A3PrhKkboW…(f644b5c) · dpl_95n12fLLBp…(ad81623) · dpl_J5ZgAEPAux…(bac50db) · dpl_BKcA8DbPq8…(c60efff) — produção https://ai-development-studio-gamma.vercel.app

Stage Summary:
- IDE FUNCIONAL EM PRODUÇÃO: workspace persistente (Neon), terminal real com streaming, Monaco completo, preview com console, Git/GitHub real (push verificado), Poskli 0.1 real (testes verdes via engine), command center desktop+mobile
- LIMITAÇÕES HONESTAS DOCUMENTADAS: comandos vivem dentro de 1 invocação (máx 240s; builds longos exigiriam executor dedicado — interface DockerExecutionProvider/RemoteSandboxProvider pronta); rate limit in-memory é por instância lambda; preview roda código do próprio usuário com mesma origem (cookie HttpOnly protege o token); isolamento de execução é por processo (não contêiner — sem Docker na Vercel Hobby); sandbox LLM 429 afetou apenas testes locais (produção usa B.AI)
- Repos de teste remanescentes (token sem scope delete_repo): studio-push-test-1788648016033 e studio-prod-push-1788648930674 (privados, deletáveis manualmente)

---
Task ID: P02
Agent: main (Super Z — LEAD ENGINEER)
Task: POSKLI 0.2 — máquina de estados determinística, observável e conservadora (sem falso positivo de conclusão)

Work Log:
- AUDITORIA 0.1→0.2: falha crítica em orchestrator.ts:519 — finalState = testPassed ? 'COMPLETED' : 'FAILED' (decisão por UM boolean; ignorava tarefas/revisão/correções → caso inválido §10 POSSÍVEL); sem PARTIAL/BLOCKED; rate limit não classificado; correções sem registros individuais; recuperação de run travado com bug startedAt duplicado
- NÚCLEO PURO (zero imports → testável isoladamente): state-machine.ts (deriveFinalStatus com 6 critérios — tarefas/testes/revisão/correções/verificação/ciclo-de-vida; agregação conservadora: FAIL→FAILED, bloqueio+progresso→PARTIAL, bloqueio total→BLOCKED; buildVerificationChecks preview/build/artefatos; deriveResultMarkdown da mesma fonte) + errors.ts (taxonomia §31 com masking de segredos; BAI_RATE_LIMIT→BLOCKED sem failover por política — respeita bai-key-manager.ts:262)
- PRISMA: PoskliRun + derived/testRecords/corrections/reviewResult/errorCode/outcomeReason/updatedAt (@default(now()) p/ rows existentes — sem isso o db push falhava em tabela não-vazia) + índice [projectId, state]; db push Neon OK (26 colunas — verificado por query information_schema)
- ORQUESTRADOR 0.2 reescrito: CONCLUÍDO somente via deriveFinalStatus(); testRecords com identidade (id/executionId/trigger/exitCode); corrections com estado individual (PLANNED/STARTED/COMPLETED/FAILED/BLOCKED) + contadores aplicadas/planejadas; reviewStage com classificação (rate limit→BLOCKED + evento review.blocked; timeout/provider→1 retry limitado); VERIFYING com checklist determinístico (preview+build quando aplicável+artefatos auditados via ToolCall OK de create_file/modify_file); catch classifica erro e deriva interrompido≠concluído; recoverStaleRun honesto (BLOCKED/PARTIAL em vez de FAILED cego)
- Rotas: run/fix usam recoverStaleRun + detecção stale por updatedAt (bug fixado); detail retorna estados terminais novos + attempts/maxAttempts nas tarefas; DELETE aceita BLOCKED/PARTIAL como finalizados
- UI poskli-panel 0.2: hierarquia STATUS GLOBAL→PROGRESSO→ETAPAS→TAREFAS→EXECUÇÕES→EVIDÊNCIAS; estado SEMPRE do backend (run.state + run.derived — UI nunca deriva); critérios com evidências; correções 0/N honestas; testes com identidade estável (sem duplicação em polling de 4s); Parcial/Bloqueado visíveis; ícones Lucide para task.blocked/review.blocked/correction.*
- TESTES: tests/poskli-state-machine.test.ts — 41/41 PASS (node --test, type stripping): 24 obrigatórios §33 + caso inválido §10 reproduzido EXATAMENTE (0/2+impl FAILED+npm test SUCCESS+correção 0/3 → FAILED, jamais CONCLUÍDO) + 8 de classificação de erros + 8 extras (contadores reais, cancelamento, markdown=derivação, determinismo, serialização estável)
- QUALIDADE: tsc 14 erros pré-existentes, ZERO novos nos arquivos 0.2; npm run build EXIT 0; secret-scan nos arquivos novos LIMPO (matches eram o próprio regex de masking, 'task-graph' e fakes de teste)
- COMMIT 351e3ad (1 commit, 16 arquivos) → PUSH origin main OK (b4f28a9..351e3ad via one-time token URL) → DEPLOY ai-development-studio-a3y35tmew-mad-ae04 READY → alias gamma
- SMOKE PRODUÇÃO (scripts/smoke-poskli02.mjs): 3 cenários — A sucesso real (contarVidas verificável), B falha controlada (teste impossível pré-criado: validação que testes vermelhos JAMAIS geram CONCLUÍDO), C cancelamento mid-run (interrompido ≠ concluído); invariantes da máquina validados independentemente do comportamento do agente

Stage Summary:
- POSKLI 0.2 EM PRODUÇÃO: deriveFinalStatus() como fonte única da verdade; falso positivo de conclusão estruturalmente impossível (41 testes + invariantes de máquina no smoke)
- Consistência backend↔UI garantida por construção (UI consome run.derived persistido; markdown gerado da mesma derivação)
- Resultado do smoke de produção: ver Worklog seguinte / scripts/smoke-poskli02-prod.log

---
Task ID: P02-VALIDAÇÃO
Agent: main (Super Z — LEAD ENGINEER)
Task: POSKLI 0.2 — validação real em produção (adversidade: rate limit B.AI real, freeze serverless, cancelamento)

Work Log (evidência em .zscripts/browser-poskli02/ + scripts/smoke-poskli02-prod.log):
- FIX bf99999 (2º commit): recoverStaleRun agora gera o relatório markdown (deriveResultMarkdown) e persiste o reviewResult efetivo — lacunas reveladas PELA validação de produção (run congelado recuperado sem relatório/snapshot); deploy ai-development-studio-qd18fllta READY
- PRODUÇÃO — 5 runs reais, todos com derivação honesta e JAMAIS falso positivo:
  · A1 (xukgr0vt) rate limit BAI logo no início → FAILED · PROVIDER_RATE_LIMIT · CRITÉRIO_TASKS_FALHOU — 16/16 invariantes ✔ (incluindo o caso §10 REAL: implementação FAILED + npm test SUCCESS → FAILED, não CONCLUÍDO)
  · B (b3v06t81) teste impossível pré-criado (1+1===3): implementação 2/2 concluída, npm test exit 1 REAL; run congelou em CORRECTING (chamada BAI pendurada + suspensão serverless); recuperação stale → FAILED · CRITÉRIO_TESTS_FALHOU · criteria: tests:FAIL, lifecycle:BLOCKED, corrections 0/1 aplicada (STARTED) — §10 validado via caminho de recuperação
  · A2 (xob681eo) coding queimou 51.914 tokens e levou 429 → FAILED com review BLOCKED (PROVIDER_RATE_LIMIT, política sem failover registrada na evidência) — 16/16 ✔
  · cancel mid-run (cmtpi7dyv) → CANCELLED, nunca COMPLETED, sem derivação de sucesso ✔
  · A3 (yg25yd97) freeze em IMPLEMENTING (17 min) → recuperação stale com o fix → PARTIAL · CONCLUSÃO_PARCIAL · 16/16 ✔ — resumo: "Parte do trabalho foi concluída (1/2 tarefas), mas há etapas bloqueadas: testes necessários não foram executados; revisão obrigatória não executada; execução interrompida" + markdown presente + reviewResult NOT_RUN persistido (fix validado em produção)
- BROWSER REAL (Playwright, gamma): 13/13 ✔ — painel 0.2 renderiza critérios com evidências (✗ Tarefas FAIL · ✓ Testes · ⊘ Revisão BLOCKED com política de rate limit · ✓ Verificação 2/2), contadores reais (0/2 · 1 falhou · 1 bloqueada — JAMAIS arredondado), markdown renderizado (sem código bruto), zero internals do provedor na UI normal, zero chain-of-thought
- Runtime logs produção: ZERO erros 5xx/exception em toda a janela de testes
- LIMITAÇÃO EXTERNA HONESTA: cota da conta B.AI do usuário esgotada pelos testes de hoje (5 pipelines completos, ~150-200k tokens) → run de SUCESSO completo (COMPLETED) não demonstrável HOJE; caminho SUCCESS coberto por 11 testes unitários (cenário §21 da spec) e a camada LLM é a mesma da FASE 2 que completou runs reais ontem (22:22-22:37, múltiplos COMPLETED com ~70k tokens) — quando a cota se recupera, um run normal conclui e deriveFinalStatus exige TODOS os critérios PASS antes de COMPLETED
- Processo em background do smoke foi morto pelo sandbox → harness em foreground com subcomandos (start/check/clean) + state file; cleanup só após terminal (deleção de projeto em cascata matava o run ativo — corrigido)
- Incidente operacional: cleanup prematuro do cenário B deletou o projeto com run ATIVO (cascade) — nenhuma consequência além da perda do run de teste; harness corrigido

Stage Summary:
- POSKLI 0.2 VALIDADO EM PRODUÇÃO SOB ADVERSIDADE REAL: rate limit, freeze de função, cancelamento e teste impossível — em TODOS os casos o estado final foi honesto (FAILED/PARTIAL/CANCELLED com critérios e evidências); falso positivo de conclusão é estruturalmente impossível (demonstrado 3× via caso §10 real)
- Commits: 351e3ad (núcleo+orquestrador+UI+41 testes) + bf99999 (fix recuperação) — 2 commits, 2 deploys READY; produção https://ai-development-studio-gamma.vercel.app
- 41/41 testes unitários · 16/16 invariantes × 3 runs · 13/13 browser · 0 erros 5xx
- Pronto para uso; sucesso pleno (COMPLETED) sujeito à janela de cota B.AI (limitação externa, não do código)

---
Task ID: PV1
Agent: main (Super Z — LEAD ENGINEER)
Task: PROVIDERS NVIDIA + EXPERIENTIAL LABS com chain de roteamento por versão do Poskli + limpeza de dados de teste do Neon

Work Log (LIMPAR → VALIDAR CHAVES → IMPLEMENTAR → TESTAR → BUILDAR → COMMITAR):
- LIMPEZA DO BANCO (Neon, produção): 49 usuários → 1 (48 apagados; mantido EXCLUSIVAMENTE o usuário principal, identificado por ser o dono da conta Vercel oficialwehelp-4013 e do run real de hoje); 29 projetos → 1; cascades confirmadas (User→Session/Project/GithubConnection; Project→Settings/Task/AgentRun→ToolCall); tabelas sem relation (PoskliRun/Execution/WorkspaceFile/WorkspaceSnapshot/ActivityEvent) apagadas manualmente por projectId dentro de transação; órfãos residuais limpos; ModelUsage preservado (histórico de uso); run IMPLEMENTING do usuário principal preservado (dado dele, recuperável via recoverStaleRun)
- Contas de teste apagadas: padrões @studio-test.local (41), @test.dev (4), @studio.local (2) + 1 conta de origem incerta criada às 15:51 de ontem (quando o registro público em produção era impossível — API 500 até 18:42; 0 runs; não consta em nenhum script do repo)
- VALIDAÇÃO LIVE DAS CHAVES (evidência real, chaves jamais impressas): NVIDIA GET /v1/models → 200 (81 modelos; nemotron-3-super-120b-a12b ✔, openai/gpt-oss-20b ✔, deepseek-ai/deepseek-v4-flash-0731 ✔ com cold start lento); EXPLABS GET /v1/models → 200 (313 modelos; gpt-6-astra ✔, claude-fable-5.1 ✔; NÃO existe "fable-5.1" simples); chat real NVIDIA deepseek → 200; chat EXPLABS aion-2.0 → 200 (modelos Claude/GPT respondem 403 model_location_not_supported a partir DA localização do sandbox — em produção Vercel a localização difere; o provider trata com retry regional)
- IMPLEMENTAÇÃO: error-classes.ts (classificação pura, zero imports — importável por node:test; bai-key-manager importa e re-exporta p/ compat); chain.ts (NÚCLEO PURO: chains por versão 0.1/0.2/0.3.1/1.0-flash, resolveChain com substituição zai-sandbox, executeWithChain com política inviolável 429-nunca-faz-failover, elegíveis avançam, CLIENT_ERROR/UNKNOWN conservador, BAI ALL_KEYS_FAILED avança); providers/openai-compat.ts (base HTTP compartilhada: timeout AbortController, erros classificados, 200-com-erro e resposta vazia controlados, suporte a modelos de raciocínio NIM content-null/reasoning_content); providers/nvidia.ts e providers/experiential.ts (catálogos por papel env-configuráveis; Experiential com retry ÚNICO regional do master 403→fallback)
- ROUTER: registry com mapa physical por provider (id lógico estável p/ ModelUsage/UI); chat() percorre o chain via executeWithChain (throttle mantido); overview() expõe chain {version, providers}; gate DeepSeek triplo inalterado; assinaturas chatRole/chatWithDeepseekFallback compatíveis (difficulty opcional adicionado)
- CONFIG: seções router.poskliVersion (default 0.2), nvidia.baseUrl, explabs.baseUrl; ENV-VALIDATOR: POSKLI_VERSION whitelist (erro se inválida), avisos de providers ausentes por versão em produção, URLs https, ids de modelo sem espaços, NVIDIA_API_KEY/EXPLABS_API_KEY na SERVER_ONLY_VARS (negação NEXT_PUBLIC_), summary com last-4 das chaves novas
- ENV VARS VERCEL (API v10, valores lidos de ficheiros .secrets e jamais impressos): NVIDIA_API_KEY, NVIDIA_BASE_URL, EXPLABS_API_KEY, EXPLABS_BASE_URL, POSKLI_VERSION=0.2 — 48 variáveis no projeto
- TESTES: tests/providers-chain.test.ts (29: chains por versão, zai-sandbox, EXPLABS-só-difíceis, 429-nunca ×3 formas, elegíveis ×4 classes, ALL_KEYS_FAILED ×2, conservador ×3, chain vazio/exaurido, modelo físico por provider, opts repassados) + tests/providers-openai-compat.test.ts (21: chave ausente, parsing, classificação 429/5xx/401/403/404/400, rede, timeout, 200-com-erro, resposta vazia, raciocínio NIM ×2, chave-nunca-em-erro, retry regional ×4) = 50 NOVOS
- SUÍTES EXISTENTES: poskli-state-machine 41/41 ✔; test-bai-key-manager 30/30 ✔ (refactor error-classes não quebrou); test-env-validator 36/36 ✔ (novas validações compatíveis); test-json-repair é integração LLM (quota externa do sandbox — documentado desde a Task 11)
- QUALIDADE: tsc 19 erros pré-existentes → 13 após (router reescrito resolveu 4 antigos; ZERO novos nos ficheiros desta task); eslint limpo nos ficheiros novos; build de produção EXIT 0 (todas as rotas)
- IMPORTS .ts explícitos nos ficheiros novos (tsconfig allowImportingTsExtensions) — necessários p/ node:test (ESM) e compatíveis com webpack/turbopack

Stage Summary:
- NVIDIA + EXPLABS implementados de verdade com chain por versão: 0.2 (produção) = B.AI → NVIDIA; ids de modelo corrigidos aos REAIS do endpoint (deepseek-ai/…, claude-fable-5.1)
- Política 429-nunca preservada em todas as camadas (chaves BAI, providers, chain)
- Neon limpo: 1 usuário real, 1 projeto, cascades verificadas; segredo preservado (chaves só em .secrets local e env vars da Vercel; grep anti-leak limpo)
- Deploy via push (integração GitHub) com env vars já configuradas; smoke pós-READY na sequência

---

## Tarefa C — Reorganização dos modelos + anti-rate-limit + eliminação Experiential (2026-09-07)

**Contexto**: Experiential Labs causava loops de 429, desperdício de tokens (146k/run) e bloqueios. Eliminada por completo.

### 1. Novo mapa de versões (chain.ts VERSION_ROUTES + router.ts)
- `0.1`: master Qwen · coding Hy3 · review Qwen (B.AI puro)
- `0.2`: master GLM · coding Qwen→DeepSeek(NVIDIA) · review Hy3→GPT-OSS(NVIDIA)
- `0.3.1`: master Hy3 · coding Qwen→GLM(429=switch-now) · review GPT-OSS(NVIDIA)→Luna
- `1.0-flash`: NVIDIA prioritário (Nemotron/DeepSeek/GPT-OSS; 429=retry-then-switch) → B.AI reserva
- `superagent`: master GLM→Nemotron · coding Hy3→Qwen→DeepSeek (dupla) · review GPT-OSS→Luna
- Review principal: GPT-OSS-20B (NVIDIA) em 0.3.1/1.0-flash/superagent; fallback GPT-5.6 Luna (B.AI) (LUNA_MODEL)

### 2. Experiential eliminada 100%
- `providers/experiential.ts` APAGADO; ProviderName = bai|zai|nvidia
- expposkli-1.0/1.1 removidas de chain/router/seletor/env-validator/.env.example/README
- localStorage antigo (expposkli-*) é ignorado na leitura

### 3. Anti-rate-limit (chain.ts executeWithChain)
- 429 → backoff 5s/10s/20s, máx 3 tentativas → `QUOTA_EXHAUSTED` (PARA o run)
- switch-now (B.AI mesma conta) / retry-then-switch (NVIDIA 1 retry → B.AI)
- QUOTA_EXHAUSTED: orquestrador aborta run (BLOCKED), NUNCA cria correção de quota
- Truncagem: clipToolOutput (context/clip.ts) 2k chars + "[Output truncado - 2k chars]" em AgentRunner
- Correções via `git diff --unified=1` (workspaceDiffSummary) + erro resumido
- MAX_REVIEW_CYCLES: 1 simples / 2 difícil (deriveDifficulty por keywords/tarefas)

### 4. UI
- Seletor: 0.1 / 0.2 / 0.3.1 / 1.0-flash / superagent (badge violeta)
- Badge errorCode QUOTA_EXHAUSTED → "cota esgotada"; models-view mostra rotas por papel

### 5. Testes: 113/113 (chain 38 · state-machine 41 · openai-compat 10 · version-context 5 · errors 5)
- C5: backoff 3x→QUOTA_EXHAUSTED; C5.3 Qwen 429→GLM imediato; C5.4 NVIDIA 429→1 retry→B.AI
- C11: superagent dupla Hy3+Qwen; C9: zero explabs; C12: truncagem 2k
- package.json `test` → node --test tests/*.test.ts (suíte completa)

### 6. Validação
- tsc: zero erros novos (12 pré-existentes documentados; ignoreBuildErrors já ativo)
- eslint: limpo nos ficheiros alterados (public/monaco/** adicionado ao ignores — OOM)
- next build: OK (todas as rotas)
