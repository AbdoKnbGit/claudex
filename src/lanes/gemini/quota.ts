/**
 * Gemini error classifier — port of gemini-cli's googleQuotaErrors.ts.
 *
 * Google's API packs rich error metadata into the response body's
 * `error.details[]` array using gRPC types:
 *
 *   - type.googleapis.com/google.rpc.ErrorInfo      — reason + domain + metadata
 *   - type.googleapis.com/google.rpc.QuotaFailure   — per-quota violation records
 *   - type.googleapis.com/google.rpc.RetryInfo      — retryDelay (seconds string)
 *   - type.googleapis.com/google.rpc.Help           — links + descriptions
 *
 * We read these to tell the difference between:
 *   - transient          — retry with backoff, same credential
 *   - retryable-quota    — rotate credential, then retry
 *   - terminal-quota     — stop trying this credential; surface to user
 *   - auth-stale         — refresh auth / re-onboard; retry once
 *   - prompt-too-long    — do NOT retry; surface to query.ts reactive compact
 *   - validation-required — user must click a link; surface banner
 *   - non-retryable      — real error, surface to user
 *
 * Reference: reference/gemini-cli-main/packages/core/src/utils/googleQuotaErrors.ts
 */

export type GeminiErrorKind =
  | 'transient'
  | 'retryable-quota'
  | 'terminal-quota'
  | 'auth-stale'
  | 'prompt-too-long'
  | 'validation-required'
  | 'non-retryable'

export interface GoogleErrorDetails {
  reason?: string
  domain?: string
  metadata?: Record<string, string>
  quotaFailures?: Array<{ subject?: string; description?: string }>
  retryDelaySeconds?: number
  validationLink?: string
  validationDescription?: string
  learnMoreUrl?: string
  insufficientCredits?: boolean
}

export interface ClassifiedGeminiError {
  kind: GeminiErrorKind
  retryAfterMs?: number
  details: GoogleErrorDetails
}

// ─── Body parsing ────────────────────────────────────────────────

/**
 * Best-effort parse of a Google API error body.
 *
 * Accepts:
 *   - JSON `{ error: { code, message, details[] } }` (generativelanguage)
 *   - JSON `{ code, message, details[] }` (Code Assist wrapped)
 *   - Raw text (falls through with just the raw message)
 *
 * Never throws — returns the best-interpreted details we could extract.
 */
export function parseGoogleErrorDetails(body: string): GoogleErrorDetails {
  if (!body) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {}
  }

  if (!parsed || typeof parsed !== 'object') return {}

  const root = (parsed as { error?: unknown }).error ?? parsed
  if (!root || typeof root !== 'object') return {}

  const details = (root as { details?: unknown[] }).details ?? []
  if (!Array.isArray(details)) return {}

  const out: GoogleErrorDetails = {}

  for (const d of details) {
    if (!d || typeof d !== 'object') continue
    const type = (d as { '@type'?: string })['@type'] ?? ''

    if (type.endsWith('ErrorInfo')) {
      const info = d as {
        reason?: string
        domain?: string
        metadata?: Record<string, string>
      }
      if (info.reason) out.reason = info.reason
      if (info.domain) out.domain = info.domain
      if (info.metadata) out.metadata = info.metadata
      if (info.reason === 'INSUFFICIENT_G1_CREDITS_BALANCE') {
        out.insufficientCredits = true
      }
    } else if (type.endsWith('QuotaFailure')) {
      const qf = d as {
        violations?: Array<{ subject?: string; description?: string }>
      }
      if (Array.isArray(qf.violations)) {
        out.quotaFailures = qf.violations.map(v => ({
          subject: v.subject,
          description: v.description,
        }))
      }
    } else if (type.endsWith('RetryInfo')) {
      const ri = d as { retryDelay?: string }
      if (typeof ri.retryDelay === 'string') {
        // e.g. "42s" or "1.500s"
        const m = ri.retryDelay.match(/^(\d+(?:\.\d+)?)s$/)
        if (m) out.retryDelaySeconds = parseFloat(m[1]!)
      }
    } else if (type.endsWith('Help')) {
      const help = d as {
        links?: Array<{ url?: string; description?: string }>
      }
      if (Array.isArray(help.links)) {
        for (const link of help.links) {
          if (!link.url) continue
          const desc = (link.description ?? '').toLowerCase()
          if (desc.includes('validat') || desc.includes('verify')) {
            out.validationLink = link.url
            out.validationDescription = link.description ?? undefined
          } else if (desc.includes('learn more') || !out.learnMoreUrl) {
            out.learnMoreUrl = link.url
          }
        }
      }
    }
  }

  return out
}

// ─── Classification ──────────────────────────────────────────────

/**
 * Classify a Gemini API error by HTTP status + body text.
 *
 * Caller holds the HTTP status separately because the body sometimes
 * lies about `code` (e.g. 200 body with `error.code: 500` envelope).
 * The status wins unless the body's `code` disagrees and claims a
 * quota/validation case we'd otherwise miss.
 */
export function classifyGeminiError(
  status: number,
  body: string,
): ClassifiedGeminiError {
  const details = parseGoogleErrorDetails(body)
  const lowered = body.toLowerCase()
  const retryAfterMs = details.retryDelaySeconds != null
    ? Math.max(0, Math.round(details.retryDelaySeconds * 1000))
    : undefined

  // Prompt-too-long wins regardless of status (some upstreams return 400,
  // some return 200 with an inline error envelope).
  if (
    lowered.includes('prompt is too long')
    || lowered.includes('token limit')
    || lowered.includes('context window')
    || lowered.includes('context length')
    || details.reason === 'PROMPT_TOO_LONG'
  ) {
    return { kind: 'prompt-too-long', details }
  }

  // Validation-required: Google wants the user to click a link before
  // quota flows. Can come on 403 or 400.
  if (details.validationLink) {
    return { kind: 'validation-required', details }
  }

  if (status === 401) {
    return { kind: 'auth-stale', details }
  }

  if (status === 403) {
    // Stale-project 403 is the cloudaicompanion re-onboard case.
    if (
      /cloudaicompanion|does not have permission|project might not exist/i.test(body)
    ) {
      return { kind: 'auth-stale', details }
    }
    // Antigravity surfaces "restricted_client" when the token scopes are
    // wrong — that's terminal, user must re-auth.
    if (lowered.includes('restricted_client')) {
      return { kind: 'non-retryable', details }
    }
    // Insufficient credits = terminal quota on this credential.
    if (details.insufficientCredits) {
      return { kind: 'terminal-quota', details, retryAfterMs }
    }
    return { kind: 'terminal-quota', details, retryAfterMs }
  }

  if (status === 429) {
    // Split: if ErrorInfo says it's a terminal quota (daily cap, billing
    // exhausted) we don't retry this credential. Otherwise transient.
    if (details.insufficientCredits) {
      return { kind: 'terminal-quota', details, retryAfterMs }
    }
    if (details.reason === 'RATE_LIMIT_EXCEEDED' || !details.reason) {
      return { kind: 'retryable-quota', details, retryAfterMs }
    }
    return { kind: 'retryable-quota', details, retryAfterMs }
  }

  if (status === 400) {
    // Bad request — not retryable unless it's prompt-too-long (handled above).
    return { kind: 'non-retryable', details }
  }

  if (status === 499) {
    // Client closed — treat as transient, the caller already aborted or
    // the connection flapped.
    return { kind: 'transient', details, retryAfterMs }
  }

  if (status >= 500 && status < 600) {
    return { kind: 'transient', details, retryAfterMs }
  }

  return { kind: 'non-retryable', details }
}

// ─── Retry-policy helpers ────────────────────────────────────────

/** Does the classified error warrant an immediate re-onboard + retry? */
export function isReonboardCase(cls: ClassifiedGeminiError): boolean {
  return cls.kind === 'auth-stale'
}

/** Does the classified error warrant a credential rotation before retry? */
export function isRotationCase(cls: ClassifiedGeminiError): boolean {
  return cls.kind === 'retryable-quota' || cls.kind === 'terminal-quota'
}

/** Should the outer retryWithBackoff loop retry without intervention? */
export function isBackoffRetryCase(cls: ClassifiedGeminiError): boolean {
  return cls.kind === 'transient' || cls.kind === 'retryable-quota'
}
