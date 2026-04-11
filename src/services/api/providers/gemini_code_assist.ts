/**
 * Google Gemini Code Assist client — used for OAuth-authenticated Gemini access.
 *
 * Background: the Gemini CLI's bundled OAuth client is only authorized for the
 * `cloud-platform` scope. The public AI Studio endpoint
 * (`generativelanguage.googleapis.com`) rejects tokens without the
 * `generative-language` scope ("403 restricted_client"), so OAuth calls must
 * go through the Code Assist endpoint instead.
 *
 * Code Assist endpoint:
 *   https://cloudcode-pa.googleapis.com/v1internal:{method}
 *
 * Request body is wrapped:
 *   { model, project?, user_prompt_id, request: { contents, ...config } }
 *
 * Response body is wrapped:
 *   { response: { candidates, usageMetadata, ... } }
 *
 * Before making calls, the user must be "onboarded" — this happens once via
 * loadCodeAssist → onboardUser, and the returned project ID is cached on disk.
 */

import { homedir } from 'os'
import { join } from 'path'
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

const CONFIG_DIR = join(homedir(), '.config', 'claude-code')
const CACHE_FILE = join(CONFIG_DIR, 'gemini-code-assist.json')

interface CodeAssistCache {
  projectId: string | null  // null = use managed free-tier project
  onboardedAt: number
}

// In-memory cache so we don't re-read on every request
let _cached: CodeAssistCache | null = null

function _readCache(): CodeAssistCache | null {
  if (_cached) return _cached
  try {
    if (!existsSync(CACHE_FILE)) return null
    const raw = readFileSync(CACHE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as CodeAssistCache
    _cached = parsed
    return parsed
  } catch {
    return null
  }
}

function _writeCache(cache: CodeAssistCache): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
    _cached = cache
  } catch {
    // Cache is best-effort — if we can't persist, we'll just re-onboard next launch.
  }
}

// ─── Onboarding ──────────────────────────────────────────────────────

/**
 * Ensure the user is onboarded to Code Assist and return the project ID to use
 * (or null to use the managed free-tier project).
 *
 * Called lazily on the first Gemini request after login. Subsequent requests
 * read from the cache.
 */
export async function ensureCodeAssistReady(accessToken: string): Promise<string | null> {
  const cached = _readCache()
  if (cached) return cached.projectId

  const envProject =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT_ID ||
    undefined

  // Step 1: loadCodeAssist — tells us the user's current tier and whether they
  // need to be onboarded.
  const loadRes = await fetch(`${CODE_ASSIST_BASE}:loadCodeAssist`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      cloudaicompanionProject: envProject,
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
        duetProject: envProject,
      },
    }),
  })

  if (!loadRes.ok) {
    const errText = await loadRes.text().catch(() => '')
    throw new Error(
      `Gemini Code Assist loadCodeAssist failed (${loadRes.status}): ${errText.slice(0, 300)}`,
    )
  }

  const loadData = (await loadRes.json()) as {
    currentTier?: { id?: string; name?: string }
    allowedTiers?: Array<{ id: string; name?: string; isDefault?: boolean; userDefinedCloudaicompanionProject?: boolean }>
    cloudaicompanionProject?: string
  }

  // If user already has a tier, we're onboarded.
  if (loadData.currentTier) {
    const projectId = loadData.cloudaicompanionProject ?? envProject ?? null
    _writeCache({ projectId, onboardedAt: Date.now() })
    return projectId
  }

  // Step 2: onboardUser — picks the default tier and provisions a project.
  const defaultTier =
    loadData.allowedTiers?.find((t) => t.isDefault) ??
    loadData.allowedTiers?.[0]

  if (!defaultTier) {
    throw new Error(
      'Gemini Code Assist has no allowed tiers for this account. ' +
      'Make sure you are signed in with a Google account that has Gemini access.',
    )
  }

  // Free tier → send undefined project (server assigns managed one).
  // Paid tiers → must supply a project ID (from env).
  const onboardProject = defaultTier.userDefinedCloudaicompanionProject
    ? envProject
    : undefined

  if (defaultTier.userDefinedCloudaicompanionProject && !onboardProject) {
    throw new Error(
      'Gemini Code Assist paid tier requires GOOGLE_CLOUD_PROJECT to be set. ' +
      'Set it to your GCP project ID and try /login again.',
    )
  }

  const onboardRes = await fetch(`${CODE_ASSIST_BASE}:onboardUser`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tierId: defaultTier.id,
      cloudaicompanionProject: onboardProject,
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
        duetProject: onboardProject,
      },
    }),
  })

  if (!onboardRes.ok) {
    const errText = await onboardRes.text().catch(() => '')
    throw new Error(
      `Gemini Code Assist onboardUser failed (${onboardRes.status}): ${errText.slice(0, 300)}`,
    )
  }

  // onboardUser returns a long-running operation; poll until `done: true`.
  let opData = (await onboardRes.json()) as {
    done?: boolean
    response?: { cloudaicompanionProject?: { id?: string } }
    name?: string
  }

  const maxPolls = 30
  for (let i = 0; !opData.done && i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const pollRes = await fetch(`${CODE_ASSIST_BASE}:onboardUser`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tierId: defaultTier.id,
        cloudaicompanionProject: onboardProject,
        metadata: {
          ideType: 'IDE_UNSPECIFIED',
          platform: 'PLATFORM_UNSPECIFIED',
          pluginType: 'GEMINI',
          duetProject: onboardProject,
        },
      }),
    })
    if (!pollRes.ok) break
    opData = await pollRes.json()
  }

  const assignedProject =
    opData.response?.cloudaicompanionProject?.id ?? onboardProject ?? null
  _writeCache({ projectId: assignedProject, onboardedAt: Date.now() })
  return assignedProject
}

// ─── Request wrapping ────────────────────────────────────────────────

export interface CodeAssistWrapperBody {
  model: string
  project?: string
  user_prompt_id: string
  request: Record<string, unknown>
}

/**
 * Wrap a standard Gemini generateContent request body in the Code Assist
 * envelope shape.
 */
export function wrapForCodeAssist(
  model: string,
  projectId: string | null,
  innerRequest: Record<string, unknown>,
): CodeAssistWrapperBody {
  return {
    model,
    project: projectId ?? undefined,
    user_prompt_id: `claudex_${Date.now().toString(36)}`,
    request: innerRequest,
  }
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
