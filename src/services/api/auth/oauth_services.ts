/**
 * OAuth flows for the Phase 4 providers (v0.4.0):
 *
 *   - KiloCode       Custom device-auth flow (POST /api/device-auth/codes)
 *   - Cline          Authorization-code → base64 payload decode
 *   - iFlow          OAuth2 authorization-code + Basic Auth exchange
 *   - GitHub Copilot OAuth2 device-code flow
 *   - Kiro           AWS SSO OIDC device-code (Builder ID path)
 *   - Cursor         Native browser login (Cursor deep-link + auth poll)
 *
 * Each flow returns { accessToken, refreshToken } and writes the blob to
 * provider-keys.json under `<provider>_oauth`, matching the shape used by
 * every other third-party provider (see `google_oauth.ts`, `openai_oauth.ts`).
 *
 * All credentials / client IDs are hardcoded from the 9router reference
 * (same constants the Kiro/Cursor/Copilot desktop apps themselves ship).
 * These are "public installed client" values per Google/AWS/GitHub OAuth
 * spec — not confidential secrets — so they can live in source.
 */

import { createServer } from 'http'
import { randomBytes, createHash, randomUUID } from 'crypto'
import { saveProviderKey, loadProviderKey, deleteProviderKey } from './api_key_manager.js'
import { openBrowser } from '../../../utils/browser.js'

// ─── Shared helpers ───────────────────────────────────────────────

interface StoredOAuthBlob {
  accessToken: string
  refreshToken?: string
  expiresAt?: number  // epoch ms
  /** Provider-specific extras (orgId, profileArn, clientId, region, …). */
  meta?: Record<string, unknown>
}

export interface CopilotPlanInfo {
  sku?: string
  individual?: boolean
  limitedUserQuotas?: {
    chat?: number
    completions?: number
  }
  limitedUserResetDate?: number
}

interface KiroTokenPayload {
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  profileArn?: string | null
}

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

function _saveTokens(
  storageKey: string,
  tokens: { accessToken: string; refreshToken?: string; expiresIn?: number; meta?: Record<string, unknown> },
): void {
  const blob: StoredOAuthBlob = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
    meta: tokens.meta,
  }
  saveProviderKey(storageKey, JSON.stringify(blob))
}

function _loadTokens(storageKey: string): StoredOAuthBlob | null {
  const raw = loadProviderKey(storageKey)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredOAuthBlob
  } catch {
    return null
  }
}

function _pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function _getJwtExpirySeconds(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined

  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as {
      exp?: number
    }
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return undefined

    const seconds = Math.floor(payload.exp - Date.now() / 1000)
    return seconds > 0 ? seconds : undefined
  } catch {
    return undefined
  }
}

function _getStringField(
  data: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function _getNumberField(
  data: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function _getExpiresInFromTimestamp(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  const expiresAt = new Date(raw).getTime()
  if (!Number.isFinite(expiresAt)) return undefined
  return Math.max(60, Math.floor((expiresAt - Date.now()) / 1000))
}

export function _normalizeKiroTokenPayload(data: Record<string, unknown>): KiroTokenPayload {
  const accessToken = _getStringField(data, 'accessToken', 'access_token')
  const refreshToken = _getStringField(data, 'refreshToken', 'refresh_token')
  const profileArn = _getStringField(data, 'profileArn', 'profile_arn')
  const expiresIn =
    _getNumberField(data, 'expiresIn', 'expires_in')
    ?? _getExpiresInFromTimestamp(data.expiresAt ?? data.expires_at)

  return {
    accessToken,
    refreshToken,
    expiresIn,
    profileArn: profileArn ?? null,
  }
}

async function _reloadKiroLaneAuth(): Promise<void> {
  const { reloadKiroLaneAuth } = await import('../providers/providerShim.js')
  await reloadKiroLaneAuth()
}

async function _reloadCopilotLaneAuth(): Promise<void> {
  const { reloadCopilotLaneAuth } = await import('../providers/providerShim.js')
  await reloadCopilotLaneAuth()
}

async function _reloadCursorLaneAuth(): Promise<void> {
  const { reloadCursorLaneAuth } = await import('../providers/providerShim.js')
  await reloadCursorLaneAuth()
}

async function _reloadClineLaneAuth(): Promise<void> {
  const { reloadClineLaneAuth } = await import('../providers/providerShim.js')
  await reloadClineLaneAuth()
}

async function _reloadKiloLaneAuth(): Promise<void> {
  const { reloadKiloLaneAuth } = await import('../providers/providerShim.js')
  await reloadKiloLaneAuth()
}

/** Bind a local http server on the first available port, capture callback params. */
function _startCallbackServer(
  preferredPort: number,
  redirectPath: string,
): Promise<{ port: number; params: Promise<URLSearchParams> }> {
  return new Promise((resolveBind, rejectBind) => {
    let paramsResolve!: (p: URLSearchParams) => void
    let paramsReject!: (e: Error) => void
    const paramsPromise = new Promise<URLSearchParams>((res, rej) => {
      paramsResolve = res
      paramsReject = rej
    })

    const timeout = setTimeout(() => {
      paramsReject(new Error('OAuth callback timed out after 5 minutes'))
    }, 5 * 60 * 1000)

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      if (url.pathname === redirectPath || url.pathname === '/callback' || url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8f9fa">' +
          '<div style="background:#fff;padding:48px;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center">' +
          '<h1 style="color:#202124;margin:0 0 8px">You\'re all set</h1>' +
          '<p style="color:#5f6368">You can close this tab.</p>' +
          '</div><script>setTimeout(()=>window.close(),1500)</script></body></html>',
        )
        clearTimeout(timeout)
        server.close()
        paramsResolve(url.searchParams)
        return
      }
      res.writeHead(404)
      res.end()
    })

    let triedFallback = false
    const tryListen = (port: number) => {
      server.removeAllListeners('error')
      server.removeAllListeners('listening')
      server.once('listening', () => {
        const addr = server.address()
        const actualPort = addr && typeof addr === 'object' ? addr.port : port
        resolveBind({ port: actualPort, params: paramsPromise })
      })
      server.once('error', (err: NodeJS.ErrnoException) => {
        if ((err.code === 'EACCES' || err.code === 'EADDRINUSE') && !triedFallback) {
          triedFallback = true
          tryListen(0)  // ephemeral port
          return
        }
        clearTimeout(timeout)
        rejectBind(err)
      })
      server.listen(port, '127.0.0.1')
    }
    tryListen(preferredPort)
  })
}

// ═══════════════════════════════════════════════════════════════════
// KiloCode — custom device-auth flow
// ═══════════════════════════════════════════════════════════════════

const KILOCODE_API_BASE = 'https://api.kilo.ai'
const KILOCODE_STORAGE = 'kilocode_oauth'

export async function startKiloCodeOAuth(): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const initiateRes = await fetch(`${KILOCODE_API_BASE}/api/device-auth/codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!initiateRes.ok) {
    const body = await initiateRes.text()
    throw new Error(`KiloCode device auth failed: ${initiateRes.status} ${body}`)
  }
  const initData = await initiateRes.json() as {
    code: string
    verificationUrl: string
    expiresIn?: number
  }
  const { code, verificationUrl } = initData
  const expiresIn = initData.expiresIn ?? 300

  await openBrowser(verificationUrl)

  // Poll /api/device-auth/codes/<code> every 3s until approved or expired.
  const pollUrl = `${KILOCODE_API_BASE}/api/device-auth/codes/${code}`
  const deadline = Date.now() + expiresIn * 1000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000))
    const res = await fetch(pollUrl)
    if (res.status === 202) continue  // pending
    if (res.status === 403) throw new Error('KiloCode authorization denied by user')
    if (res.status === 410) throw new Error('KiloCode authorization code expired')
    if (!res.ok) continue  // transient
    const data = await res.json() as {
      status?: string
      token?: string
      userEmail?: string
    }
    if (data.status === 'approved' && data.token) {
      // Best-effort: fetch orgId for the X-Kilocode-OrganizationID header.
      let orgId: string | null = null
      try {
        const profileRes = await fetch(`${KILOCODE_API_BASE}/api/profile`, {
          headers: { Authorization: `Bearer ${data.token}` },
        })
        if (profileRes.ok) {
          const profile = await profileRes.json() as {
            organizations?: Array<{ id?: string }>
          }
          orgId = profile.organizations?.[0]?.id ?? null
        }
      } catch { /* best-effort */ }

      _saveTokens(KILOCODE_STORAGE, {
        accessToken: data.token,
        meta: { email: data.userEmail, orgId },
      })
      // Flip the lane's in-memory auth so the current session picks up
      // the new bearer without a restart (the Kilo lane caches credentials
      // at init and on reload).
      await _reloadKiloLaneAuth()
      return { accessToken: data.token, refreshToken: '' }  // no refresh token
    }
  }
  throw new Error('KiloCode authorization timed out')
}

export function getKiloCodeOAuthToken(): string | null {
  return _loadTokens(KILOCODE_STORAGE)?.accessToken ?? null
}

export function getKiloCodeOrgId(): string | null {
  const blob = _loadTokens(KILOCODE_STORAGE)
  return (blob?.meta?.orgId as string) ?? null
}

// ═══════════════════════════════════════════════════════════════════
// Cline — authorization-code with base64-encoded token payload
// ═══════════════════════════════════════════════════════════════════

const CLINE_API_BASE = 'https://api.cline.bot'
const CLINE_STORAGE = 'cline_oauth'

export async function startClineOAuth(): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const { port, params: paramsPromise } = await _startCallbackServer(3000, '/callback')
  const redirectUri = `http://localhost:${port}/callback`

  const authUrl = new URL(`${CLINE_API_BASE}/api/v1/auth/authorize`)
  authUrl.searchParams.set('client_type', 'extension')
  authUrl.searchParams.set('callback_url', redirectUri)
  authUrl.searchParams.set('redirect_uri', redirectUri)

  await openBrowser(authUrl.toString())

  const params = await paramsPromise
  const code = params.get('code')
  if (!code) throw new Error('Cline: no authorization code returned')

  // Cline encodes token data as base64 in the code param; try that first
  // and fall back to POST /api/v1/auth/token exchange.
  let accessToken = ''
  let refreshToken = ''
  let email = ''
  let expiresAtMs: number | undefined

  try {
    let base64 = code
    const padding = 4 - (base64.length % 4)
    if (padding !== 4) base64 += '='.repeat(padding)
    const decoded = Buffer.from(base64, 'base64').toString('utf-8')
    const lastBrace = decoded.lastIndexOf('}')
    if (lastBrace === -1) throw new Error('no JSON')
    const tokenData = JSON.parse(decoded.slice(0, lastBrace + 1)) as {
      accessToken?: string
      refreshToken?: string
      email?: string
      expiresAt?: string | number
    }
    if (!tokenData.accessToken) throw new Error('no accessToken')
    accessToken = tokenData.accessToken
    refreshToken = tokenData.refreshToken ?? ''
    email = tokenData.email ?? ''
    if (tokenData.expiresAt) {
      expiresAtMs = typeof tokenData.expiresAt === 'string'
        ? new Date(tokenData.expiresAt).getTime()
        : tokenData.expiresAt
    }
  } catch {
    const res = await fetch(`${CLINE_API_BASE}/api/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_type: 'extension',
        redirect_uri: redirectUri,
      }),
    })
    if (!res.ok) throw new Error(`Cline token exchange failed: ${await res.text()}`)
    const data = await res.json() as {
      data?: {
        accessToken?: string
        refreshToken?: string
        userInfo?: { email?: string }
        expiresAt?: string | number
      }
      accessToken?: string
      refreshToken?: string
      expiresAt?: string | number
    }
    accessToken = data.data?.accessToken ?? data.accessToken ?? ''
    refreshToken = data.data?.refreshToken ?? data.refreshToken ?? ''
    email = data.data?.userInfo?.email ?? ''
    const rawExpires = data.data?.expiresAt ?? data.expiresAt
    if (rawExpires) {
      expiresAtMs = typeof rawExpires === 'string'
        ? new Date(rawExpires).getTime()
        : rawExpires
    }
  }

  if (!accessToken) throw new Error('Cline: no access token received')

  const expiresIn = expiresAtMs
    ? Math.max(60, Math.floor((expiresAtMs - Date.now()) / 1000))
    : 3600
  _saveTokens(CLINE_STORAGE, {
    accessToken,
    refreshToken: refreshToken || undefined,
    expiresIn,
    meta: { email },
  })
  await _reloadClineLaneAuth()
  return { accessToken, refreshToken }
}

export function getClineOAuthToken(): string | null {
  return _loadTokens(CLINE_STORAGE)?.accessToken ?? null
}

export async function refreshClineOAuth(refreshToken: string): Promise<string> {
  const res = await fetch(`${CLINE_API_BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      refreshToken,
      grantType: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Cline refresh failed: ${await res.text()}`)
  const data = await res.json() as {
    data?: { accessToken?: string; refreshToken?: string; expiresAt?: string | number }
    accessToken?: string
  }
  const accessToken = data.data?.accessToken ?? data.accessToken ?? ''
  if (!accessToken) throw new Error('Cline refresh: no access token in response')
  const newRefresh = data.data?.refreshToken ?? refreshToken
  const expiresAtRaw = data.data?.expiresAt
  const expiresAtMs = typeof expiresAtRaw === 'string'
    ? new Date(expiresAtRaw).getTime()
    : typeof expiresAtRaw === 'number' ? expiresAtRaw : undefined
  const expiresIn = expiresAtMs
    ? Math.max(60, Math.floor((expiresAtMs - Date.now()) / 1000))
    : 3600
  _saveTokens(CLINE_STORAGE, {
    accessToken,
    refreshToken: newRefresh,
    expiresIn,
  })
  await _reloadClineLaneAuth()
  return accessToken
}

// ═══════════════════════════════════════════════════════════════════
// iFlow — OAuth2 authorization-code flow with Basic Auth exchange
// ═══════════════════════════════════════════════════════════════════

const IFLOW_CLIENT_ID = '10009311001'
const IFLOW_CLIENT_SECRET = '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW'
const IFLOW_AUTHORIZE_URL = 'https://iflow.cn/oauth'
const IFLOW_TOKEN_URL = 'https://iflow.cn/oauth/token'
const IFLOW_USERINFO_URL = 'https://iflow.cn/api/oauth/getUserInfo'
const IFLOW_STORAGE = 'iflow_oauth'

export async function startIFlowOAuth(): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const { port, params: paramsPromise } = await _startCallbackServer(8089, '/callback')
  const redirectUri = `http://localhost:${port}/callback`
  const state = randomBytes(32).toString('base64url')

  const authUrl = new URL(IFLOW_AUTHORIZE_URL)
  authUrl.searchParams.set('loginMethod', 'phone')
  authUrl.searchParams.set('type', 'phone')
  authUrl.searchParams.set('redirect', redirectUri)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('client_id', IFLOW_CLIENT_ID)

  await openBrowser(authUrl.toString())

  const params = await paramsPromise
  if (params.get('state') !== state) {
    throw new Error('iFlow: state mismatch (possible CSRF)')
  }
  const code = params.get('code')
  if (!code) throw new Error('iFlow: no authorization code returned')

  const basicAuth = Buffer.from(`${IFLOW_CLIENT_ID}:${IFLOW_CLIENT_SECRET}`).toString('base64')
  const tokenRes = await fetch(IFLOW_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: IFLOW_CLIENT_ID,
      client_secret: IFLOW_CLIENT_SECRET,
    }),
  })
  if (!tokenRes.ok) {
    throw new Error(`iFlow token exchange failed: ${await tokenRes.text()}`)
  }
  const tokens = await tokenRes.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }

  // Fetch user info — contains the `apiKey` iFlow uses for chat requests.
  let apiKey = ''
  let email = ''
  try {
    const userRes = await fetch(
      `${IFLOW_USERINFO_URL}?accessToken=${encodeURIComponent(tokens.access_token)}`,
      { headers: { Accept: 'application/json' } },
    )
    if (userRes.ok) {
      const userData = await userRes.json() as {
        success?: boolean
        data?: { apiKey?: string; email?: string; phone?: string }
      }
      if (userData.success) {
        apiKey = userData.data?.apiKey ?? ''
        email = userData.data?.email ?? userData.data?.phone ?? ''
      }
    }
  } catch { /* best-effort */ }

  _saveTokens(IFLOW_STORAGE, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    meta: { apiKey, email },
  })
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
  }
}

export function getIFlowOAuthToken(): string | null {
  return _loadTokens(IFLOW_STORAGE)?.accessToken ?? null
}

/** iFlow uses an `apiKey` (extracted from userInfo) rather than the OAuth token for chat. */
export function getIFlowApiKey(): string | null {
  const blob = _loadTokens(IFLOW_STORAGE)
  return (blob?.meta?.apiKey as string) ?? null
}

export async function refreshIFlowOAuth(refreshToken: string): Promise<string> {
  const basicAuth = Buffer.from(`${IFLOW_CLIENT_ID}:${IFLOW_CLIENT_SECRET}`).toString('base64')
  const res = await fetch(IFLOW_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: IFLOW_CLIENT_ID,
      client_secret: IFLOW_CLIENT_SECRET,
    }),
  })
  if (!res.ok) throw new Error(`iFlow refresh failed: ${await res.text()}`)
  const tokens = await res.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }
  const existing = _loadTokens(IFLOW_STORAGE)
  _saveTokens(IFLOW_STORAGE, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresIn: tokens.expires_in,
    meta: existing?.meta,
  })
  return tokens.access_token
}

// ═══════════════════════════════════════════════════════════════════
// GitHub Copilot — device code flow + Copilot token exchange
// ═══════════════════════════════════════════════════════════════════

const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const COPILOT_DEVICE_URL = 'https://github.com/login/device/code'
const COPILOT_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const COPILOT_INTERNAL_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
const COPILOT_USERAGENT = 'GitHubCopilotChat/0.26.7'
const COPILOT_STORAGE = 'copilot_oauth'
let _copilotRefreshInFlight: Promise<string> | null = null

function _copilotMeta(refreshIn?: number): Record<string, unknown> | undefined {
  if (typeof refreshIn !== 'number' || !Number.isFinite(refreshIn)) return undefined
  return {
    refreshIn,
    refreshAt: Date.now() + refreshIn * 1000,
  }
}

function _copilotPlanMeta(data: {
  sku?: string
  individual?: boolean
  limited_user_quotas?: {
    chat?: number
    completions?: number
  }
  limited_user_reset_date?: number
}): CopilotPlanInfo {
  return {
    ...(typeof data.sku === 'string' ? { sku: data.sku } : {}),
    ...(typeof data.individual === 'boolean' ? { individual: data.individual } : {}),
    ...(data.limited_user_quotas ? { limitedUserQuotas: data.limited_user_quotas } : {}),
    ...(typeof data.limited_user_reset_date === 'number'
      ? { limitedUserResetDate: data.limited_user_reset_date }
      : {}),
  }
}

function _mergeCopilotMeta(
  refreshIn: number | undefined,
  plan: CopilotPlanInfo,
): Record<string, unknown> | undefined {
  const timing = _copilotMeta(refreshIn) ?? {}
  return { ...timing, ...plan }
}

function _hasCopilotPlanInfo(blob: StoredOAuthBlob): boolean {
  return typeof blob.meta?.sku === 'string'
}

function _shouldRefreshCopilotToken(blob: StoredOAuthBlob): boolean {
  const refreshAt = blob.meta?.refreshAt
  if (typeof refreshAt === 'number' && Number.isFinite(refreshAt)) {
    return Date.now() > refreshAt - TOKEN_REFRESH_BUFFER_MS
  }
  return !!(
    blob.expiresAt
    && Date.now() > blob.expiresAt - TOKEN_REFRESH_BUFFER_MS
  )
}

/**
 * Device-code handles. Caller renders the user_code + verification_uri
 * in the UI, then calls completeCopilotOAuth(deviceCode, interval) to poll.
 */
export interface CopilotDeviceHandles {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number
  expiresIn: number
}

export async function initiateCopilotOAuth(): Promise<CopilotDeviceHandles> {
  const res = await fetch(COPILOT_DEVICE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: COPILOT_CLIENT_ID,
      scope: 'read:user',
    }),
  })
  if (!res.ok) throw new Error(`Copilot device code failed: ${await res.text()}`)
  const data = await res.json() as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in?: number
    interval?: number
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in ?? 900,
    interval: data.interval ?? 5,
  }
}

/**
 * Poll the GitHub device-code endpoint until the user approves, then
 * exchange the GH access token for a Copilot internal API token. Call
 * after `initiateCopilotOAuth()` so the caller can display user_code.
 */
export async function completeCopilotOAuth(handles: CopilotDeviceHandles): Promise<{
  accessToken: string
  refreshToken: string
}> {
  let interval = handles.interval * 1000
  const deadline = Date.now() + handles.expiresIn * 1000
  let ghAccessToken = ''
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval))
    const res = await fetch(COPILOT_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        device_code: handles.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const data = await res.json() as {
      access_token?: string
      error?: string
      error_description?: string
      interval?: number
    }
    if (data.access_token) {
      ghAccessToken = data.access_token
      break
    }
    if (data.error === 'authorization_pending') continue
    if (data.error === 'slow_down') { interval += 5000; continue }
    if (data.error === 'expired_token') throw new Error('GitHub device code expired')
    if (data.error === 'access_denied') throw new Error('GitHub authorization denied')
    if (data.error) throw new Error(`Copilot OAuth error: ${data.error_description ?? data.error}`)
  }
  if (!ghAccessToken) throw new Error('Copilot OAuth timed out')

  // Exchange the GitHub user token for a Copilot internal API token.
  const copilotRes = await fetch(COPILOT_INTERNAL_TOKEN_URL, {
    headers: {
      Authorization: `Bearer ${ghAccessToken}`,
      Accept: 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': COPILOT_USERAGENT,
    },
  })
  if (!copilotRes.ok) {
    throw new Error(`Copilot token fetch failed: ${copilotRes.status} ${await copilotRes.text()}`)
  }
  const copilotData = await copilotRes.json() as {
    token?: string
    expires_at?: number
    refresh_in?: number
    sku?: string
    individual?: boolean
    limited_user_quotas?: { chat?: number; completions?: number }
    limited_user_reset_date?: number
  }
  if (!copilotData.token) throw new Error('Copilot: no internal token in response')

  const expiresIn = copilotData.expires_at
    ? Math.max(60, copilotData.expires_at - Math.floor(Date.now() / 1000))
    : 1500
  _saveTokens(COPILOT_STORAGE, {
    accessToken: copilotData.token,
    refreshToken: ghAccessToken,  // refresh re-exchanges via the GH token
    expiresIn,
    meta: _mergeCopilotMeta(
      copilotData.refresh_in,
      _copilotPlanMeta(copilotData),
    ),
  })
  await _reloadCopilotLaneAuth()
  return { accessToken: copilotData.token, refreshToken: ghAccessToken }
}

export async function startCopilotOAuth(): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const handles = await initiateCopilotOAuth()
  await openBrowser(handles.verificationUri)
  return completeCopilotOAuth(handles)
}

export function getCopilotOAuthToken(): string | null {
  return _loadTokens(COPILOT_STORAGE)?.accessToken ?? null
}

export function getStoredCopilotPlanInfo(): CopilotPlanInfo | null {
  const blob = _loadTokens(COPILOT_STORAGE)
  if (!blob?.meta) return null

  const plan: CopilotPlanInfo = {}
  if (typeof blob.meta.sku === 'string') plan.sku = blob.meta.sku
  if (typeof blob.meta.individual === 'boolean') plan.individual = blob.meta.individual

  const quotas = blob.meta.limitedUserQuotas
  if (quotas && typeof quotas === 'object') {
    const q = quotas as Record<string, unknown>
    plan.limitedUserQuotas = {
      ...(typeof q.chat === 'number' ? { chat: q.chat } : {}),
      ...(typeof q.completions === 'number' ? { completions: q.completions } : {}),
    }
  }

  if (typeof blob.meta.limitedUserResetDate === 'number') {
    plan.limitedUserResetDate = blob.meta.limitedUserResetDate
  }

  return Object.keys(plan).length > 0 ? plan : null
}

export async function getValidCopilotOAuthToken(): Promise<string | null> {
  const blob = _loadTokens(COPILOT_STORAGE)
  if (!blob) return null

  if (!blob.accessToken) {
    if (!blob.refreshToken) return null
    try {
      return await refreshCopilotOAuth(blob.refreshToken)
    } catch {
      return null
    }
  }

  if (!_hasCopilotPlanInfo(blob) && blob.refreshToken) {
    try {
      return await refreshCopilotOAuth(blob.refreshToken)
    } catch {
      // Keep using the current internal token if metadata refresh fails.
      return blob.accessToken
    }
  }

  if (!_shouldRefreshCopilotToken(blob)) {
    return blob.accessToken
  }

  if (!blob.refreshToken) return blob.accessToken

  if (!_copilotRefreshInFlight) {
    _copilotRefreshInFlight = refreshCopilotOAuth(blob.refreshToken)
      .finally(() => {
        _copilotRefreshInFlight = null
      })
  }

  try {
    return await _copilotRefreshInFlight
  } catch {
    // Keep using the currently-stored internal token if the early refresh
    // fails. This avoids flipping to "not logged in" on transient network
    // errors while the existing token may still be accepted by Copilot.
    return blob.accessToken ?? null
  }
}

export async function refreshCopilotOAuth(ghAccessToken: string): Promise<string> {
  const res = await fetch(COPILOT_INTERNAL_TOKEN_URL, {
    headers: {
      Authorization: `Bearer ${ghAccessToken}`,
      Accept: 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': COPILOT_USERAGENT,
    },
  })
  if (!res.ok) throw new Error(`Copilot refresh failed: ${await res.text()}`)
  const data = await res.json() as {
    token?: string
    expires_at?: number
    refresh_in?: number
    sku?: string
    individual?: boolean
    limited_user_quotas?: { chat?: number; completions?: number }
    limited_user_reset_date?: number
  }
  if (!data.token) throw new Error('Copilot refresh: no token')
  const expiresIn = data.expires_at
    ? Math.max(60, data.expires_at - Math.floor(Date.now() / 1000))
    : 1500
  _saveTokens(COPILOT_STORAGE, {
    accessToken: data.token,
    refreshToken: ghAccessToken,
    expiresIn,
    meta: _mergeCopilotMeta(
      data.refresh_in,
      _copilotPlanMeta(data),
    ),
  })
  await _reloadCopilotLaneAuth()
  return data.token
}

// ═══════════════════════════════════════════════════════════════════
// Kiro — AWS SSO OIDC device-code flow (Builder ID path)
// ═══════════════════════════════════════════════════════════════════
//
// Kiro supports Builder ID / IDC / Google-Cognito / GitHub-Cognito / import.
// v0.4.0 implements Builder ID (the default AWS login most users want). The
// other methods can be added later — Kiro's chat executor is already stubbed
// in Phase 4 so the provider row + login UI ship regardless.

const KIRO_OIDC_BASE = 'https://oidc.us-east-1.amazonaws.com'
const KIRO_BUILDER_START_URL = 'https://view.awsapps.com/start'
const KIRO_CLIENT_NAME = 'kiro-oauth-client'
const KIRO_SCOPES = ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations']
const KIRO_GRANT_TYPES = ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']
const KIRO_ISSUER_URL = 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6'
const KIRO_SOCIAL_AUTH_SERVICE = 'https://prod.us-east-1.auth.desktop.kiro.dev'
const KIRO_SOCIAL_REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success'
const KIRO_STORAGE = 'kiro_oauth'

export type KiroSocialProvider = 'google' | 'github'

export interface KiroDeviceHandles {
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  deviceCode: string
  interval: number
  expiresIn: number
  clientId: string
  clientSecret: string
}

export interface KiroSocialHandles {
  provider: KiroSocialProvider
  authUrl: string
  state: string
  codeVerifier: string
}

export async function initiateKiroOAuth(): Promise<KiroDeviceHandles> {
  // 1. Register OIDC client (gives us a dynamic clientId/clientSecret pair)
  const registerRes = await fetch(`${KIRO_OIDC_BASE}/client/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientName: KIRO_CLIENT_NAME,
      clientType: 'public',
      scopes: KIRO_SCOPES,
      grantTypes: KIRO_GRANT_TYPES,
      issuerUrl: KIRO_ISSUER_URL,
    }),
  })
  if (!registerRes.ok) {
    throw new Error(`Kiro client register failed: ${await registerRes.text()}`)
  }
  const client = await registerRes.json() as { clientId: string; clientSecret: string }

  // 2. Start device authorization
  const authRes = await fetch(`${KIRO_OIDC_BASE}/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      startUrl: KIRO_BUILDER_START_URL,
    }),
  })
  if (!authRes.ok) {
    throw new Error(`Kiro device auth failed: ${await authRes.text()}`)
  }
  const auth = await authRes.json() as {
    deviceCode: string
    userCode: string
    verificationUri: string
    verificationUriComplete: string
    expiresIn?: number
    interval?: number
  }
  return {
    deviceCode: auth.deviceCode,
    userCode: auth.userCode,
    verificationUri: auth.verificationUri,
    verificationUriComplete: auth.verificationUriComplete,
    expiresIn: auth.expiresIn ?? 900,
    interval: auth.interval ?? 5,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  }
}

/**
 * Poll the AWS OIDC token endpoint until the user approves the Kiro
 * device code. Call after `initiateKiroOAuth()` so the caller can
 * display user_code during the wait.
 */
export async function completeKiroOAuth(handles: KiroDeviceHandles): Promise<{
  accessToken: string
  refreshToken: string
}> {
  let interval = handles.interval * 1000
  const deadline = Date.now() + handles.expiresIn * 1000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval))
    const res = await fetch(`${KIRO_OIDC_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: handles.clientId,
        clientSecret: handles.clientSecret,
        deviceCode: handles.deviceCode,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const rawData = await res.json() as Record<string, unknown> & {
      error?: string
      error_description?: string
    }
    const data = _normalizeKiroTokenPayload(rawData)
    if (data.accessToken) {
      _saveTokens(KIRO_STORAGE, {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
        meta: {
          authMethod: 'builder-id',
          clientId: handles.clientId,
          clientSecret: handles.clientSecret,
          region: 'us-east-1',
        },
      })
      await _reloadKiroLaneAuth()
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? '',
      }
    }
    if (rawData.error === 'authorization_pending') continue
    if (rawData.error === 'slow_down') { interval += 5000; continue }
    if (rawData.error === 'expired_token') throw new Error('Kiro device code expired')
    if (rawData.error === 'access_denied') throw new Error('Kiro authorization denied')
    if (rawData.error) throw new Error(`Kiro OAuth error: ${rawData.error_description ?? rawData.error}`)
  }
  throw new Error('Kiro authorization timed out')
}

export async function startKiroOAuth(): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const handles = await initiateKiroOAuth()
  await openBrowser(handles.verificationUriComplete || handles.verificationUri)
  return completeKiroOAuth(handles)
}

export function getKiroOAuthToken(): string | null {
  return _loadTokens(KIRO_STORAGE)?.accessToken ?? null
}

export async function getValidKiroOAuthToken(): Promise<string | null> {
  const blob = _loadTokens(KIRO_STORAGE)
  if (!blob?.accessToken) return null

  if (blob.expiresAt && Date.now() > blob.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    if (!blob.refreshToken) return null
    try {
      return await refreshKiroOAuth(blob.refreshToken)
    } catch {
      return null
    }
  }

  return blob.accessToken
}


export async function initiateKiroSocialOAuth(
  provider: KiroSocialProvider,
): Promise<KiroSocialHandles> {
  const { verifier, challenge } = _pkce()
  const state = randomBytes(32).toString('base64url')
  const authUrl = new URL(`${KIRO_SOCIAL_AUTH_SERVICE}/login`)

  authUrl.searchParams.set('idp', provider === 'google' ? 'Google' : 'Github')
  authUrl.searchParams.set('redirect_uri', KIRO_SOCIAL_REDIRECT_URI)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('prompt', 'select_account')

  return {
    provider,
    authUrl: authUrl.toString(),
    state,
    codeVerifier: verifier,
  }
}

export async function completeKiroSocialOAuth(opts: {
  provider: KiroSocialProvider
  callbackUrl: string
  codeVerifier: string
  expectedState: string
}): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const callbackUrl = opts.callbackUrl.trim()
  let parsedUrl: URL
  try {
    parsedUrl = new URL(callbackUrl)
  } catch {
    const query = callbackUrl.replace(/^[?#]/, '')
    if (!query.includes('=')) {
      throw new Error('Kiro social login: invalid callback URL')
    }
    try {
      parsedUrl = new URL(`${KIRO_SOCIAL_REDIRECT_URI}?${query}`)
    } catch {
      throw new Error('Kiro social login: invalid callback URL')
    }
  }

  const error = parsedUrl.searchParams.get('error')
  if (error) {
    throw new Error(
      parsedUrl.searchParams.get('error_description')
        ?? `Kiro social login failed: ${error}`,
    )
  }

  const returnedState = parsedUrl.searchParams.get('state')
  if (!returnedState || returnedState !== opts.expectedState) {
    throw new Error('Kiro social login: state mismatch')
  }

  const code = parsedUrl.searchParams.get('code')
  if (!code) {
    throw new Error('Kiro social login: missing authorization code')
  }

  const res = await fetch(`${KIRO_SOCIAL_AUTH_SERVICE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: opts.codeVerifier,
      redirect_uri: KIRO_SOCIAL_REDIRECT_URI,
    }),
  })
  if (!res.ok) {
    throw new Error(`Kiro social token exchange failed: ${await res.text()}`)
  }

  const data = _normalizeKiroTokenPayload(await res.json() as Record<string, unknown>)
  if (!data.accessToken) throw new Error('Kiro social login: no access token returned')

  _saveTokens(KIRO_STORAGE, {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn ?? 3600,
    meta: {
      authMethod: opts.provider,
      profileArn: data.profileArn ?? null,
      region: 'us-east-1',
    },
  })
  await _reloadKiroLaneAuth()

  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? '',
  }
}

export async function refreshKiroOAuth(refreshToken: string): Promise<string> {
  const blob = _loadTokens(KIRO_STORAGE)
  const clientId = blob?.meta?.clientId as string | undefined
  const clientSecret = blob?.meta?.clientSecret as string | undefined
  const baseMeta = blob?.meta ?? {}
  if (!(clientId && clientSecret)) {
    const socialRes = await fetch(`${KIRO_SOCIAL_AUTH_SERVICE}/refreshToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!socialRes.ok) {
      throw new Error(`Kiro social refresh failed: ${await socialRes.text()}`)
    }
    const socialData = _normalizeKiroTokenPayload(await socialRes.json() as Record<string, unknown>)
    if (!socialData.accessToken) {
      throw new Error('Kiro social refresh: no access token')
    }
    _saveTokens(KIRO_STORAGE, {
      accessToken: socialData.accessToken,
      refreshToken: socialData.refreshToken ?? refreshToken,
      expiresIn: socialData.expiresIn ?? 3600,
      meta: {
        ...baseMeta,
        ...(socialData.profileArn ? { profileArn: socialData.profileArn } : {}),
      },
    })
    await _reloadKiroLaneAuth()
    return socialData.accessToken
  }
  const res = await fetch(`${KIRO_OIDC_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      clientSecret,
      refreshToken,
      grantType: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Kiro refresh failed: ${await res.text()}`)
  const data = _normalizeKiroTokenPayload(await res.json() as Record<string, unknown>)
  if (!data.accessToken) throw new Error('Kiro refresh: no access token')
  _saveTokens(KIRO_STORAGE, {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? refreshToken,
    expiresIn: data.expiresIn,
    meta: baseMeta,
  })
  await _reloadKiroLaneAuth()
  return data.accessToken
}

// ═══════════════════════════════════════════════════════════════════
// Cursor — native browser login
// ═══════════════════════════════════════════════════════════════════
//
// Mirrors Cursor CLI/IDE's loginDeepControl flow without shelling out to
// either binary. The browser approves a uuid/challenge pair, then api2's
// /auth/poll returns the account tokens for this standalone claudex session.

const CURSOR_STORAGE = 'cursor_oauth'
const CURSOR_WEBSITE_BASE = process.env.CURSOR_WEBSITE_URL ?? 'https://cursor.com'
const CURSOR_API_BASE = process.env.CURSOR_API_BASE_URL ?? 'https://api2.cursor.sh'
const CURSOR_POLL_INITIAL_DELAY_MS = 1000
const CURSOR_POLL_MAX_DELAY_MS = 10_000
const CURSOR_POLL_MAX_ATTEMPTS = 150

interface CursorPollPayload {
  accessToken?: string
  refreshToken?: string
}

async function _waitForCursorOAuthResult(
  uuid: string,
  verifier: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const pollUrl = new URL(`${CURSOR_API_BASE}/auth/poll`)
  pollUrl.searchParams.set('uuid', uuid)
  pollUrl.searchParams.set('verifier', verifier)

  let delayMs = CURSOR_POLL_INITIAL_DELAY_MS
  let consecutiveFailures = 0

  for (let attempt = 0; attempt < CURSOR_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(pollUrl, {
        headers: { 'Content-Type': 'application/json' },
      })

      if (res.status === 404) {
        consecutiveFailures = 0
      } else if (!res.ok) {
        consecutiveFailures += 1
        if (consecutiveFailures >= 3) return null
      } else {
        const data = await res.json() as CursorPollPayload
        if (data.accessToken && data.refreshToken) {
          return {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
          }
        }
        consecutiveFailures += 1
        if (consecutiveFailures >= 3) return null
      }
    } catch {
      consecutiveFailures += 1
      if (consecutiveFailures >= 3) return null
    }

    await _sleep(delayMs)
    delayMs = Math.min(delayMs * 2, CURSOR_POLL_MAX_DELAY_MS)
  }

  return null
}

export async function startCursorOAuth(): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const { verifier, challenge } = _pkce()
  const uuid = randomUUID()

  const authUrl = new URL(`${CURSOR_WEBSITE_BASE}/loginDeepControl`)
  authUrl.searchParams.set('challenge', challenge)
  authUrl.searchParams.set('uuid', uuid)
  authUrl.searchParams.set('mode', 'login')
  authUrl.searchParams.set('redirectTarget', 'cli')

  await openBrowser(authUrl.toString())

  const tokens = await _waitForCursorOAuthResult(uuid, verifier)
  if (!tokens) {
    throw new Error(
      'Cursor browser login did not complete. Re-run `/login cursor` and approve the sign-in in your browser.',
    )
  }

  _saveTokens(CURSOR_STORAGE, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: _getJwtExpirySeconds(tokens.accessToken),
    meta: { authMethod: 'browser' },
  })
  await _reloadCursorLaneAuth()

  return tokens
}

export function saveCursorToken(
  accessToken: string,
  machineId?: string,
): void {
  // Legacy/manual escape hatch only. Normal Cursor auth uses startCursorOAuth().
  if (!accessToken || accessToken.length < 10) {
    throw new Error('Cursor token looks invalid (too short)')
  }
  _saveTokens(CURSOR_STORAGE, {
    accessToken,
    expiresIn: _getJwtExpirySeconds(accessToken),
    meta: machineId ? { machineId } : undefined,
  })
  void _reloadCursorLaneAuth().catch(() => {})
}

export function getCursorOAuthToken(): string | null {
  return _loadTokens(CURSOR_STORAGE)?.accessToken ?? null
}

export function getValidCursorOAuthToken(): string | null {
  const blob = _loadTokens(CURSOR_STORAGE)
  if (!blob?.accessToken) return null
  if (blob.expiresAt && Date.now() > blob.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return null
  }
  return blob.accessToken
}

export function getCursorMachineId(): string | null {
  const blob = _loadTokens(CURSOR_STORAGE)
  return (blob?.meta?.machineId as string) ?? null
}

export function clearCursorToken(): void {
  deleteProviderKey(CURSOR_STORAGE)
  void _reloadCursorLaneAuth().catch(() => {})
}
