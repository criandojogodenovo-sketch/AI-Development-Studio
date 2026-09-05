#!/usr/bin/env python3
"""Task 17 — Consulta deployments de produção (read-only) para confirmar o alvo do redeploy."""
import json
import urllib.request

ENV_FILE = "/home/z/my-project/.env"
PROJECT_ID = "prj_JlAHgua53UYdAnmDhaLykQSeg0CW"
TEAM_ID = "team_UwVqmKiOfeuCvwjfmZl8ryPr"
EVIDENCE = "/home/z/my-project/.zscripts/vercel-diag/deployments-prod-latest.json"


def read_token() -> str:
    with open(ENV_FILE) as f:
        for line in f:
            if line.strip().startswith("VERCEL_TOKEN="):
                return line.strip().split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("VERCEL_TOKEN não encontrado")


def main():
    token = read_token()
    url = f"https://api.vercel.com/v6/deployments?projectId={PROJECT_ID}&teamId={TEAM_ID}&target=production&limit=5"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as res:
        data = json.loads(res.read().decode())
    with open(EVIDENCE, "w") as f:
        json.dump(data, f, indent=2)
    for d in data.get("deployments", []):
        print(f"{d.get('uid')} | {d.get('state')} | sha={d.get('meta', {}).get('githubCommitSha', '?')[:7] if d.get('meta') else '?'} | created={d.get('created')}")


if __name__ == "__main__":
    main()
