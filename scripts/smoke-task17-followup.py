#!/usr/bin/env python3
"""Task 17 — Follow-up: estado ATUAL do projeto do smoke test, minutos após o run."""
import http.cookiejar
import json
import time
import urllib.request

BASE = "https://ai-development-studio-gamma.vercel.app"
EVIDENCE = "/home/z/my-project/.zscripts/vercel-diag/smoke-task17-followup.json"
EMAIL, PASSWORD = None, None

d = json.load(open("/home/z/my-project/.zscripts/vercel-diag/smoke-task17.json"))
EMAIL = d["user"]
PASSWORD = "Smoke-Task17-OK!"
PROJECT = next(r["response"]["project"]["id"] for r in d["results"]
               if r["name"] == "criar projeto (ENOENT anterior)" and r.get("response"))

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with opener.open(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


code, login = call("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
print(f"login: {code}")
code, detail = call("GET", f"/api/projects/{PROJECT}")
status = detail.get("project", {}).get("status") if isinstance(detail, dict) else "?"
runs = detail.get("runs", []) if isinstance(detail, dict) else []
print(f"projeto {PROJECT}: status={status} runs={len(runs)}")
for r in runs[:5]:
    print(f"  run: agent={r.get('agentId')} model={r.get('model')} status={r.get('status')} tokensIn={r.get('tokensIn')} tokensOut={r.get('tokensOut')}")
code, act = call("GET", f"/api/activity?project={PROJECT}&take=100")
evs = act.get("events", []) if isinstance(act, dict) else []
print(f"eventos: {len(evs)}")
for e in evs[-10:]:
    print(f"  {e.get('type')}: {str(e.get('message'))[:110]}")
json.dump({"status": status, "runs": runs, "events": evs}, open(EVIDENCE, "w"), indent=2, ensure_ascii=False)
print(f"(evidência: {EVIDENCE})")
