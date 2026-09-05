#!/usr/bin/env bash
# Task 17 — Redeploy do deployment de produção atual (dpl_MRxYVKCygDH9x6dFx9er6WE6QPRS)
# Token lido de .env (NUNCA impresso). DATABASE_URL desfeita para evitar
# interferência do .env local na detecção de projeto do CLI.
set -euo pipefail
cd /home/z/my-project

TOKEN=$(grep -m1 '^VERCEL_TOKEN=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -z "$TOKEN" ]; then echo "ERRO: token vazio"; exit 1; fi

unset DATABASE_URL
bunx vercel redeploy dpl_MRxYVKCygDH9x6dFx9er6WE6QPRS \
  --scope mad-ae04 \
  --token "$TOKEN" \
  --no-wait 2>&1
