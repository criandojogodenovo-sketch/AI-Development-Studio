#!/usr/bin/env python3
"""Task 17 — Poll do novo deployment de produção até READY/ERROR/CANCELED."""
import json
import sys
import time
import urllib.request

ENV_FILE = "/home/z/my-project/.env"
PROJECT_ID = "prj_JlAHgua53UYdAnmDhaLykQSeg0CW"
TEAM_ID = "team_UwVqmKiOfeuCvwjfmZl8ryPr"
THRESHOLD_CREATED = 1788634326529  # updatedAt do PATCH — deployments criados depois disso são novos
EVIDENCE = "/home/z/my-project/.zscripts/vercel-diag/dep-task17.json"


def read_token() -> str:
    with open(ENV_FILE) as f:
        for line in f:
            if line.strip().startswith("VERCEL_TOKEN="):
                return line.strip().split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("VERCEL_TOKEN não encontrado")


def fetch_latest_prod(token: str) -> dict:
    url = f"https://api.vercel.com/v6/deployments?projectId={PROJECT_ID}&teamId={TEAM_ID}&target=production&limit=3"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode())


def fetch_deployment(token: str, dep_id: str) -> dict:
    url = f"https://api.vercel.com/v13/deployments/{dep_id}?teamId={TEAM_ID}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode())


def main():
    token = read_token()
    deadline = time.time() + 420  # 7 min máximo
    target_uid = None
    last_state = None
    while time.time() < deadline:
        data = fetch_latest_prod(token)
        deps = data.get("deployments", [])
        new = [d for d in deps if d.get("created", 0) > THRESHOLD_CREATED]
        if new:
            d = new[0]
            target_uid = d.get("uid")
            last_state = d.get("state")
            print(f"[poll] {target_uid} → {last_state}", flush=True)
            if last_state in ("READY", "ERROR", "CANCELED"):
                break
        else:
            print("[poll] aguardando novo deployment aparecer…", flush=True)
        time.sleep(10)

    if target_uid is None:
        print("TIMEOUT: novo deployment não apareceu")
        sys.exit(1)
    if last_state != "READY":
        print(f"ESTADO FINAL: {last_state} (não READY)")
        sys.exit(1)

    detail = fetch_deployment(token, target_uid)
    with open(EVIDENCE, "w") as f:
        json.dump(detail, f, indent=2)
    alias = [a if isinstance(a, str) else a.get("domain") for a in detail.get("alias", [])]
    print(f"READY: {target_uid}")
    print(f"sha: {detail.get('meta', {}).get('githubCommitSha', '?')}")
    print(f"aliases: {alias}")
    print(f"errorCode: {detail.get('errorCode')!r} | errorMessage: {detail.get('errorMessage')!r}")


if __name__ == "__main__":
    main()
