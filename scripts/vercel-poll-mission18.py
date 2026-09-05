#!/usr/bin/env python3
"""Missão 18 — Poll do deployment de produção pós-push (16f8d39)."""
import json
import sys
import time
import urllib.request

ENV_FILE = "/home/z/my-project/.env"
PROJECT_ID = "prj_JlAHgua53UYdAnmDhaLykQSeg0CW"
TEAM_ID = "team_UwVqmKiOfeuCvwjfmZl8ryPr"
NEW_SHA_PREFIX = "ab97b5f"
EVIDENCE = "/home/z/my-project/.zscripts/vercel-diag/dep-mission18-final3.json"


def read_token() -> str:
    with open(ENV_FILE) as f:
        for line in f:
            if line.strip().startswith("VERCEL_TOKEN="):
                return line.strip().split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("VERCEL_TOKEN não encontrado")


def fetch_latest_prod(token: str) -> list:
    url = f"https://api.vercel.com/v6/deployments?projectId={PROJECT_ID}&teamId={TEAM_ID}&target=production&limit=3"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode()).get("deployments", [])


def fetch_deployment(token: str, dep_id: str) -> dict:
    url = f"https://api.vercel.com/v13/deployments/{dep_id}?teamId={TEAM_ID}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode())


def main():
    token = read_token()
    deadline = time.time() + 420
    target = None
    last = None
    while time.time() < deadline:
        deps = fetch_latest_prod(token)
        new = [d for d in deps if (d.get("meta", {}) or {}).get("githubCommitSha", "").startswith(NEW_SHA_PREFIX)]
        if new:
            target = new[0].get("uid")
            last = new[0].get("state")
            print(f"[poll] {target} → {last}", flush=True)
            if last in ("READY", "ERROR", "CANCELED"):
                break
        else:
            states = [(d.get("uid")[:16], d.get("state")) for d in deps[:2]]
            print(f"[poll] aguardando deploy do sha {NEW_SHA_PREFIX}… atuais: {states}", flush=True)
        time.sleep(10)

    if not target or last != "READY":
        print(f"FALHOU: target={target} state={last}")
        sys.exit(1)

    detail = fetch_deployment(token, target)
    with open(EVIDENCE, "w") as f:
        json.dump(detail, f, indent=2)
    aliases = [a if isinstance(a, str) else a.get("domain") for a in detail.get("alias", [])]
    print(f"READY: {target}")
    print(f"sha: {(detail.get('meta') or {}).get('githubCommitSha')}")
    print(f"aliases: {aliases}")
    print(f"errorCode: {detail.get('errorCode')!r}")


if __name__ == "__main__":
    main()
