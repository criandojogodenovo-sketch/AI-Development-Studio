// ============================================================
// SEGURANÇA — Rate limiting em memória (janela deslizante)
// Protege API em geral e inícios de pipeline de agentes.
// ============================================================

import { STUDIO_CONFIG } from '../config'

interface Bucket {
  hits: number[]
}

const buckets = new Map<string, Bucket>()

function take(key: string, windowMs: number, max: number): { allowed: boolean; remaining: number } {
  const now = Date.now()
  const bucket = buckets.get(key) ?? { hits: [] }
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs)
  if (bucket.hits.length >= max) {
    buckets.set(key, bucket)
    return { allowed: false, remaining: 0 }
  }
  bucket.hits.push(now)
  buckets.set(key, bucket)
  if (buckets.size > 5000) {
    // higiene: remove buckets vazios
    for (const [k, v] of buckets) {
      if (v.hits.length === 0) buckets.delete(k)
    }
  }
  return { allowed: true, remaining: max - bucket.hits.length }
}

/** Rate limit geral de API por IP. */
export function rateLimitApi(ip: string) {
  return take(
    `api:${ip}`,
    STUDIO_CONFIG.security.rateLimitWindowMs,
    STUDIO_CONFIG.security.rateLimitMaxRequests
  )
}

/** Rate limit para iniciar runs de agentes (mais restrito). */
export function rateLimitAgentRun(ip: string, userId: string) {
  return take(
    `run:${userId}:${ip}`,
    STUDIO_CONFIG.security.rateLimitWindowMs,
    STUDIO_CONFIG.security.runRateLimitPerMin
  )
}

export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'local'
}
