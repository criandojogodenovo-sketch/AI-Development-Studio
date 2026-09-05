#!/usr/bin/env python3
"""Task 17 — SMOKE TEST REAL contra produção (gamma.vercel.app).

Sequência: página → 401 sem sessão → register → login → /me → models auth →
criar projeto (o teste que falhava com ENOENT) → listar → detalhe/arquivos →
criar arquivo → ler arquivo → run (chamada real de modelo) → poll de progresso.

Evidências em .zscripts/vercel-diag/smoke-task17.json (gitignored).
Printa SOMENTE status/corpos não-sensíveis (nunca senhas/keys).
"""
import http.cookiejar
import json
import time
import urllib.error
import urllib.request

BASE = "https://ai-development-studio-gamma.vercel.app"
EVIDENCE = "/home/z/my-project/.zscripts/vercel-diag/smoke-task17.json"
TS = int(time.time())
EMAIL = f"smoke17.{TS}@studio-test.local"
NAME = "Smoke Task 17"
PASSWORD = "Smoke-Task17-OK!"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
results = []


def call(method: str, path: str, body: dict | None = None, timeout: int = 30) -> tuple:
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Content-Type": "application/json",
        "User-Agent": "smoke-task17/1.0",
    })
    try:
        with opener.open(req, timeout=timeout) as res:
            raw = res.read().decode(errors="replace")
            code = res.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        code = e.code
    try:
        parsed = json.loads(raw)
    except Exception:
        parsed = raw[:300]
    return code, parsed


def step(name: str, method: str, path: str, body=None, expect=None, timeout=30, note=""):
    code, parsed = call(method, path, body, timeout)
    ok = (code == expect) if expect is not None else (200 <= code < 300)
    line = f"{'PASS' if ok else 'FAIL'} | {name} | {method} {path} → {code}"
    if note:
        line += f" | {note}"
    summary = ""
    if isinstance(parsed, dict):
        if "error" in parsed:
            summary = f"error={parsed['error']}"
        elif "projects" in parsed:
            summary = f"{len(parsed['projects'])} projetos"
        elif "models" in parsed:
            summary = f"{len(parsed.get('models', []))} modelos"
        elif "project" in parsed:
            summary = f"id={parsed['project'].get('id')}"
        elif "user" in parsed:
            summary = f"user={parsed['user'].get('email')}"
        elif "ok" in parsed:
            summary = f"ok={parsed['ok']}"
    if summary:
        line += f" | {summary}"
    print(line, flush=True)
    results.append({"name": name, "method": method, "path": path, "status": code,
                    "expect": expect, "ok": ok, "response": parsed if not isinstance(parsed, str) else parsed[:300]})
    return code, parsed


def main():
    # 1) Página principal
    step("página principal", "GET", "/", timeout=30)

    # 2) /api/models SEM sessão → 401 controlado
    step("models sem sessão (401 esperado)", "GET", "/api/models", expect=401)

    # 3) Registro real
    step("register", "POST", "/api/auth/register",
         {"email": EMAIL, "name": NAME, "password": PASSWORD}, expect=200)

    # 4) Login real
    step("login", "POST", "/api/auth/login",
         {"email": EMAIL, "password": PASSWORD}, expect=200)

    # 5) Sessão válida
    step("me (sessão)", "GET", "/api/auth/me", expect=200)

    # 6) /api/models autenticado → 200
    code, models = step("models autenticado", "GET", "/api/models", expect=200)
    if isinstance(models, dict):
        models_brief = {k: models.get(k) for k in ("provider", "activeProvider", "active", "deepseek")}
        results.append({"name": "models-overview-brief", "data": models_brief})

    # 7) Criar projeto — TESTE CRÍTICO (falhava: ENOENT mkdir relativo)
    code, created = step("criar projeto (ENOENT anterior)", "POST", "/api/projects",
                         {"name": "Smoke Task 17", "type": "EMPTY_PROJECT",
                          "description": "Smoke test pós WORKSPACES_ROOT=/tmp/workspaces"},
                         expect=201)
    project_id = created.get("project", {}).get("id") if isinstance(created, dict) else None
    if not project_id:
        print(f"CRÍTICO: projeto não criado — aborta smoke de run. Body: {json.dumps(created)[:300]}")
        save()
        return

    # 8) Listar projetos
    code, listed = step("listar projetos", "GET", "/api/projects", expect=200)
    if isinstance(listed, dict):
        ids = [p.get("id") for p in listed.get("projects", [])]
        results.append({"name": "projetos-listados", "ids": ids, "contains_new": project_id in ids})

    # 9) Detalhe do projeto (árvore de arquivos do workspace)
    code, detail = step("detalhe projeto + arquivos", "GET", f"/api/projects/{project_id}", expect=200)
    if isinstance(detail, dict):
        results.append({"name": "arquivos-iniciais",
                        "files": detail.get("files"),
                        "project_status": detail.get("project", {}).get("status")})

    # 10) Criar arquivo via editor
    step("criar arquivo", "POST", "/api/files",
         {"project": project_id, "path": "notes/smoke-test.md",
          "content": "# Smoke Task 17\nWORKSPACES_ROOT=/tmp/workspaces validado.\n"}, expect=200)

    # 11) Ler arquivo de volta
    step("ler arquivo", "GET", f"/api/files?project={project_id}&path=notes/smoke-test.md", expect=200)

    # 12) Run — chamada real de modelo (pipeline em background)
    step("run (iniciar pipeline)", "POST", f"/api/projects/{project_id}/run",
         {"request": "Crie um arquivo README.md com uma frase de boas-vindas ao Studio"},
         expect=202, timeout=60)

    # 13) Poll do progresso (máx 180s) — status, runs, eventos
    print("--- poll do pipeline (máx 180s) ---", flush=True)
    started = time.time()
    final = None
    seen_events = 0
    while time.time() - started < 180:
        code, d = call("GET", f"/api/projects/{project_id}")
        if isinstance(d, dict):
            status = d.get("project", {}).get("status")
            runs = d.get("runs", [])
            code2, act = call("GET", f"/api/activity?project={project_id}&take=100")
            events = act.get("events", []) if isinstance(act, dict) else []
            seen_events = max(seen_events, len(events))
            print(f"[poll +{int(time.time()-started)}s] status={status} runs={len(runs)} events={len(events)}", flush=True)
            completed_runs = [r for r in runs if r.get("status") == "COMPLETED" and (r.get("tokensIn") or 0) + (r.get("tokensOut") or 0) > 0]
            if completed_runs:
                final = {"status": status, "runs": runs, "completed_with_tokens": len(completed_runs)}
                print(f"MODELO CHAMADO DE VERDADE: {len(completed_runs)} run(s) COMPLETED com tokens", flush=True)
                for r in completed_runs:
                    print(f"  run: agent={r.get('agentId')} model={r.get('model')} tokensIn={r.get('tokensIn')} tokensOut={r.get('tokensOut')} steps={r.get('steps')} durationMs={r.get('durationMs')}", flush=True)
                break
            if status in ("COMPLETED", "PARTIAL", "FAILED", "REVIEW"):
                final = {"status": status, "runs": runs}
                break
        time.sleep(8)

    if final is None:
        final = {"status": "TIMEOUT_180s (background pode ter sido congelado pós-resposta)"}
    results.append({"name": "pipeline-final", **final})

    # última amostra de eventos p/ diagnóstico
    code, act = call("GET", f"/api/activity?project={project_id}&take=100")
    if isinstance(act, dict):
        evs = act.get("events", [])
        results.append({"name": "eventos-finais",
                        "count": len(evs),
                        "types": [e.get("type") for e in evs[:25]],
                        "last_messages": [e.get("message") for e in evs[-8:]]})

    save()
    print(f"\nPROJETO: {project_id} | pipeline final: {json.dumps(final)[:400]}")


def save():
    with open(EVIDENCE, "w") as f:
        json.dump({"base": BASE, "user": EMAIL, "ts": TS, "results": results}, f, indent=2, ensure_ascii=False)
    print(f"(evidência: {EVIDENCE})")


if __name__ == "__main__":
    main()
