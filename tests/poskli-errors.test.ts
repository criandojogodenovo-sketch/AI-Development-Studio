// ============================================================
// POSKLI ERRORS — TESTES UNITÁRIOS (node:test)
// Executar: node --test tests/poskli-errors.test.ts
// Valida a classificação de erros do pipeline (Tarefa C):
//   E1. QUOTA_EXHAUSTED: mensagem do chain → código próprio,
//       NÃO-retryável (para o run honestamente)
//   E2. Rate limits clássicos (429/BAI_RATE_LIMIT) → PROVIDER_RATE_LIMIT
//   E3. Sanitização de segredos no detail (nunca vazar chaves)
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyError } from '../src/lib/studio/poskli/errors.ts'

test('E1.1 — QUOTA_EXHAUSTED (mensagem do chain) → código QUOTA_EXHAUSTED, não-retryável', () => {
  const c = classifyError(
    'QUOTA_EXHAUSTED: bai/qwen3.8-flash devolveu 429 após 3 tentativas (backoff 5000/10000/20000ms) — run interrompido'
  )
  assert.equal(c.code, 'QUOTA_EXHAUSTED')
  assert.equal(c.retryable, false, 'cota esgotada JAMAIS re-tenta (política anti-loop)')
  assert.match(c.friendly, /[Cc]ota/)
})

test('E1.2 — Error objeto com QUOTA_EXHAUSTED também classifica', () => {
  const c = classifyError(new Error('QUOTA_EXHAUSTED: todas as paradas de rate limit do chain falharam'))
  assert.equal(c.code, 'QUOTA_EXHAUSTED')
  assert.equal(c.retryable, false)
})

test('E2.1 — 429 puro (sem QUOTA) → PROVIDER_RATE_LIMIT (legado preservado)', () => {
  const c = classifyError('BAI_RATE_LIMIT: limite do provedor atingido')
  assert.equal(c.code, 'PROVIDER_RATE_LIMIT')
  assert.equal(c.retryable, false)
})

test('E2.2 — "429 too many requests" → PROVIDER_RATE_LIMIT', () => {
  const c = classifyError('NVIDIA_HTTP_429: too many requests')
  assert.equal(c.code, 'PROVIDER_RATE_LIMIT')
})

test('E3.1 — detail sanitiza chaves/tokens conhecidos', () => {
  const c = classifyError('QUOTA_EXHAUSTED após falha com sk-abcdefghijklmnop12345 e ghp_AbCdEf0123456789abcdefghij')
  assert.ok(!c.detail.includes('sk-abcdefghijklmnop12345'), 'chave sk- não pode aparecer')
  assert.ok(!c.detail.includes('ghp_AbCdEf0123456789'), 'PAT GitHub não pode aparecer')
  assert.ok(c.detail.includes('[REDACTED]'))
})
