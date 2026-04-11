/**
 * OpenAI OAuth2 PKCE flow for API access.
 *
 * Uses the same bundled OAuth client ID as OpenAI's Codex CLI
 * (a public PKCE client — no client secret needed).
 *
 * Flow:
 *   1. Generate PKCE code_verifier + code_challenge (S256)
 *   2. Open browser to OpenAI consent screen
 *   3. Spin up local HTTP server for the redirect callback
 *   4. Exchange authorization code for access + refresh tokens
 *   5. Store tokens via api_key_manager
 *   6. Auto-refresh when expired
 *
 * No env vars required — works out of the box.
 * The user signs in with their ChatGPT / OpenAI account.
 */

import { createServer } from 'http'
import { randomBytes, createHash } from 'crypto'
import { saveProviderKey, loadProviderKey } from './api_key_manager.js'
import { openBrowser } from '../../../utils/browser.js'

// ─── Bundled OAuth credentials (from openai/codex CLI) ───────────────
// Source: https://github.com/openai/codex — public PKCE client, no secret
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
// Originator identifier — must be sent so OpenAI recognizes us as a
// Codex-compatible client. Matches codex-rs default.
const ORIGINATOR = 'codex_cli_rs'

// ─── OAuth endpoints ──────────────────────────────────────────────────

// IMPORTANT: must be /oauth/authorize (not /authorize) — the shorter path
// returns a blank / broken page in the browser.
const OPENAI_AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REDIRECT_PATH = '/auth/callback'
// Codex CLI's registered port — OpenAI validates redirect URIs exactly
const DEFAULT_PORT = 1455

// Must match the Codex CLI scope list exactly — these are the scopes
// registered for app_EMoamEEZ73f0CkXaXp7hrann. Missing api.connectors.*
// causes a "scope not allowed" error.
const SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke'

interface OpenAIOAuthTokens {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope?: string
}

interface StoredOpenAITokens {
  accessToken: string
  refreshToken: string
  expiresAt: number  // Unix timestamp ms
}

// ─── PKCE Helpers ──────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

// ─── OAuth Flow ────────────────────────────────────────────────────

/**
 * Start the OpenAI OAuth PKCE flow.
 * Opens the user's browser to sign in with their OpenAI/ChatGPT account.
 * No configuration required — uses bundled Codex CLI credentials.
 */
export async function startOpenAIOAuthFlow(): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = randomBytes(16).toString('hex')

  // Must use port 1455 — matches Codex CLI's registered redirect URI
  const port = await tryPort(DEFAULT_PORT)
  const redirectUri = `http://localhost:${port}${REDIRECT_PATH}`

  // Build authorization URL
  // The extra id_token_add_organizations + codex_cli_simplified_flow params
  // are required by OpenAI's Codex OAuth client — omitting them triggers a
  // blank response page in the browser.
  const authUrl = new URL(OPENAI_AUTH_URL)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('id_token_add_organizations', 'true')
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
  authUrl.searchParams.set('originator', ORIGINATOR)
  authUrl.searchParams.set('state', state)

  const authUrlString = authUrl.toString()
  const opened = await openBrowser(authUrlString)
  if (!opened) {
    console.log(
      `\nOpen this URL in your browser to sign in with OpenAI:\n${authUrlString}\n`,
    )
  }

  // Start local server and wait for callback
  const authCode = await waitForAuthCode(port, state)

  // Exchange code for tokens (PKCE — no client_secret needed)
  const tokenResponse = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: authCode,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  })

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text()
    throw new Error(`OpenAI token exchange failed: ${errText}`)
  }

  const tokens = (await tokenResponse.json()) as OpenAIOAuthTokens

  // Store tokens
  const stored: StoredOpenAITokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
    expiresAt: Date.now() + tokens.expires_in * 1000,
  }
  saveProviderKey('openai_oauth', JSON.stringify(stored))

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
  }
}

/**
 * Refresh an expired OpenAI OAuth access token.
 */
export async function refreshOpenAIToken(refreshToken: string): Promise<string> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenAI token refresh failed: ${errText}`)
  }

  const tokens = (await response.json()) as OpenAIOAuthTokens

  // Update stored tokens
  const stored: StoredOpenAITokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  }
  saveProviderKey('openai_oauth', JSON.stringify(stored))

  return tokens.access_token
}

/**
 * Get a valid OpenAI OAuth access token, refreshing if expired.
 * Returns null if no OAuth tokens are stored.
 */
export async function getOpenAIOAuthToken(): Promise<string | null> {
  const stored = loadProviderKey('openai_oauth')
  if (!stored) return null

  try {
    const tokens = JSON.parse(stored) as StoredOpenAITokens

    // Check if token is expired (with 5 min buffer)
    if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
      if (tokens.refreshToken) {
        return await refreshOpenAIToken(tokens.refreshToken)
      }
      return null  // No refresh token, need full re-auth
    }

    return tokens.accessToken
  } catch {
    return null
  }
}

// ─── Internal helpers ──────────────────────────────────────────────

/**
 * Try to bind to the given port. Returns the port if available.
 * Throws if the port is in use — OpenAI requires port 1455 specifically.
 */
function tryPort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is in use. Close the application using it and try again.\n` +
          `OpenAI OAuth requires this specific port for the redirect callback.`,
        ))
      } else {
        reject(err)
      }
    })
    server.listen(port, () => {
      server.close(() => resolve(port))
    })
  })
}

function waitForAuthCode(port: number, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('OAuth callback timed out after 5 minutes'))
    }, 5 * 60 * 1000)

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', `http://localhost:${port}`)

      if (url.pathname === REDIRECT_PATH) {
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        const state = url.searchParams.get('state')

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(`<h1>Authentication Failed</h1><p>${error}</p>`)
          clearTimeout(timeout)
          server.close()
          reject(new Error(`OpenAI OAuth error: ${error}`))
          return
        }

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<h1>Authentication Failed</h1><p>Invalid state.</p>')
          clearTimeout(timeout)
          server.close()
          reject(new Error('OpenAI OAuth error: invalid state parameter'))
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

    server.listen(port)
  })
}
