/**
 * OpenAI OAuth2 PKCE flow for API access.
 *
 * Uses the same bundled OAuth client ID as OpenAI's Codex CLI
 * (a public PKCE client — no client secret needed).
 *
 * Flow:
 *   1. Generate PKCE code_verifier + code_challenge (S256)
 *   2. Start local HTTP server on 127.0.0.1:1455 for the redirect callback
 *   3. Open browser to OpenAI consent screen
 *   4. Exchange authorization code → id_token + access_token + refresh_token
 *   5. Token-exchange the id_token → API-capable access token
 *      (matches Codex's obtain_api_key() — the first access token is only
 *       valid for auth service calls, not the OpenAI API)
 *   6. Redirect browser to /success, store tokens, done
 *   7. Auto-refresh when expired
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
const OPENAI_ISSUER = 'https://auth.openai.com'
const OPENAI_AUTH_URL = `${OPENAI_ISSUER}/oauth/authorize`
const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`
const REDIRECT_PATH = '/auth/callback'
const SUCCESS_PATH = '/success'
// Codex CLI's registered port — OpenAI validates redirect URIs exactly
const DEFAULT_PORT = 1455

// Must match the Codex CLI scope list exactly — these are the scopes
// registered for app_EMoamEEZ73f0CkXaXp7hrann. Missing api.connectors.*
// causes a "scope not allowed" error.
const SCOPES =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'

interface OpenAIOAuthTokens {
  access_token: string
  id_token?: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope?: string
}

interface StoredOpenAITokens {
  accessToken: string // API-capable token (from token exchange)
  refreshToken: string
  expiresAt: number // Unix timestamp ms
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

  // Must use port 1455 — matches Codex CLI's registered redirect URI.
  // OpenAI validates the redirect URI exactly, so we cannot fall back
  // to a random free port.
  const port = DEFAULT_PORT
  const redirectUri = `http://localhost:${port}${REDIRECT_PATH}`

  // Start the callback server BEFORE opening the browser so the redirect
  // always has something to talk to. If the port is in use we bail before
  // the user wastes time in their browser.
  const callbackReady = startCallbackServer(port, state)

  // Build authorization URL.
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

  // Wait until the server is actually listening before opening the browser.
  // If the port is in use we throw here and never pop a browser window.
  const { authCodePromise } = await callbackReady

  const authUrlString = authUrl.toString()
  const opened = await openBrowser(authUrlString)
  if (!opened) {
    console.log(
      `\nOpen this URL in your browser to sign in with OpenAI:\n${authUrlString}\n`,
    )
  }

  // Wait for the callback.
  const authCode = await authCodePromise

  // Step 1 — exchange authorization code for id_token + access_token + refresh_token.
  const firstExchange = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  })

  if (!firstExchange.ok) {
    const errText = await firstExchange.text()
    throw new Error(`OpenAI token exchange failed: ${errText}`)
  }

  const firstTokens = (await firstExchange.json()) as OpenAIOAuthTokens

  // Step 2 — token-exchange the id_token for an API-key access token.
  // Matches Codex's `obtain_api_key()`. The first-exchange access_token
  // is only valid for the auth service; API calls need the token we get
  // from this second exchange.
  let apiAccessToken = firstTokens.access_token
  if (firstTokens.id_token) {
    try {
      const exchange = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: CLIENT_ID,
          requested_token: 'openai-api-key',
          subject_token: firstTokens.id_token,
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          scope: 'openid profile email',
        }),
      })
      if (exchange.ok) {
        const exchanged = (await exchange.json()) as OpenAIOAuthTokens
        if (exchanged.access_token) {
          apiAccessToken = exchanged.access_token
        }
      }
    } catch {
      // If the second exchange fails, fall back to the first-exchange
      // access token — some endpoints may still accept it.
    }
  }

  // Store tokens
  const stored: StoredOpenAITokens = {
    accessToken: apiAccessToken,
    refreshToken: firstTokens.refresh_token ?? '',
    expiresAt: Date.now() + firstTokens.expires_in * 1000,
  }
  saveProviderKey('openai_oauth', JSON.stringify(stored))

  return {
    accessToken: apiAccessToken,
    refreshToken: firstTokens.refresh_token ?? '',
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

  // If the refresh response contains an id_token, do the second exchange
  // again so the stored token is always API-capable.
  let apiAccessToken = tokens.access_token
  if (tokens.id_token) {
    try {
      const exchange = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: CLIENT_ID,
          requested_token: 'openai-api-key',
          subject_token: tokens.id_token,
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          scope: 'openid profile email',
        }),
      })
      if (exchange.ok) {
        const exchanged = (await exchange.json()) as OpenAIOAuthTokens
        if (exchanged.access_token) {
          apiAccessToken = exchanged.access_token
        }
      }
    } catch {
      // Fall back to the refresh-response access token.
    }
  }

  // Update stored tokens
  const stored: StoredOpenAITokens = {
    accessToken: apiAccessToken,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  }
  saveProviderKey('openai_oauth', JSON.stringify(stored))

  return apiAccessToken
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
      return null // No refresh token, need full re-auth
    }

    return tokens.accessToken
  } catch {
    return null
  }
}

// ─── Internal helpers ──────────────────────────────────────────────

/**
 * Start the local callback server and return a promise for the auth code.
 *
 * Resolves once the server is actually listening (so the caller can open
 * the browser safely). The returned `authCodePromise` resolves when the
 * browser hits /auth/callback, or rejects on timeout / error / mismatched
 * state / port-in-use.
 *
 * We bind explicitly to 127.0.0.1 — on modern Windows Node defaults to
 * IPv6 `::` which leaves `localhost` (resolved to 127.0.0.1 via hosts)
 * with nothing listening, producing a "connection refused" / spinner that
 * the OpenAI auth page reports as "Operation timed out".
 */
function startCallbackServer(
  port: number,
  expectedState: string,
): Promise<{ authCodePromise: Promise<string> }> {
  return new Promise((resolveReady, rejectReady) => {
    let resolveCode: (code: string) => void = () => {}
    let rejectCode: (err: Error) => void = () => {}
    const authCodePromise = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    const timeout = setTimeout(
      () => {
        try {
          server.close()
        } catch {}
        rejectCode(new Error('OAuth callback timed out after 5 minutes'))
      },
      5 * 60 * 1000,
    )

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', `http://127.0.0.1:${port}`)

      if (url.pathname === REDIRECT_PATH) {
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        const state = url.searchParams.get('state')

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderErrorPage(`OpenAI returned: ${error}`))
          clearTimeout(timeout)
          setTimeout(() => {
            try {
              server.close()
            } catch {}
          }, 1000)
          rejectCode(new Error(`OpenAI OAuth error: ${error}`))
          return
        }

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderErrorPage('Invalid state parameter.'))
          clearTimeout(timeout)
          setTimeout(() => {
            try {
              server.close()
            } catch {}
          }, 1000)
          rejectCode(new Error('OpenAI OAuth error: invalid state parameter'))
          return
        }

        if (code) {
          // 302 → /success so the browser lands on a clean confirmation
          // page instead of the inline HTML we'd otherwise return.
          res.writeHead(302, { Location: SUCCESS_PATH })
          res.end()
          clearTimeout(timeout)
          // Keep the server alive long enough to serve /success before
          // closing — otherwise the browser sees "connection refused".
          setTimeout(() => {
            try {
              server.close()
            } catch {}
          }, 2000)
          resolveCode(code)
          return
        }
      }

      if (url.pathname === SUCCESS_PATH) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderSuccessPage())
        return
      }

      res.writeHead(404)
      res.end()
    })

    server.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
      if (err.code === 'EADDRINUSE') {
        const msg =
          `Port ${port} is in use. Close whatever is bound to it ` +
          `(maybe the real Codex CLI?) and try /login again. ` +
          `OpenAI OAuth requires this exact port for the redirect.`
        rejectReady(new Error(msg))
        rejectCode(new Error(msg))
      } else {
        rejectReady(err)
        rejectCode(err)
      }
    })

    // Bind to 127.0.0.1 explicitly so `localhost` always reaches us.
    server.listen(port, '127.0.0.1', () => {
      resolveReady({ authCodePromise })
    })
  })
}

function renderSuccessPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Signed in - Claudex</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #e2e8f0;
    }
    .card {
      background: rgba(30, 41, 59, 0.85);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 16px;
      padding: 48px 64px;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      max-width: 420px;
    }
    h1 { margin: 0 0 12px; font-size: 26px; font-weight: 600; color: #f8fafc; }
    p { margin: 0; color: #94a3b8; font-size: 15px; line-height: 1.5; }
    .check {
      width: 56px; height: 56px; margin: 0 auto 24px;
      border-radius: 50%;
      background: #10b981;
      display: flex; align-items: center; justify-content: center;
      font-size: 28px; color: white; font-weight: 700;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="check">&#10003;</div>
    <h1>Signed in</h1>
    <p>You can close this window and return to Claudex.</p>
  </main>
  <script>setTimeout(function(){ try { window.close() } catch (_) {} }, 1500);</script>
</body>
</html>`
}

function renderErrorPage(msg: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authentication failed - Claudex</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      padding: 40px; background: #1e293b; color: #fee2e2;
      min-height: 100vh; margin: 0;
    }
    h1 { color: #fca5a5; margin-bottom: 16px; }
    code { background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #e2e8f0; }
    p { line-height: 1.6; max-width: 540px; }
  </style>
</head>
<body>
  <h1>Authentication failed</h1>
  <p>${escapeHtml(msg)}</p>
  <p>Return to Claudex and run <code>/login</code> to try again.</p>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return map[c] ?? c
  })
}
