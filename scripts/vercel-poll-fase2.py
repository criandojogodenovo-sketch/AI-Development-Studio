#!/usr/bin/env python3
"""Fase 2 — poll do deployment de produção pós-push (d5ff690)."""
import json
import sys
import time
import urllib.request

ENV_FILE = "/home/z/my-project/.env"
PROJECT_ID = "prj_JlAHgua53UYdAnmDhaLykQSeg0CW"
TEAM_ID = "team_UwVqmKiOfeuCvwjfmZl8ryPr"
SHA_PREFIX = sys.argv[1] if len(sys.argv) > 1 else "d5ff690"
EVIDENCE = "/home/z/my-project/.zscripts/vercel-diag/dep-fase2.json"


def read_token() -> str:
    with open(ENV_FILE) as f:
        for line in f:
            if line.strip().startswith("VERCEL_TOKEN="):
                return line.strip().split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("VERCEL_TOKEN não encontrado")


def fetch(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode())


def main() -> None:
    token = read_token()
    deadline = time.time() + 600  # 10 min
    target = None
    print(f"aguardando deployment do sha {SHA_PREFIX} (target=production)…")
    while time.time() < deadline:
        deps = fetch(
            f"https://api.vercel.com/v6/deployments?projectId={PROJECT_ID}&teamId={TEAM_ID}&target=production&limit=5",
            token,
        ).get("deployments", [])
        for d in deps:
            meta = d.get("meta", {}) or {}
            if str(meta.get("githubCommitSha", "")) .startswith(SHA_PREFIX) or str(d.get("sha", "")).startswith(SHA_PREFIX):
                target = d
                break
        if target:
            state = target.get("readyState") or target.get("state")
            dep_id = target.get("uid") or target.get("id") or "?"
            print(f"  deployment {dep_id} — {state}")
            if state in ("READY", "ERROR", "CANCELED"):
                break
        else:
            print("  (novo deployment ainda não apareceu…)")
        time.sleep(15)

    if not target:
        print("FALHOU: deployment não apareceu")
        sys.exit(1)

    dep_id = target.get("uid") or target.get("id")
    state = target.get("readyState") or target.get("state")
    detail = fetch(f"https://api.vercel.com/v13/deployments/{dep_id}?teamId={TEAM_ID}", token)
    url = detail.get("url") or target.get("url")
    with open(EVIDENCE, "w") as f:
        json.dump({"id": dep_id, "state": state, "url": url, "sha": detail.get("meta", {}).get("githubCommitSha")}, f, indent=2)

    if state != "READY":
        print(f"FALHOU: estado final {state}")
        sys.exit(1)

    print(f"PRONTO: {dep_id} READY")
    print(f"URL: https://{url}")


if __name__ == "__main__":
    main()
