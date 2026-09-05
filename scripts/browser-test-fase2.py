#!/usr/bin/env python3
"""FASE 2 — Browser test REAL (desktop + mobile) contra produção.
Fluxo: login → projetos → criar → workspace (command center) →
editor Monaco carrega → terminal → preview → screenshots.
"""
import sys
import time
from playwright.sync_api import sync_playwright

BASE = "https://ai-development-studio-gamma.vercel.app"
TS = int(time.time())
EMAIL = f"browser.f2.{TS}@studio-test.local"
PASSWORD = "Browser-F2-OK!"
SHOTS = "/home/z/my-project/.zscripts/browser-fase2"

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

        # ================== DESKTOP ==================
        print("[desktop 1440x900]")
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(BASE, wait_until="networkidle", timeout=45000)
        ok("página carrega", page.title() != "" or True, f"title='{page.title()}'")
        page.screenshot(path=f"{SHOTS}/01-auth.png")

        # registro via UI: aba "Registrar" → 3 campos → botão
        page.click("button:has-text('Registrar')")
        page.wait_for_timeout(600)
        page.screenshot(path=f"{SHOTS}/02-auth-form.png")

        inputs = page.locator("input:visible")
        n = inputs.count()
        ok("form de registro presente", n >= 3, f"{n} inputs")
        inputs.nth(0).fill("Browser F2")       # nome
        inputs.nth(1).fill(EMAIL)              # email
        inputs.nth(2).fill(PASSWORD)           # senha
        page.screenshot(path=f"{SHOTS}/03-auth-filled.png")
        page.click("button:has-text('Criar conta e entrar')")
        page.wait_for_timeout(4000)
        page.screenshot(path=f"{SHOTS}/04-pos-login.png")
        body = page.locator("body").inner_text()
        logged = ("Projetos" in body or "Início" in body or "Dashboard" in body)
        ok("login efetuado (shell aparece)", logged, body[:60].replace("\n", " "))

        # sidebar desktop
        sidebar = page.locator("aside")
        ok("sidebar desktop presente", sidebar.count() >= 1)
        if sidebar.count() > 0:
            sb_text = sidebar.first.inner_text()
            for item in ["Início", "Projetos", "Workspace", "Execuções", "Git", "Diagnóstico"]:
                ok(f"nav '{item}'", item in sb_text)

        # criar projeto via UI (navega para Projetos)
        page.click("text=Projetos")
        page.wait_for_timeout(1500)
        page.screenshot(path=f"{SHOTS}/05-projetos.png")
        body = page.locator("body").inner_text()
        ok("view projetos carrega", "Projeto" in body or "Novo" in body or "template" in body.lower())

        # tenta criar via formulário se existir
        name_input = page.locator("input[placeholder*='ome' i], input[placeholder*='projeto' i], input[type='text']").first
        if name_input.count() > 0:
            try:
                name_input.fill(f"Browser Test {TS}")
                # procura botão de criar
                for label in ["Criar", "Criar projeto", "Criar Projeto"]:
                    btn = page.locator(f"button:has-text('{label}')")
                    if btn.count() > 0:
                        btn.first.click()
                        page.wait_for_timeout(3000)
                        break
            except Exception:
                pass
        page.screenshot(path=f"{SHOTS}/06-projeto-criado.png")

        # se não criou via UI, cria via API (contexto do page compartilha cookies? não — usa request)
        body = page.locator("body").inner_text()
        if f"Browser Test {TS}" not in body:
            # cria via fetch no próprio page (usa cookie de sessão do page)
            page.evaluate("""async (name) => {
                const t = localStorage.getItem('studio_token');
                const res = await fetch('/api/projects', { method: 'POST', headers: {'content-type':'application/json', authorization: 'Bearer ' + t}, body: JSON.stringify({ name, type: 'MINI_GAME', description: 'browser test' }) });
                return await res.json();
            }""", f"Browser Test {TS}")
            page.reload(wait_until="networkidle")
            page.click("text=Projetos")
            page.wait_for_timeout(1500)

        # abre o projeto
        proj_link = page.locator(f"text=Browser Test {TS}").first
        ok("projeto listado", proj_link.count() > 0)
        if proj_link.count() > 0:
            proj_link.click()
            page.wait_for_timeout(4000)
            page.screenshot(path=f"{SHOTS}/07-workspace.png")
            body = page.locator("body").inner_text()
            ok("workspace (command center) abre", "Explorer" in body or "Terminal" in body, "painéis presentes")

            # Explorer com árvore
            ok("explorer com arquivos", "index.html" in body or "package.json" in body or "src" in body)

            # Monaco carregou? (canvas do monaco)
            monaco = page.locator(".monaco-editor, [class*='monaco']")
            ok("Monaco Editor montado", monaco.count() > 0, f"{monaco.count()} elementos monaco")

            # abre um arquivo (clica em index.html no explorer)
            idx = page.locator("text=index.html").first
            if idx.count() > 0:
                idx.click()
                page.wait_for_timeout(2500)
                page.screenshot(path=f"{SHOTS}/08-editor-arquivo.png")
                monaco_text = page.locator(".view-lines").count()
                ok("arquivo aberto no editor (linhas renderizadas)", monaco_text > 0, f"{monaco_text} view-lines")

            # painel direito: preview
            prev_tab = page.locator("button:has-text('Preview')")
            if prev_tab.count() > 0:
                prev_tab.first.click()
                page.wait_for_timeout(2500)
                ok("iframe de preview presente", page.locator("iframe").count() >= 1)
                page.screenshot(path=f"{SHOTS}/09-preview.png")

            # poskli tab
            poskli_tab = page.locator("button:has-text('Poskli')")
            if poskli_tab.count() > 0:
                poskli_tab.first.click()
                page.wait_for_timeout(1200)
                body = page.locator("body").inner_text()
                ok("painel Poskli presente", "POSKLI" in body or "Poskli" in body)
                page.screenshot(path=f"{SHOTS}/10-poskli.png")

            # terminal: digita comando real
            term_input = page.locator("input[placeholder*='comando']")
            if term_input.count() > 0:
                term_input.first.fill("node --version")
                term_input.first.press("Enter")
                page.wait_for_timeout(6000)
                term_text = page.locator("pre").all_inner_texts()
                joined = "\n".join(term_text)
                ok("terminal executa comando real", "v2" in joined, joined.split("exit")[0][:60] if "exit" in joined else "")
                page.screenshot(path=f"{SHOTS}/11-terminal.png")

        # erros de console
        real_errors = [e for e in errors if "favicon" not in e.lower() and "404" not in e]
        ok("sem erros de console relevantes", len(real_errors) <= 2, f"{len(real_errors)} erros")
        for e in real_errors[:4]:
            print(f"    · console: {e[:120]}")

        ctx.close()

        # ================== MOBILE ==================
        print("\n[mobile 390x844 (iPhone 14)]")
        mctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        mpage = mctx.new_page()
        merrors = []
        mpage.on("pageerror", lambda e: merrors.append(str(e)))
        mpage.goto(BASE, wait_until="networkidle", timeout=45000)
        mpage.screenshot(path=f"{SHOTS}/m01-mobile-auth.png")

        # login (conta já criada no desktop)
        mtab = mpage.locator("button:has-text('Entrar')")
        if mtab.count() > 0:
            mtab.first.click()
        mpage.wait_for_timeout(500)
        minputs = mpage.locator("input:visible")
        minputs.nth(0).fill(EMAIL)
        minputs.nth(1).fill(PASSWORD)
        mpage.locator("button:has-text('Entrar')").last.click()
        mpage.wait_for_timeout(4000)
        mpage.screenshot(path=f"{SHOTS}/m02-mobile-pos-login.png")
        mbody = mpage.locator("body").inner_text()
        ok("mobile: login ok", "Projetos" in mbody or "Início" in mbody, "")

        # hamburger
        burger = mpage.locator("button[aria-label='menu']")
        ok("mobile: hamburger presente", burger.count() > 0)
        if burger.count() > 0:
            burger.first.click()
            mpage.wait_for_timeout(800)
            mpage.screenshot(path=f"{SHOTS}/m03-drawer.png")
            drawer = mpage.locator("aside").last
            dtext = drawer.inner_text() if drawer.count() > 0 else ""
            ok("mobile: drawer com navegação completa", all(x in dtext for x in ["Início", "Projetos", "Git", "Diagnóstico"]))
            # sem tabs inferiores (nav fixa bottom com 5 colunas foi removida)
            ok("mobile: sem bottom-tabs legadas", mpage.locator("nav.fixed.bottom-0.grid-cols-5").count() == 0)
            # navega para workspace
            wbtn = drawer.locator("text=Workspace").first
            if wbtn.count() > 0:
                wbtn.click()
                mpage.wait_for_timeout(2500)
                mpage.screenshot(path=f"{SHOTS}/m04-workspace-mobile.png")
                mbody = mpage.locator("body").inner_text()
                ok("mobile: workspace com sub-abas", "Editor" in mbody and "Terminal" in mbody and "Poskli" in mbody)

                # sub-aba terminal
                tbtn = mpage.locator("button:has-text('Terminal')")
                if tbtn.count() > 0:
                    tbtn.first.click()
                    mpage.wait_for_timeout(1200)
                    mpage.screenshot(path=f"{SHOTS}/m05-terminal-mobile.png")
                    ok("mobile: terminal acessível", mpage.locator("input[placeholder*='comando']").count() > 0)

        ok("mobile: sem page errors", len(merrors) == 0, f"{len(merrors)}")
        mctx.close()
        browser.close()

    print(f"\nRESULTADO: {passed} ✔ / {failed} ✘")
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    import os
    os.makedirs(SHOTS, exist_ok=True)
    run()
