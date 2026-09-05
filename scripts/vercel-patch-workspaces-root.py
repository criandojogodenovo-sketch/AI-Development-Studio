#!/usr/bin/env python3
"""Task 17 — PATCH WORKSPACES_ROOT=/tmp/workspaces na Vercel (production+preview).

Lê VERCEL_TOKEN de /home/z/my-project/.env (gitignored — NUNCA impresso).
Aplica PATCH no env var Lorf1yu0xlBsZgdK do projeto prj_JlAHgua53UYdAnmDhaLykQSeg0CW.
Salva evidência em .zscripts/vercel-diag/env-patch-workspaces.json (gitignored).
Printa SOMENTE metadados (status/key/targets/updatedAt) — o valor não é secret,
mas por disciplina não é ecoado do response (fica no arquivo local gitignored).
"""
import json
import urllib.request
import urllib.error

ENV_FILE = "/home/z/my-project/.env"
PROJECT_ID = "prj_JlAHgua53UYdAnmDhaLykQSeg0CW"
TEAM_ID = "team_UwVqmKiOfeuCvwjfmZl8ryPr"
ENV_ID = "Lorf1yu0xlBsZgdK"  # WORKSPACES_ROOT (production+preview, sensitive)
EVIDENCE = "/home/z/my-project/.zscripts/vercel-diag/env-patch-workspaces.json"


def read_token() -> str:
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line.startswith("VERCEL_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("VERCEL_TOKEN não encontrado em .env")


def patch_env(token: str, value: str, targets: list) -> tuple:
    url = f"https://api.vercel.com/v10/projects/{PROJECT_ID}/env/{ENV_ID}?teamId={TEAM_ID}"
    body = json.dumps({"value": value, "target": targets, "type": "sensitive"}).encode()
    req = urllib.request.Request(url, data=body, method="PATCH", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def get_env(token: str) -> tuple:
    url = f"https://api.vercel.com/v10/projects/{PROJECT_ID}/env/{ENV_ID}?teamId={TEAM_ID}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def main():
    token = read_token()
    # 1) Estado ANTES (metadados)
    st_before, before = get_env(token)
    # 2) PATCH — valor novo, targets preservados production+preview
    st_patch, patched = patch_env(token, "/tmp/workspaces", ["production", "preview"])
    # 3) Estado DEPOIS (metadados)
    st_after, after = get_env(token)

    evidence = {
        "before": {"status": st_before, "key": before.get("key"),
                   "target": before.get("target"), "updatedAt": before.get("updatedAt")},
        "patch": {"status": st_patch, "key": patched.get("key"),
                  "target": patched.get("target"), "updatedAt": patched.get("updatedAt"),
                  "createdAt": patched.get("createdAt"),
                  "error": patched.get("error"), "message": patched.get("message")},
        "after": {"status": st_after, "key": after.get("key"),
                  "target": after.get("target"), "updatedAt": after.get("updatedAt")},
    }
    with open(EVIDENCE, "w") as f:
        json.dump(evidence, f, indent=2, ensure_ascii=False)

    print(f"GET antes ....... HTTP {st_before} | key={before.get('key')} | target={before.get('target')} | updatedAt={before.get('updatedAt')}")
    print(f"PATCH .......... HTTP {st_patch} | key={patched.get('key')} | target={patched.get('target')} | updatedAt={patched.get('updatedAt')}")
    if st_patch >= 400:
        print(f"ERRO do PATCH: {patched.get('error')} — {patched.get('message')}")
        raise SystemExit(1)
    print(f"GET depois ...... HTTP {st_after} | key={after.get('key')} | target={after.get('target')} | updatedAt={after.get('updatedAt')}")
    if after.get("updatedAt") == before.get("updatedAt"):
        print("AVISO: updatedAt não mudou — PATCH pode não ter aplicado")
        raise SystemExit(1)
    print("OK: WORKSPACES_ROOT atualizado (production+preview). Valor não ecoado; evidência em .zscripts/vercel-diag/env-patch-workspaces.json")


if __name__ == "__main__":
    main()
