/**
 * Google Gemini Code Assist client — used for OAuth-authenticated Gemini access.
 *
 * Background: the Antigravity OAuth client (used by google_oauth.ts) has
 * scopes for `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`
 * and `experimentsandconfigs`. The public AI Studio endpoint
 * (`generativelanguage.googleapis.com`) rejects tokens without the
 * `generative-language` scope ("403 restricted_client"), so OAuth calls must
 * go through the Code Assist endpoint instead.
 *
 * Code Assist endpoint:
 *   https://cloudcode-pa.googleapis.com/v1internal:{method}
 *
 * Request body is wrapped (Antigravity format from CLIProxyAPI):
 *   { model, userAgent, requestType, project, requestId, request: { sessionId, contents, ...config } }
 *
 * Response body is wrapped:
 *   { response: { candidates, usageMetadata, ... } }
 *
 * Before making calls, the user must be "onboarded" — this happens once via
 * loadCodeAssist → onboardUser, and the returned project ID is cached on disk.
 *
 * IMPORTANT: metadata.ideType MUST be "ANTIGRAVITY" (not IDE_UNSPECIFIED)
 * and the request must carry the User-Agent / X-Goog-Api-Client /
 * Client-Metadata headers below. That's the combination that routes
 * quota against the Antigravity pool instead of the free Code Assist
 * tier — and it's the difference between gemini-3-pro-preview working
 * and throwing "Rate limit or quota exceeded" on the second message.
 *
 * Ported from router-for-me/CLIProxyAPI internal/auth/antigravity/auth.go.
 */

import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import type {
  GeminiGenerateContentResponse,
  GeminiStreamChunk,
} from '../adapters/gemini_to_anthropic.js'

export const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com/v1internal'

// ─── Executor types ──────────────────────────────────────────────────
// Two distinct executors route to the same Code Assist proxy but with
// different body envelopes, headers, and quota pools.

export type GeminiExecutor = 'cli' | 'antigravity'

// Antigravity-specific models — everything else is Gemini CLI.
const ANTIGRAVITY_MODEL_SET = new Set([
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gemini-3-flash',
])

/** Determine which executor a model belongs to. */
export function executorForModel(model: string): GeminiExecutor {
  return ANTIGRAVITY_MODEL_SET.has(model) ? 'antigravity' : 'cli'
}

// CLIProxyAPI's Antigravity onboarding headers. These are used during
// loadCodeAssist / onboardUser — NOT on generateContent calls.
const API_USER_AGENT = 'google-api-nodejs-client/9.15.1'
const API_CLIENT = 'google-cloud-sdk vscode_cloudshelleditor/0.1'
const CLIENT_METADATA =
  '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'

const CONFIG_DIR = join(homedir(), '.config', 'claude-code')

// Per-executor cache files — each executor type gets its own onboarding
// and project ID because the Code Assist server tracks them separately.
const CACHE_FILE_CLI = join(CONFIG_DIR, 'gemini-code-assist-cli.json')
const CACHE_FILE_ANTIGRAVITY = join(CONFIG_DIR, 'gemini-code-assist.json')

const CACHE_VERSION = 3  // bump: split caches per executor

interface CodeAssistCache {
  version: number
  projectId: string | null
  onboardedAt: number
}

// In-memory caches — one per executor type
let _cachedCli: CodeAssistCache | null = null
let _cachedAntigravity: CodeAssistCache | null = null

/**
 * Clear the cached project ID for an executor. Called when we get a 403
 * "does not have permission" error — the cached project is stale and the
 * next call will re-onboard to get a fresh project ID.
 */
export function clearCodeAssistCache(executor?: GeminiExecutor): void {
  if (!executor || executor === 'cli') {
    _cachedCli = null
    try { const f = _cacheFileFor('cli'); if (existsSync(f)) writeFileSync(f, '{}') } catch {}
  }
  if (!executor || executor === 'antigravity') {
    _cachedAntigravity = null
    try { const f = _cacheFileFor('antigravity'); if (existsSync(f)) writeFileSync(f, '{}') } catch {}
  }
}

function _cacheFileFor(executor: GeminiExecutor): string {
  return executor === 'cli' ? CACHE_FILE_CLI : CACHE_FILE_ANTIGRAVITY
}

function _readCache(executor: GeminiExecutor): CodeAssistCache | null {
  const mem = executor === 'cli' ? _cachedCli : _cachedAntigravity
  if (mem) return mem
  try {
    const file = _cacheFileFor(executor)
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as CodeAssistCache
    if ((parsed.version ?? 0) < CACHE_VERSION) return null
    if (executor === 'cli') _cachedCli = parsed
    else _cachedAntigravity = parsed
    return parsed
  } catch {
    return null
  }
}

function _writeCache(executor: GeminiExecutor, cache: CodeAssistCache): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(_cacheFileFor(executor), JSON.stringify(cache, null, 2))
    if (executor === 'cli') _cachedCli = cache
    else _cachedAntigravity = cache
  } catch {
    // Cache is best-effort.
  }
}

/** Onboarding headers for the Antigravity executor. */
function _antigravityOnboardHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': API_USER_AGENT,
    'X-Goog-Api-Client': API_CLIENT,
    'Client-Metadata': CLIENT_METADATA,
    'Connection': 'keep-alive',
  }
}

/** Onboarding headers for the Gemini CLI executor. */
function _cliOnboardHeaders(accessToken: string): Record<string, string> {
  const os = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x86'
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': `GeminiCLI/0.31.0 (${os}; ${arch})`,
    'X-Goog-Api-Client': 'google-genai-sdk/1.41.0 gl-node/v22.19.0',
    'Connection': 'keep-alive',
  }
}

// ─── Onboarding ──────────────────────────────────────────────────────

/**
 * Ensure the user is onboarded to Code Assist and return the project ID.
 *
 * Each executor type (CLI vs Antigravity) has its own cache and uses
 * different onboarding headers/metadata so the server associates the
 * project with the right quota pool.
 */
export async function ensureCodeAssistReady(
  accessToken: string,
  executor: GeminiExecutor = 'antigravity',
): Promise<string | null> {
  const cached = _readCache(executor)
  if (cached) return cached.projectId

  // CLI uses GEMINI_CLI ideType; Antigravity uses ANTIGRAVITY.
  const ideType = executor === 'cli' ? 'GEMINI_CLI' : 'ANTIGRAVITY'
  const headers = executor === 'cli'
    ? _cliOnboardHeaders(accessToken)
    : _antigravityOnboardHeaders(accessToken)

  const loadReqBody = {
    metadata: {
      ideType,
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    },
  }

  const loadRes = await fetch(`${CODE_ASSIST_BASE}:loadCodeAssist`, {
    method: 'POST',
    headers,
    body: JSON.stringify(loadReqBody),
  })

  if (!loadRes.ok) {
    const errText = await loadRes.text().catch(() => '')
    throw new Error(
      `Gemini Code Assist loadCodeAssist failed (${loadRes.status}): ${errText.slice(0, 300)}`,
    )
  }

  // The response shape for cloudaicompanionProject is either a plain
  // string or an object with an `id` field (CLIProxyAPI handles both
  // cases — we do too).
  const loadData = (await loadRes.json()) as {
    cloudaicompanionProject?: string | { id?: string }
    allowedTiers?: Array<{
      id?: string
      name?: string
      isDefault?: boolean
    }>
  }

  const directProjectId = _extractProjectId(loadData.cloudaicompanionProject)
  if (directProjectId) {
    _writeCache(executor, {
      version: CACHE_VERSION,
      projectId: directProjectId,
      onboardedAt: Date.now(),
    })
    return directProjectId
  }

  // No project bound yet → run onboardUser. Pick the default allowed
  // tier, or fall back to "legacy-tier" the way CLIProxyAPI does.
  let tierId = 'legacy-tier'
  if (loadData.allowedTiers) {
    for (const tier of loadData.allowedTiers) {
      if (tier.isDefault && tier.id && tier.id.trim() !== '') {
        tierId = tier.id.trim()
        break
      }
    }
  }

  const onboardedProject = await _onboardUser(accessToken, tierId, executor)
  _writeCache(executor, {
    version: CACHE_VERSION,
    projectId: onboardedProject,
    onboardedAt: Date.now(),
  })
  return onboardedProject
}

/**
 * Extract a project id out of the polymorphic shapes the Code Assist
 * API returns:
 *   - `"project-123"`                 (plain string)
 *   - `{ id: "project-123" }`         (wrapper object)
 *   - anything else / missing → null.
 */
function _extractProjectId(
  value: string | { id?: string } | undefined,
): string | null {
  if (!value) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'object' && typeof value.id === 'string') {
    const trimmed = value.id.trim()
    return trimmed ? trimmed : null
  }
  return null
}

/**
 * Run Code Assist onboardUser and poll for completion, following
 * CLIProxyAPI's retry loop (5 attempts, 2s between, 30s timeout each).
 * Throws if we can't extract a project id after the final attempt.
 */
async function _onboardUser(
  accessToken: string,
  tierId: string,
  executor: GeminiExecutor = 'antigravity',
): Promise<string | null> {
  const ideType = executor === 'cli' ? 'GEMINI_CLI' : 'ANTIGRAVITY'
  const headers = executor === 'cli'
    ? _cliOnboardHeaders(accessToken)
    : _antigravityOnboardHeaders(accessToken)
  const requestBody = {
    tierId,
    metadata: {
      ideType,
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    },
  }
  const bodyJson = JSON.stringify(requestBody)

  const maxAttempts = 5
  let lastErr: string | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const perRequestTimeout = setTimeout(() => controller.abort(), 30_000)

    let res: Response
    try {
      res = await fetch(`${CODE_ASSIST_BASE}:onboardUser`, {
        method: 'POST',
        headers,
        body: bodyJson,
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(perRequestTimeout)
      lastErr = e instanceof Error ? e.message : String(e)
      throw new Error(
        `Gemini Code Assist onboardUser request failed: ${lastErr}`,
      )
    }
    clearTimeout(perRequestTimeout)

    const text = await res.text().catch(() => '')

    if (!res.ok) {
      const preview = text.trim().slice(0, 200)
      throw new Error(
        `Gemini Code Assist onboardUser failed (${res.status}): ${preview}`,
      )
    }

    let data: {
      done?: boolean
      response?: {
        cloudaicompanionProject?: string | { id?: string }
      }
    } = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch (e) {
      throw new Error(
        `Gemini Code Assist onboardUser returned non-JSON: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }

    if (data.done === true) {
      const projectId = _extractProjectId(data.response?.cloudaicompanionProject)
      if (projectId) return projectId
      throw new Error(
        'Gemini Code Assist onboardUser finished without a project id. ' +
          'Try signing out and back in with /provider.',
      )
    }

    // Not done yet — wait and retry. Use 1.5s instead of CLIProxyAPI's 2s
    // cadence to reduce first-request latency.
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  throw new Error(
    'Gemini Code Assist onboardUser did not complete after 5 attempts. ' +
      'This usually means the Google account is missing Antigravity access — ' +
      'check the account at https://antigravity.google.com and try again.',
  )
}

// ─── Request wrapping ────────────────────────────────────────────────

export interface CodeAssistWrapperBody {
  model: string
  userAgent: string
  requestType: string
  project: string
  requestId: string
  request: Record<string, unknown>
}

/**
 * Wrap a standard Gemini generateContent request body in the Code Assist
 * envelope shape.
 *
 * Matches CLIProxyAPI's geminiToAntigravity() format:
 *   - userAgent "antigravity" — tells the server which client so quota is
 *     routed to the Antigravity pool rather than the free Code Assist tier
 *   - requestType "agent" — classifies the request
 *   - requestId "agent-<uuid>" — per-request identifier
 *   - request.sessionId — stable hash for dedup (derived from first user msg)
 *   - request.safetySettings deleted (Antigravity executor strips these)
 */
export function wrapForCodeAssist(
  model: string,
  projectId: string | null,
  innerRequest: Record<string, unknown>,
): CodeAssistWrapperBody {
  // Strip safetySettings — the Antigravity executor always removes them.
  // Also strip maxOutputTokens for non-Claude models (Antigravity executor
  // deletes request.generationConfig.maxOutputTokens for Gemini models).
  const request = { ...innerRequest }
  delete request.safetySettings
  if (!model.includes('claude')) {
    const gc = request.generationConfig as Record<string, unknown> | undefined
    if (gc) {
      delete gc.maxOutputTokens
    }
  }

  // Generate stable session ID from first user message (matches CLIProxyAPI's
  // generateStableSessionID).
  request.sessionId = _stableSessionId(request)

  return {
    model,
    userAgent: 'antigravity',
    requestType: model.includes('image') ? 'image_gen' : 'agent',
    project: projectId ?? _randomProjectId(),
    requestId: model.includes('image')
      ? `image_gen/${Date.now()}/${randomUUID()}/12`
      : `agent-${randomUUID()}`,
    request,
  }
}

/**
 * Wrap a standard Gemini generateContent request in the Gemini CLI envelope.
 *
 * Simpler than the Antigravity format — just `{model, project, request}`.
 * safetySettings and maxOutputTokens are kept (the CLI executor does not strip them).
 *
 * From CLIProxyAPI internal/translator/gemini-cli/gemini/gemini-cli_gemini_request.go:
 *   template := `{"project":"","request":{},"model":""}`
 */
export function wrapForGeminiCLI(
  model: string,
  projectId: string | null,
  innerRequest: Record<string, unknown>,
): { model: string; project: string; request: Record<string, unknown> } {
  return {
    model,
    project: projectId ?? _randomProjectId(),
    request: { ...innerRequest },
  }
}

// ─── Per-executor API call headers ──────────────────────────────────
// These are the headers sent on generateContent / streamGenerateContent
// calls — NOT the onboarding headers (loadCodeAssist / onboardUser).
// Quota routing depends on these matching the expected client identity.

/**
 * Headers for Gemini CLI executor API calls.
 * Matches CLIProxyAPI's applyGeminiCLIHeaders():
 *   User-Agent: GeminiCLI/0.31.0/<model> (<os>; <arch>)
 *   X-Goog-Api-Client: google-genai-sdk/1.41.0 gl-node/v22.19.0
 */
export function geminiCLIApiHeaders(accessToken: string, model: string): Record<string, string> {
  const os = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x86'
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `GeminiCLI/0.31.0/${model} (${os}; ${arch})`,
    'X-Goog-Api-Client': 'google-genai-sdk/1.41.0 gl-node/v22.19.0',
  }
}

/**
 * Headers for Antigravity executor API calls.
 * Matches CLIProxyAPI's antigravity executor:
 *   User-Agent: antigravity/<version> <os>/<arch>
 *   NO X-Goog-Api-Client header — quota routing relies on body.userAgent instead.
 */
export function antigravityApiHeaders(accessToken: string): Record<string, string> {
  const os = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x86'
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `antigravity/1.21.9 ${os}/${arch}`,
  }
}

/** Deterministic session ID from the first user message, for dedup. */
function _stableSessionId(request: Record<string, unknown>): string {
  const contents = request.contents as Array<{ role?: string; parts?: Array<{ text?: string }> }> | undefined
  if (Array.isArray(contents)) {
    for (const c of contents) {
      if (c.role === 'user' && c.parts?.[0]?.text) {
        // Simple hash — doesn't need to be cryptographic, just stable.
        let h = 0
        for (const ch of c.parts[0].text) {
          h = ((h << 5) - h + ch.charCodeAt(0)) | 0
        }
        return '-' + Math.abs(h).toString()
      }
    }
  }
  return '-' + Math.floor(Math.random() * 9e18).toString()
}

/** Random project ID fallback matching CLIProxyAPI's generateProjectID(). */
function _randomProjectId(): string {
  const adj = ['useful', 'bright', 'swift', 'calm', 'bold']
  const noun = ['fuze', 'wave', 'spark', 'flow', 'core']
  const a = adj[Math.floor(Math.random() * adj.length)]
  const n = noun[Math.floor(Math.random() * noun.length)]
  const r = randomUUID().slice(0, 5).toLowerCase()
  return `${a}-${n}-${r}`
}

/**
 * Unwrap a single Code Assist non-streaming response into standard Gemini shape.
 */
export function unwrapCodeAssistResponse(
  caResponse: unknown,
): GeminiGenerateContentResponse {
  if (!caResponse || typeof caResponse !== 'object') return {}
  const wrapped = caResponse as { response?: GeminiGenerateContentResponse }
  return wrapped.response ?? {}
}

/**
 * Pre-warm Code Assist onboarding for both executors. Call this during
 * boot to eliminate the onboarding round-trip from the first real request.
 * Non-blocking — fires in the background and caches the project ID.
 */
export function warmupCodeAssist(
  cliToken?: string,
  antigravityToken?: string,
): void {
  if (cliToken) {
    ensureCodeAssistReady(cliToken, 'cli').catch(() => {})
  }
  if (antigravityToken) {
    ensureCodeAssistReady(antigravityToken, 'antigravity').catch(() => {})
  }
}

/**
 * Parse a Code Assist SSE stream and yield unwrapped Gemini chunks.
 */
export async function* parseCodeAssistSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<GeminiStreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE may deliver payloads split across chunks — only commit complete
      // lines and keep the trailing partial in `buffer`.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6)
        if (jsonStr === '[DONE]') return
        try {
          const wrapped = JSON.parse(jsonStr) as {
            response?: GeminiStreamChunk
          }
          if (wrapped.response) {
            yield wrapped.response
          }
        } catch {
          // Malformed chunk — skip and continue.
        }
      }
    }

    // Flush any trailing partial on end-of-stream.
    const tail = buffer.trim()
    if (tail.startsWith('data: ')) {
      const jsonStr = tail.slice(6)
      if (jsonStr && jsonStr !== '[DONE]') {
        try {
          const wrapped = JSON.parse(jsonStr) as {
            response?: GeminiStreamChunk
          }
          if (wrapped.response) {
            yield wrapped.response
          }
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
