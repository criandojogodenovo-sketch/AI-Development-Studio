#!/usr/bin/env python3
"""Fase 2 — garante GITHUB_TOKEN nas env vars da Vercel (production+preview).
Token lido do .env local; NUNCA impresso em output."""
import json
import urllib.request
import urllib.error

ENV_FILE = "/home/z/my-project/.env"
PROJECT_ID = "prj_JlAHgua53UYdAnmDhaLykQSeg0CW"
TEAM_ID = "team_UwVqmKiOfeuCvwjfmZl8ryPr"


def read_env(key: str) -> str:
    with open(ENV_FILE) as f:
        for line in f:
            if line.strip().startswith(key + "="):
                return line.strip().split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"{key} não encontrado no .env")


def main():
    vtoken = read_env("VERCEL_TOKEN")
    gtoken = read_env("GITHUB_TOKEN")
    headers = {"Authorization": f"Bearer {vtoken}", "Content-Type": "application/json"}

    # 1) lista env existentes
    url = f"https://api.vercel.com/v9/projects/{PROJECT_ID}/env?teamId={TEAM_ID}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {vtoken}"})
    with urllib.request.urlopen(req) as res:
        envs = json.loads(res.read().decode()).get("envs", [])
    existing = [e for e in envs if e["key"] == "GITHUB_TOKEN"]
    print(f"env GITHUB_TOKEN existente: {len(existing)} entrada(s)")

    if existing:
        env_id = existing[0]["id"]
        # atualiza valor + targets (mantém o type existente — Sensitive não pode mudar)
        data = json.dumps({
            "value": gtoken,
            "target": ["production", "preview"],
        }).encode()
        req = urllib.request.Request(
            f"https://api.vercel.com/v10/projects/{PROJECT_ID}/env/{env_id}?teamId={TEAM_ID}",
            data=data, headers={**headers, "Content-Type": "application/json"}, method="PATCH",
        )
        try:
            with urllib.request.urlopen(req) as res:
                out = json.loads(res.read().decode())
                print(f"PATCH ok: key={out.get('key')} target={out.get('target')} type={out.get('type')}")
        except urllib.error.HTTPError as e:
            print(f"PATCH falhou: {e.code} {e.read().decode()[:200]}")
            raise SystemExit(1)
    else:
        data = json.dumps({
            "key": "GITHUB_TOKEN",
            "value": gtoken,
            "target": ["production", "preview"],
            "type": "encrypted",
        }).encode()
        req = urllib.request.Request(
            f"https://api.vercel.com/v10/projects/{PROJECT_ID}/env?teamId={TEAM_ID}",
            data=data, headers={**headers, "Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req) as res:
                out = json.loads(res.read().decode())
                print(f"POST ok: key={out.get('key')} target={out.get('target')} type={out.get('type')}")
        except urllib.error.HTTPError as e:
            print(f"POST falhou: {e.code} {e.read().decode()[:200]}")
            raise SystemExit(1)

    print("GITHUB_TOKEN configurado na Vercel (valor nunca exibido)")


if __name__ == "__main__":
    main()
