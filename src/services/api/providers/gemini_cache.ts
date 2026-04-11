/**
 * Gemini context cache manager.
 *
 * Gemini 2.5+ exposes a `cachedContents` API that lets you pre-cache a
 * system prompt + tool schemas once and then reference them by name in
 * subsequent `generateContent` calls. The cached portion is billed at a
 * steep discount (~75% off input token cost), which is a real win for
 * agent-loop workloads where the same ~5 KB system prompt is sent on
 * every turn.
 *
 * This module:
 *   - computes a stable key from (model + systemInstruction + tools)
 *   - keeps an in-memory Map of {key → cacheName} with a 5-minute TTL
 *     that matches Gemini's server-side TTL default
 *   - creates a new cache lazily when a request exceeds the size threshold
 *   - tracks failures with a short cooldown so we don't hammer the API
 *     with "too small" requests
 *   - provides `invalidateCache(cacheName)` so the provider can drop a
 *     stale entry when a request returns 404/expired
 *
 * IMPORTANT: this is currently API-key-path-only. Google's Code Assist
 * proxy (used for OAuth-scope-cloud-platform tokens) does not expose a
 * verified cachedContents endpoint, so OAuth users still send the system
 * prompt inline every turn. That's a known limitation, not a regression.
 */

import { createHash } from 'crypto'

interface CacheEntry {
  cacheName: string // "cachedContents/xxxxx"
  expiresAt: number // epoch ms
  model: string
}

interface CacheMiss {
  reason: 'too_small' | 'unsupported' | 'error'
  retryAfter: number // epoch ms — don't retry until after this
}

// Gemini's default TTL is 5 minutes; we expire one second earlier so we
// never reference a cache that just died on the server side.
const CACHE_TTL_MS = 5 * 60 * 1000 - 1000

// If caching failed (e.g. prompt was too small), don't retry the same key
// for a minute — subsequent requests in that window fall back to inline.
const MISS_COOLDOWN_MS = 60 * 1000

// Minimum payload size before we even attempt to cache. Gemini rejects
// small caches with a hard error; skipping the round trip saves latency.
// 4 KB chars ≈ ~1 K tokens, comfortably over the smallest tier's floor.
const MIN_CACHE_SIZE_CHARS = 4096

/**
 * Models that support context caching. Gemini 2.5+ chat models and the
 * 3.x preview family. Image/audio/TTS models are intentionally excluded —
 * they don't ingest a long system prompt in the first place.
 */
const CACHE_CAPABLE_MODELS = new Set<string>([
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
])

// In-process stores. Per-process is correct here — caches are tied to
// the API key, not to the user identity beyond that.
const _caches = new Map<string, CacheEntry>()
const _misses = new Map<string, CacheMiss>()

function supportsCaching(model: string): boolean {
  return CACHE_CAPABLE_MODELS.has(model)
}

function computeKey(
  model: string,
  systemInstruction: unknown,
  tools: unknown,
): string {
  const systemJson = JSON.stringify(systemInstruction ?? null)
  const toolsJson = JSON.stringify(tools ?? null)
  return createHash('sha256')
    .update(model)
    .update('|')
    .update(systemJson)
    .update('|')
    .update(toolsJson)
    .digest('hex')
}

function approxSize(systemInstruction: unknown, tools: unknown): number {
  return (
    JSON.stringify(systemInstruction ?? '').length +
    JSON.stringify(tools ?? '').length
  )
}

export interface GetOrCreateCacheArgs {
  model: string
  /** Base URL for the Gemini v1beta endpoint (API-key path only). */
  baseUrl: string
  apiKey: string
  systemInstruction: unknown
  tools: unknown
}

/**
 * Returns an existing cache name if valid, otherwise creates a new one.
 * Returns null if the request isn't cache-eligible (unsupported model,
 * too small, in cooldown, or creation failed). On null, the caller must
 * fall back to sending the system prompt + tools inline.
 */
export async function getOrCreateCache(
  args: GetOrCreateCacheArgs,
): Promise<string | null> {
  const { model, baseUrl, apiKey, systemInstruction, tools } = args

  if (!supportsCaching(model)) return null
  if (!apiKey) return null
  if (approxSize(systemInstruction, tools) < MIN_CACHE_SIZE_CHARS) return null

  const key = computeKey(model, systemInstruction, tools)

  // Honor active miss cooldown.
  const miss = _misses.get(key)
  if (miss && Date.now() < miss.retryAfter) return null
  if (miss) _misses.delete(key)

  // Return existing cache if still valid.
  const existing = _caches.get(key)
  if (existing && Date.now() < existing.expiresAt) return existing.cacheName
  if (existing) _caches.delete(key)

  // Create a new cache.
  try {
    const body: Record<string, unknown> = {
      model: `models/${model}`,
      ttl: '300s',
    }
    if (systemInstruction) body.systemInstruction = systemInstruction
    if (tools) body.tools = tools

    const response = await fetch(
      `${baseUrl}/cachedContents?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      const reason: CacheMiss['reason'] =
        errText.toLowerCase().includes('minimum') ||
        errText.toLowerCase().includes('too small')
          ? 'too_small'
          : 'error'
      _misses.set(key, {
        reason,
        retryAfter: Date.now() + MISS_COOLDOWN_MS,
      })
      return null
    }

    const data = (await response.json()) as { name?: string }
    if (!data.name) {
      _misses.set(key, {
        reason: 'error',
        retryAfter: Date.now() + MISS_COOLDOWN_MS,
      })
      return null
    }

    _caches.set(key, {
      cacheName: data.name,
      expiresAt: Date.now() + CACHE_TTL_MS,
      model,
    })
    return data.name
  } catch {
    _misses.set(key, {
      reason: 'error',
      retryAfter: Date.now() + MISS_COOLDOWN_MS,
    })
    return null
  }
}

/**
 * Drop a cache entry from the map — call this when a request using this
 * cache name returned 404/expired so the next call creates a fresh one.
 */
export function invalidateCache(cacheName: string): void {
  for (const [key, entry] of _caches.entries()) {
    if (entry.cacheName === cacheName) {
      _caches.delete(key)
      return
    }
  }
}

/** Test hook — clear all cache state. Not used in prod. */
export function _resetGeminiCacheStateForTests(): void {
  _caches.clear()
  _misses.clear()
}
