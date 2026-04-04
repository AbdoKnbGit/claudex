/**
 * Google OAuth2 PKCE flow for Gemini API access.
 *
 * This enables users to authenticate with Google without an API key,
 * using their Google account directly. Useful for Gemini access.
 *
 * Scopes: https://www.googleapis.com/auth/generative-language
 *
 * Flow:
 *   1. Generate code_verifier + code_challenge (PKCE S256)
 *   2. Open browser to Google auth URL
 *   3. Spin up local HTTP server to receive callback
 *   4. Exchange authorization code for tokens
 *   5. Store tokens via api_key_manager
 *   6. Auto-refresh when expired
 *
 * Requires: GOOGLE_CLIENT_ID environment variable (or stored in config).
 * Optional: GOOGLE_CLIENT_SECRET for confidential clients.
 */

import { createServer } from 'http'
import { randomBytes, createHash } from 'crypto'
import { saveProviderKey, loadProviderKey } from './api_key_manager.js'

// ─── Configuration ─────────────────────────────────────────────────

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPES = 'https://www.googleapis.com/auth/generative-language'
const REDIRECT_PATH = '/oauth/callback'

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

// ─── PKCE Helpers ──────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

// ─── OAuth Flow ────────────────────────────────────────────────────

/**
 * Start the Google OAuth PKCE flow.
 * Opens the user's browser and waits for the callback.
 *
 * Returns access and refresh tokens on success.
 */
export async function startGoogleOAuthFlow(): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) {
    throw new Error(
      'GOOGLE_CLIENT_ID environment variable is required for Google OAuth.\n' +
      'Create one at: https://console.cloud.google.com/apis/credentials\n' +
      'Select "Desktop App" as the application type.',
    )
  }

  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  // Find a free port for the callback server
  const port = await findFreePort()
  const redirectUri = `http://localhost:${port}${REDIRECT_PATH}`

  // Build authorization URL
  const authUrl = new URL(GOOGLE_AUTH_URL)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')

  // Start local server and wait for callback
  const authCode = await waitForAuthCode(port)

  // Exchange code for tokens
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: authCode,
      client_id: clientId,
      client_secret: clientSecret,
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

  // Store tokens
  const stored: StoredGoogleTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
    expiresAt: Date.now() + tokens.expires_in * 1000,
  }
  saveProviderKey('gemini_oauth', JSON.stringify(stored))

  // Return the auth URL for the caller to open in the browser
  console.log(`\nOpen this URL in your browser to authenticate:\n${authUrl.toString()}\n`)

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
  }
}

/**
 * Refresh an expired Google OAuth access token.
 */
export async function refreshGoogleToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID required for token refresh')

  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Google token refresh failed: ${errText}`)
  }

  const tokens = (await response.json()) as GoogleOAuthTokens

  // Update stored tokens
  const stored: StoredGoogleTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  }
  saveProviderKey('gemini_oauth', JSON.stringify(stored))

  return tokens.access_token
}

/**
 * Get a valid Google OAuth access token, refreshing if expired.
 * Returns null if no OAuth tokens are stored.
 */
export async function getGoogleOAuthToken(): Promise<string | null> {
  const stored = loadProviderKey('gemini_oauth')
  if (!stored) return null

  try {
    const tokens = JSON.parse(stored) as StoredGoogleTokens

    // Check if token is expired (with 5 min buffer)
    if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
      if (tokens.refreshToken) {
        return await refreshGoogleToken(tokens.refreshToken)
      }
      return null  // No refresh token, need full re-auth
    }

    return tokens.accessToken
  } catch {
    return null
  }
}

// ─── Internal helpers ──────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        reject(new Error('Could not determine port'))
      }
    })
  })
}

function waitForAuthCode(port: number): Promise<string> {
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

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(`<h1>Authentication Failed</h1><p>${error}</p>`)
          clearTimeout(timeout)
          server.close()
          reject(new Error(`Google OAuth error: ${error}`))
          return
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<h1>Authentication Successful!</h1><p>You can close this window.</p>')
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
