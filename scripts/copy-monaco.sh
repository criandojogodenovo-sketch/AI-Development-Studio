#!/usr/bin/env bash
# ============================================================
# copy-monaco.sh — materializa os assets do Monaco Editor em
# public/monaco/vs (servidos localmente; NUNCA via CDN).
# Rodado automaticamente por "dev" e "build" (package.json).
# ============================================================
set -e
SRC="node_modules/monaco-editor/min/vs"
DST="public/monaco/vs"

if [ ! -d "$SRC" ]; then
  echo "[copy-monaco] monaco-editor não instalado — pulando"
  exit 0
fi

if [ -f "$DST/editor/editor.main.js" ] && [ "$DST/loader.js" -nt "$SRC/loader.js" ] 2>/dev/null; then
  echo "[copy-monaco] assets já atualizados"
  exit 0
fi

mkdir -p "$DST"
cp -r "$SRC/." "$DST/"
# localizações não usadas (menos 4MB)
find "$DST" -maxdepth 1 -name "nls.messages.*.js" -delete 2>/dev/null || true
echo "[copy-monaco] assets copiados para $DST"
