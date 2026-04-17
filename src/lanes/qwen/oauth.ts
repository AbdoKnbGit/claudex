/**
 * Qwen OAuth2 device-code flow.
 *
 * Port of reference/qwen-code-main/packages/core/src/qwen/qwenOAuth2.ts.
 *
 * Flow (RFC 8628 device authorization + RFC 7636 PKCE):
 *   1. Generate PKCE verifier + challenge.
 *   2. POST to chat.qwen.ai device-code endpoint → { device_code,
 *      user_code, verification_uri, expires_in }.
 *   3. Display user_code + verification_uri, open browser.
 *   4. Poll token endpoint with device_code + code_verifier until
 *      `access_token` returns (or timeout).
 *   5. Persist { access_token, refresh_token, expiry_date,
 *      resource_url } to ~/.qwen/oauth_creds.json.
 *
 * `resource_url` is the endpoint the token authenticates against — it
 * may differ from the default DashScope base per user account. The
 * token manager uses this when constructing upstream URLs.
 */

import { createHash, randomBytes, randomUUID } from 'crypto'

// ─── Endpoints (from reference/qwen-code-main) ───────────────────

const QWEN_OAUTH_BASE = 'https://chat.qwen.ai'
export const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE}/api/v1/oauth2/device/code`
export const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE}/api/v1/oauth2/token`

export const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56'
export const QWEN_OAUTH_SCOPE = 'openid profile email model.completion'
export const QWEN_OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

// ─── Types ───────────────────────────────────────────────────────

export interface QwenCredentials {
  access_token: string
  refresh_token?: string
  id_token?: string
  /** Absolute ms since epoch when access_token expires. */
  expiry_date: number
  token_type?: string
  /** Account-specific API endpoint (may differ from default DashScope). */
  resource_url?: string
}

export interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  /** Polling interval in seconds, per RFC 8628. Default 5. */
  interval?: number
}

export interface PKCEPair {
  verifier: string
  challenge: string
}

export class QwenCredentialsExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QwenCredentialsExpiredError'
  }
}

// ─── PKCE ────────────────────────────────────────────────────────

export function generatePKCE(): PKCEPair {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ─── Form encoding ──────────────────────────────────────────────

function formEncode(body: Record<string, string>): string {
  return Object.entries(body)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

// ─── Device authorization ───────────────────────────────────────

/**
 * Step 1: request device + user codes. Call before opening the browser.
 */
export async function requestDeviceAuthorization(pkce: PKCEPair): Promise<DeviceAuthorization> {
  const resp = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'x-request-id': randomUUID(),
    },
    body: formEncode({
      client_id: QWEN_OAUTH_CLIENT_ID,
      scope: QWEN_OAUTH_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Qwen device authorization failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  const data = await resp.json() as DeviceAuthorization | { error: string; error_description?: string }
  if ('error' in data) {
    throw new Error(
      `Qwen device authorization error: ${data.error}${data.error_description ? ` — ${data.error_description}` : ''}`,
    )
  }
  return data
}

// ─── Polling for the token ──────────────────────────────────────

type PollResult =
  | { status: 'success'; credentials: QwenCredentials }
  | { status: 'pending'; slowDown?: boolean }
  | { status: 'error'; message: string }

/**
 * Step 2: poll the token endpoint until the user approves (or times out).
 * Caller controls the polling cadence — start with `auth.interval ?? 5`
 * seconds between calls and double to ≤30s on `slowDown`.
 */
export async function pollDeviceToken(
  deviceCode: string,
  verifier: string,
): Promise<PollResult> {
  const resp = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: formEncode({
      grant_type: QWEN_OAUTH_GRANT_TYPE,
      client_id: QWEN_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      code_verifier: verifier,
    }),
  })
  const text = await resp.text().catch(() => '')

  if (!resp.ok) {
    let err: { error?: string; error_description?: string } | null = null
    try { err = JSON.parse(text) } catch { err = null }
    if (resp.status === 400 && err?.error === 'authorization_pending') {
      return { status: 'pending' }
    }
    if (resp.status === 429 && err?.error === 'slow_down') {
      return { status: 'pending', slowDown: true }
    }
    return {
      status: 'error',
      message: err?.error_description ?? err?.error ?? text.slice(0, 200),
    }
  }

  let payload: {
    access_token?: string
    refresh_token?: string
    id_token?: string
    token_type?: string
    expires_in?: number
    resource_url?: string
  }
  try {
    payload = JSON.parse(text)
  } catch {
    return { status: 'error', message: 'Qwen token response was not JSON' }
  }
  if (!payload.access_token) {
    return { status: 'pending' }
  }
  const expiresInSec = payload.expires_in ?? 3600
  return {
    status: 'success',
    credentials: {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      id_token: payload.id_token,
      token_type: payload.token_type ?? 'Bearer',
      expiry_date: Date.now() + expiresInSec * 1000,
      resource_url: payload.resource_url,
    },
  }
}

/**
 * Poll with adaptive backoff until the user completes the flow or the
 * device code expires. Throws on fatal errors (access_denied, expired,
 * etc.). The caller displays user_code + verification_uri and opens
 * the browser; this function handles the polling loop.
 */
export async function awaitDeviceToken(
  auth: DeviceAuthorization,
  verifier: string,
  signal?: AbortSignal,
): Promise<QwenCredentials> {
  const startedAt = Date.now()
  const expiresAt = startedAt + auth.expires_in * 1000
  let intervalMs = (auth.interval ?? 5) * 1000

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (Date.now() >= expiresAt) {
      throw new Error('Qwen device authorization expired; run /login qwen again')
    }
    const result = await pollDeviceToken(auth.device_code, verifier)
    if (result.status === 'success') return result.credentials
    if (result.status === 'error') throw new Error(`Qwen OAuth failed: ${result.message}`)
    if (result.slowDown) intervalMs = Math.min(intervalMs * 2, 30_000)
    await sleep(intervalMs, signal)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ─── Refresh ─────────────────────────────────────────────────────

/**
 * Refresh an expired access token. Returns updated credentials — the
 * OAuth server may or may not rotate the refresh_token (we preserve
 * the existing one if it doesn't).
 *
 * Throws `QwenCredentialsExpiredError` when the server says the
 * refresh token itself is invalid (400/401), so the caller can prompt
 * for re-authentication rather than loop forever.
 */
export async function refreshAccessToken(creds: QwenCredentials): Promise<QwenCredentials> {
  if (!creds.refresh_token) {
    throw new QwenCredentialsExpiredError('No refresh token; re-run /login qwen')
  }
  const resp = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: formEncode({
      grant_type: 'refresh_token',
      refresh_token: creds.refresh_token,
      client_id: QWEN_OAUTH_CLIENT_ID,
    }),
  })
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    if (resp.status === 400 || resp.status === 401) {
      throw new QwenCredentialsExpiredError(
        `Qwen refresh token rejected (${resp.status}); re-run /login qwen`,
      )
    }
    throw new Error(`Qwen refresh failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  let payload: {
    access_token?: string
    refresh_token?: string
    token_type?: string
    expires_in?: number
    resource_url?: string
  }
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('Qwen refresh returned non-JSON response')
  }
  if (!payload.access_token) {
    throw new Error('Qwen refresh returned no access_token')
  }
  const expiresInSec = payload.expires_in ?? 3600
  return {
    ...creds,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? creds.refresh_token,
    token_type: payload.token_type ?? creds.token_type ?? 'Bearer',
    expiry_date: Date.now() + expiresInSec * 1000,
    resource_url: payload.resource_url ?? creds.resource_url,
  }
}
