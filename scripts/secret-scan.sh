#!/usr/bin/env bash
# ============================================================
# SECRET SCAN — verificação OBRIGATÓRIA antes de qualquer commit
# Analisa TODOS os arquivos rastreados pelo git (git ls-files).
# Sai com código 1 se encontrar material sensível.
# ============================================================
set -u
cd "$(dirname "$0")/.."

FAIL=0
scan() {
  # $1 = padrão (ERE), $2 = descrição
  # Exclui: .env.example (só placeholders) e o próprio scanner (suas regexes
  # de detecção casariam consigo mesmas — falso positivo de auto-referência).
  local pattern="$1" desc="$2"
  local hits
  hits=$(git ls-files -z | xargs -0 grep -lE "$pattern" 2>/dev/null | grep -vE '^(\.env\.example|scripts/secret-scan\.sh)$' || true)
  if [ -n "$hits" ]; then
    echo "❌ $desc:"
    echo "$hits" | sed 's/^/   /'
    FAIL=1
  else
    echo "✅ $desc"
  fi
}

echo "== SECRET SCAN ($(git ls-files | wc -l) arquivos rastreados) =="

# .env real não deve estar rastreado
if git ls-files | grep -qx '\.env'; then
  echo "❌ .env está rastreado no git"; FAIL=1
else
  echo "✅ .env não rastreado"
fi
if git ls-files | grep -qx '\.env\.example'; then
  # .env.example só pode ter placeholders vazios para secrets
  if grep -E '^(BAI_API_KEY_1|BAI_API_KEY_2|DATABASE_URL|GITHUB_TOKEN|GITHUB_CLIENT_SECRET|AUTH_SECRET)=' .env.example | grep -vE '^(BAI_API_KEY_1|BAI_API_KEY_2|GITHUB_TOKEN|GITHUB_CLIENT_SECRET)=\s*$' | grep -vE '^(DATABASE_URL)=\s*$' | grep -vE '^AUTH_SECRET=troque-por-um-segredo-forte-aleatorio' | grep -qvE '^(GLM_MODEL|QWEN_MODEL|HY3_MODEL|DEEPSEEK_MODEL|ENABLE_DEEPSEEK)='; then
    echo "❌ .env.example contém valor preenchido em secret (deve ser placeholder vazio)"; FAIL=1
  else
    echo "✅ .env.example apenas com placeholders não-secretos"
  fi
fi

# connection strings com credenciais em código
scan 'postgres(ql)?://[A-Za-z0-9_]+:[^@[:space:]]+@' "connection string PostgreSQL com credenciais"
scan 'mysql://[A-Za-z0-9_]+:[^@[:space:]]+@' "connection string MySQL"
scan 'redis://:[^@[:space:]]+@' "connection string Redis com senha"

# chaves de API com cara de real (tokens longos atribuídos a variáveis)
scan '(BAI_API_KEY|GITHUB_TOKEN|GITHUB_CLIENT_SECRET|ANTHROPIC_API_KEY|OPENAI_API_KEY|API_KEY)[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_\-]{24,}' "valor de API key atribuído em código"

# tokens GitHub clássicos / fine-grained / OAuth
scan 'ghp_[A-Za-z0-9]{36}' "token GitHub clássico (ghp_)"
scan 'github_pat_[A-Za-z0-9_]{40,}' "token GitHub fine-grained"
scan 'gho_[A-Za-z0-9]{36}' "token OAuth GitHub"

# secrets vazando para o frontend — uso REAL (process.env.* ou atribuição com valor),
# não menções em documentação ("nunca use NEXT_PUBLIC_...")
scan 'process\.env\.NEXT_PUBLIC_(DATABASE_URL|GITHUB_TOKEN|BAI|.*API_KEY|.*SECRET)' "leitura de secret via process.env.NEXT_PUBLIC_*"
scan 'NEXT_PUBLIC_(DATABASE_URL|GITHUB_TOKEN|BAI_API_KEY|GITHUB_CLIENT_SECRET)[A-Z_]*=[^[:space:]]+' "atribuição de valor a NEXT_PUBLIC_ de secret"

# Authorization Bearer com token longo hardcoded
scan '[Bb]earer[[:space:]]+[A-Za-z0-9_\-\.]{32,}' "Bearer token hardcoded"

# private keys
scan 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY' "chave privada"

if [ "$FAIL" -eq 1 ]; then
  echo "== RESULTADO: FALHOU — NÃO COMMITAR =="
  exit 1
fi
echo "== RESULTADO: LIMPO =="
