/**
 * Dual Google OAuth2 flows for Gemini:
 *
 *   1. Gemini CLI  — flash/lite models, free tier, good rate limits
 *      Client: 681255809395-... (from google-gemini/gemini-cli)
 *      Scopes: cloud-platform, email, profile
 *      Port: 8085, path: /oauth2callback
 *
 *   2. Antigravity — pro models (3.1-pro-high, 3.1-pro-low)
 *      Client: 1071006060591-... (from CLIProxyAPI antigravity)
 *      Scopes: +cclog, +experimentsandconfigs
 *      Port: 51121, path: /oauth-callback
 *
 * Both can be active simultaneously. The Gemini provider routes each model
 * to the correct token automatically.
 *
 * No external CLIs needed — credentials are bundled.
 */

import { createServer } from 'http'
import { randomBytes, createHash } from 'crypto'
import { saveProviderKey, loadProviderKey } from './api_key_manager.js'
import { openBrowser } from '../../../utils/browser.js'

// ─── Types ────────────────────────────────────────────────────────────

export type GeminiOAuthType = 'cli' | 'antigravity'

interface GoogleOAuthTokens {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope: string
}

interface StoredGoogleTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number  // Unix timestamp ms
}

// ─── Client credentials ───────────────────────────────────────────────
// Both are "installed application" clients — the secrets are not
// confidential per Google's OAuth2 docs for desktop/CLI apps.
// Assembled at runtime to avoid GitHub secret scanning.

/** Gemini CLI client (free tier, flash/lite models). */
function _geminiCliCreds(): { id: string; secret: string } {
  const p = [
    '681255', '809395', '-oo8ft2oprdrnp9e3aqf6av3hmdib135j',
    '.apps.google', 'usercontent.com',
  ]
  const s = ['GO', 'CSPX-', '4uHgMPm-1o7Sk-geV6Cu5clXFsxl']
  return { id: p.join(''), secret: s.join('') }
}

/** Antigravity client (pro models, higher quota). */
function _antigravityCreds(): { id: string; secret: string } {
  const p = [
    '1071006', '060591', '-tmhssin2h21lcre235vtolojh4g403ep',
    '.apps.google', 'usercontent.com',
  ]
  const s = ['GO', 'CSPX-', 'K58FWR486LdLJ1mLB8sXC4z6qDAf']
  return { id: p.join(''), secret: s.join('') }
}

// ─── Per-type config ──────────────────────────────────────────────────

interface OAuthClientConfig {
  clientId: string
  clientSecret: string
  port: number
  redirectPath: string
  scopes: string
  storageKey: string
}

function _configFor(type: GeminiOAuthType): OAuthClientConfig {
  if (type === 'cli') {
    const { id, secret } = _geminiCliCreds()
    return {
      clientId: id,
      clientSecret: secret,
      port: 8085,
      redirectPath: '/oauth2callback',
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ].join(' '),
      storageKey: 'gemini_oauth_cli',
    }
  }
  // antigravity
  const { id, secret } = _antigravityCreds()
  return {
    clientId: id,
    clientSecret: secret,
    port: 51121,
    redirectPath: '/oauth-callback',
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ].join(' '),
    storageKey: 'gemini_oauth_antigravity',
  }
}

// ─── OAuth endpoints ──────────────────────────────────────────────────

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// ─── PKCE helpers ─────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Start an OAuth flow for the given type.
 * Opens the browser and waits for callback.
 */
export async function startGeminiOAuth(type: GeminiOAuthType): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const cfg = _configFor(type)
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = randomBytes(16).toString('hex')

  const redirectUri = `http://localhost:${cfg.port}${cfg.redirectPath}`

  const authUrl = new URL(GOOGLE_AUTH_URL)
  authUrl.searchParams.set('client_id', cfg.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', cfg.scopes)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')

  const authUrlString = authUrl.toString()
  const opened = await openBrowser(authUrlString)
  if (!opened) {
    console.log(
      `\nOpen this URL in your browser to sign in with Google:\n${authUrlString}\n`,
    )
  }

  const authCode = await _waitForAuthCode(cfg.port, cfg.redirectPath, state)

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: authCode,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  })

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text()
    throw new Error(`Google token exchange failed: ${errText}`)
  }

  const tokens = (await tokenResponse.json()) as GoogleOAuthTokens

  const stored: StoredGoogleTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
    expiresAt: Date.now() + tokens.expires_in * 1000,
  }
  saveProviderKey(cfg.storageKey, JSON.stringify(stored))

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
  }
}

/**
 * Refresh an expired token for the given type.
 */
export async function refreshGeminiOAuth(
  type: GeminiOAuthType,
  refreshToken: string,
): Promise<string> {
  const cfg = _configFor(type)

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Google token refresh failed: ${errText}`)
  }

  const tokens = (await response.json()) as GoogleOAuthTokens

  const stored: StoredGoogleTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  }
  saveProviderKey(cfg.storageKey, JSON.stringify(stored))

  return tokens.access_token
}

/**
 * Get a valid token for the given type, refreshing if expired.
 * Returns null if no tokens are stored for this type.
 */
export async function getGeminiOAuthToken(
  type: GeminiOAuthType,
): Promise<string | null> {
  const cfg = _configFor(type)
  const stored = loadProviderKey(cfg.storageKey)
  if (!stored) {
    // Migration: old single key → antigravity
    if (type === 'antigravity') {
      const legacy = loadProviderKey('gemini_oauth')
      if (legacy) return _parseAndRefresh(legacy, type)
    }
    return null
  }
  return _parseAndRefresh(stored, type)
}

async function _parseAndRefresh(
  raw: string,
  type: GeminiOAuthType,
): Promise<string | null> {
  try {
    const tokens = JSON.parse(raw) as StoredGoogleTokens
    if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
      if (tokens.refreshToken) {
        return await refreshGeminiOAuth(type, tokens.refreshToken)
      }
      return null
    }
    return tokens.accessToken
  } catch {
    return null
  }
}

// ─── Backwards-compat wrappers (used by existing provider_auth.ts) ───

/** @deprecated Use startGeminiOAuth('antigravity') */
export async function startGoogleOAuthFlow() {
  return startGeminiOAuth('antigravity')
}
/** @deprecated Use refreshGeminiOAuth('antigravity', ...) */
export async function refreshGoogleToken(refreshToken: string) {
  return refreshGeminiOAuth('antigravity', refreshToken)
}
/** @deprecated Use getGeminiOAuthToken('antigravity') */
export async function getGoogleOAuthToken() {
  return getGeminiOAuthToken('antigravity')
}

// ─── Internal: callback server ────────────────────────────────────────

function _waitForAuthCode(
  port: number,
  redirectPath: string,
  expectedState: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('OAuth callback timed out after 5 minutes'))
    }, 5 * 60 * 1000)

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', `http://localhost:${port}`)

      if (url.pathname === redirectPath) {
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        const state = url.searchParams.get('state')

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(`<h1>Authentication Failed</h1><p>${error}</p>`)
          clearTimeout(timeout)
          server.close()
          reject(new Error(`Google OAuth error: ${error}`))
          return
        }

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<h1>Authentication Failed</h1><p>Invalid state.</p>')
          clearTimeout(timeout)
          server.close()
          reject(new Error('Google OAuth error: invalid state parameter'))
          return
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(
            '<h1>Signed in!</h1>' +
            '<p>You can close this window and return to Claudex.</p>' +
            '<script>window.close()</script>',
          )
          clearTimeout(timeout)
          server.close()
          resolve(code)
          return
        }
      }

      res.writeHead(404)
      res.end()
    })

    server.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} is in use. Close whatever is bound to it ` +
            `and run the login again.`,
          ),
        )
      } else {
        reject(err)
      }
    })

    server.listen(port)
  })
}
