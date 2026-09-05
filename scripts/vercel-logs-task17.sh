#!/usr/bin/env bash
# Task 17 — Runtime logs do deployment atual (htvremq54 = dpl_3vdPv8mNNFaiamTjQtr4rZwJ5JdP)
set -euo pipefail
cd /home/z/my-project

TOKEN=$(grep -m1 '^VERCEL_TOKEN=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -z "$TOKEN" ]; then echo "ERRO: token vazio"; exit 1; fi

unset DATABASE_URL
timeout 60 bunx vercel logs https://ai-development-studio-htvremq54-mad-ae04.vercel.app \
  --scope mad-ae04 \
  --token "$TOKEN" 2>&1 | tee .zscripts/vercel-diag/runtime-logs-task17.txt | tail -80
