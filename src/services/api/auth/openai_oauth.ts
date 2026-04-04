/**
 * OpenAI OAuth2 PKCE flow for API access.
 *
 * OpenAI supports OAuth2 for third-party applications via their platform.
 * This enables users to authenticate with their OpenAI account directly
 * without manually copying an API key.
 *
 * Scopes: model.request (infer), api.all (full access)
 * Auth endpoint: https://auth.openai.com/authorize
 * Token endpoint: https://auth.openai.com/oauth/token
 *
 * Flow:
 *   1. Generate code_verifier + code_challenge (PKCE S256)
 *   2. Open browser to OpenAI auth URL
 *   3. Spin up local HTTP server to receive callback
 *   4. Exchange authorization code for tokens
 *   5. Store tokens via api_key_manager
 *   6. Auto-refresh when expired
 *
 * Requires: OPENAI_CLIENT_ID environment variable (or stored in config).
 * Get client ID by registering an app at: https://platform.openai.com/settings/apps
 */

import { createServer } from 'http'
import { randomBytes, createHash } from 'crypto'
import { saveProviderKey, loadProviderKey } from './api_key_manager.js'

// ─── Configuration ─────────────────────────────────────────────────

const OPENAI_AUTH_URL = 'https://auth.openai.com/authorize'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const SCOPES = 'model.request'
const REDIRECT_PATH = '/oauth/callback'

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
 * Opens the user's browser and waits for the callback.
 *
 * Returns access and refresh tokens on success.
 */
export async function startOpenAIOAuthFlow(): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const clientId = process.env.OPENAI_CLIENT_ID
  if (!clientId) {
    throw new Error(
      'OPENAI_CLIENT_ID environment variable is required for OpenAI OAuth.\n' +
      'Register an app at: https://platform.openai.com/settings/apps\n' +
      'Select "Web Application" as the application type.',
    )
  }

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  // Find a free port for the callback server
  const port = await findFreePort()
  const redirectUri = `http://localhost:${port}${REDIRECT_PATH}`

  // Build authorization URL
  const authUrl = new URL(OPENAI_AUTH_URL)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')

  // Print auth URL for user
  console.log(`\nOpen this URL in your browser to authenticate with OpenAI:\n${authUrl.toString()}\n`)

  // Start local server and wait for callback
  const authCode = await waitForAuthCode(port)

  // Exchange code for tokens
  const tokenResponse = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: authCode,
      client_id: clientId,
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
  const clientId = process.env.OPENAI_CLIENT_ID
  if (!clientId) throw new Error('OPENAI_CLIENT_ID required for token refresh')

  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
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
          reject(new Error(`OpenAI OAuth error: ${error}`))
          return
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<h1>Authentication Successful!</h1><p>You can close this window and return to Claude Code.</p>')
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
