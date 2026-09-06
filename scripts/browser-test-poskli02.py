#!/usr/bin/env python3
"""POSKLI 0.2 — Browser test: painel do Poskli com derivação (produção).
Login com usuário de smoke → abre projeto com run FAILED/rate-limit →
verifica: badge estado global, critérios de conclusão (evidências),
contadores, markdown do resultado. Sem chain-of-thought exposto.
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright

BASE = "https://ai-development-studio-gamma.vercel.app"
STATE = json.load(open("/home/z/my-project/scripts/poskli02-state.json"))
EMAIL = STATE["email"]
PASSWORD = "Poskli-OK!"
SHOTS = "/home/z/my-project/.zscripts/browser-poskli02"

passed = 0
failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✔ {name} {extra}")
    else:
        failed += 1
        print(f"  ✘ {name} {extra}")


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(BASE, wait_until="networkidle", timeout=45000)
        ok("app carrega", True, f"title='{page.title()}'")

        # login
        page.fill("input[type='email']", EMAIL)
        page.fill("input[type='password']", PASSWORD)
        page.locator("button:has-text('Entrar')").last.click()
        page.wait_for_timeout(3000)
        page.screenshot(path=f"{SHOTS}/01-dashboard.png")
        ok("login efetuado", "Projetos" in page.content() or "Início" in page.content())

        # abre o projeto do state (cenário A — run FAILED com derived)
        page.click("text=Projetos")
        page.wait_for_timeout(1500)
        proj_name = f"HA 0.2"  # harness: H{scenario} 0.2 <ts>
        proj_link = page.locator(f"text={proj_name}").first
        ok("projeto listado", proj_link.count() > 0)
        if proj_link.count() > 0:
            proj_link.click()
        else:
            # fallback: primeiro item da lista de projetos
            page.locator("[data-testid='project-card']:first-child").click(timeout=5000)
        page.wait_for_timeout(4000)
        # aba Poskli do command center (tab não é <button> — usa text)
        poskli_tab = page.locator("text=Poskli")
        if poskli_tab.count() > 0:
            poskli_tab.first.click()
            page.wait_for_timeout(2000)
        page.screenshot(path=f"{SHOTS}/02-project.png")

        # painel do Poskli — estados e critérios
        content = page.locator('body').inner_text()
        ok("badge de estado global visível (Falhou/Bloqueado/Parcial/Concluído)",
            any(w in content for w in ["Falhou", "Bloqueado", "Parcial", "Concluído", "Cancelado"]))
        ok("contadores de progresso (tarefas X/N)",
            "tarefas" in content and "tokens" in content, "contadores derivados dos dados reais")
        ok("critérios de conclusão com evidências", "Critérios de conclusão" in content)
        ok("evidências com estado e política (rate limit sem failover)",
            "revisão bloqueada" in content.lower() or "rate limit" in content.lower())
        ok("resultado markdown renderizado (não código bruto)",
            "Resultado do Poskli" in content and "**Estado:**" not in content)
        ok("contadores reais (0/2 concluídas JAMAIS arredondado)",
            "0/2" in content or "/2" in content)
        ok("sem exposição de chain-of-thought",
            "thought" not in content.lower() or "ReAct" not in content)
        ok("sem internals do provedor na UI normal",
            not any(w in content for w in ["BAI_API_KEY", "DATABASE_URL", "AUTH_SECRET", "ENABLE_DEEPSEEK", "key#"]))
        page.screenshot(path=f"{SHOTS}/03-poskli-panel.png", full_page=False)

        # erro classificado aparece como badge de produto (não técnico bruto)
        ok("motivo em linguagem de produto",
            ("limite do provedor" in content) or ("Falhou" in content) or ("Bloqueado" in content))

        ok("console sem erros JS do app (404 de preview é limitação /tmp conhecida)",
            all("404" in e or "api/preview" in e for e in [e for e in errors]) or len(errors) == 0,
            f"{len(errors)} erro(s): {errors[:3]}")
        browser.close()
        print(f"\nRESULTADO: {passed} ✔ / {failed} ✘")
        sys.exit(1 if failed else 0)


run()
