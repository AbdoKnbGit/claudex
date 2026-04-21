/**
 * ProviderLoginFlow — handles provider-specific login for third-party providers.
 *
 * For OAuth providers (OpenAI, Gemini): launches browser-based PKCE flow.
 * For API key providers (OpenRouter, Groq, NIM, DeepSeek): prompts for key input.
 */

import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import type { APIProvider } from '../utils/model/providers.js'
import { PROVIDER_DISPLAY_NAMES } from '../utils/model/providers.js'
import {
  deleteProviderKey,
  saveProviderKey,
  validateKeyFormat,
} from '../services/api/auth/api_key_manager.js'
import { startProviderOAuth, startGeminiOAuthFlow } from '../services/api/auth/provider_auth.js'
import {
  initiateCopilotOAuth, completeCopilotOAuth, type CopilotDeviceHandles,
  initiateKiroOAuth, completeKiroOAuth, type KiroDeviceHandles,
  saveCursorToken,
} from '../services/api/auth/oauth_services.js'
import { openBrowser } from '../utils/browser.js'
import TextInput from './TextInput.js'

// ─── Provider metadata ───────────────────────────────────────────

interface ProviderMeta {
  envVar: string
  keyPrefix: string
  getKeyUrl: string
  supportsOAuth: boolean
  oauthOnly?: boolean
}

const PROVIDER_META: Partial<Record<APIProvider, ProviderMeta>> = {
  openai: {
    envVar: 'OPENAI_API_KEY',
    keyPrefix: 'sk-',
    getKeyUrl: 'https://platform.openai.com/api-keys',
    supportsOAuth: true,
  },
  gemini: {
    envVar: 'GEMINI_API_KEY',
    keyPrefix: 'AIza',
    getKeyUrl: 'https://aistudio.google.com/apikey',
    supportsOAuth: true,
  },
  antigravity: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://antigravity.google/',
    supportsOAuth: true,
    oauthOnly: true,
  },
  openrouter: {
    envVar: 'OPENROUTER_API_KEY',
    keyPrefix: 'sk-or-',
    getKeyUrl: 'https://openrouter.ai/keys',
    supportsOAuth: false,
  },
  groq: {
    envVar: 'GROQ_API_KEY',
    keyPrefix: 'gsk_',
    getKeyUrl: 'https://console.groq.com/keys',
    supportsOAuth: false,
  },
  nim: {
    envVar: 'NIM_API_KEY',
    keyPrefix: 'nvapi-',
    getKeyUrl: 'https://build.nvidia.com/settings/api-keys',
    supportsOAuth: false,
  },
  deepseek: {
    envVar: 'DEEPSEEK_API_KEY',
    keyPrefix: 'sk-',
    getKeyUrl: 'https://platform.deepseek.com/api_keys',
    supportsOAuth: false,
  },
  kilocode: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://kilo.ai',
    supportsOAuth: true,
    oauthOnly: true,
  },
  cline: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://cline.bot',
    supportsOAuth: true,
    oauthOnly: true,
  },
  iflow: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://iflow.cn',
    supportsOAuth: true,
    oauthOnly: true,
  },
  copilot: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://github.com/features/copilot',
    supportsOAuth: true,
    oauthOnly: true,
  },
  kiro: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://kiro.dev',
    supportsOAuth: true,
    oauthOnly: true,
  },
  cursor: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://cursor.com',
    supportsOAuth: true,
    oauthOnly: true,
  },
}

type AuthMethod = 'api_key' | 'oauth' | 'oauth_cli' | 'oauth_antigravity'

/** Quick API-level check that an API key actually works before saving it. */
async function _testApiKey(
  provider: APIProvider,
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    let url: string
    let headers: Record<string, string> = {}

    switch (provider) {
      case 'gemini':
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
        break
      case 'openai':
        url = 'https://api.openai.com/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'groq':
        url = 'https://api.groq.com/openai/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'deepseek':
        url = 'https://api.deepseek.com/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'openrouter':
        url = 'https://openrouter.ai/api/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      default:
        // Can't test — accept optimistically
        return { ok: true }
    }

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
    })

    if (res.ok) return { ok: true }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: `API key rejected (${res.status}). Check that the key is correct and the API is enabled on your account.`,
      }
    }

    // Other errors (429, 500, etc.) — key format is OK, accept it
    return { ok: true }
  } catch {
    // Network error — can't test, accept optimistically
    return { ok: true }
  }
}

type Props = {
  provider: APIProvider
  onDone: (success: boolean) => void
}

type FlowState =
  | { step: 'choose_method' }
  | { step: 'api_key_input'; error?: string }
  | { step: 'oauth_pending' }
  | { step: 'device_code'; userCode: string; verificationUri: string }
  | { step: 'cursor_paste' }
  | { step: 'validating' }
  | { step: 'success' }
  | { step: 'error'; message: string }

export function ProviderLoginFlow({ provider, onDone }: Props) {
  const meta = PROVIDER_META[provider]
  const name = PROVIDER_DISPLAY_NAMES[provider]
  const supportsOAuth = meta?.supportsOAuth ?? false
  const oauthOnly = meta?.oauthOnly ?? false

  // Gemini now = free-tier Google OAuth or Studio API key. Antigravity
  // has its own provider row and runs the antigravity-tier flow itself.
  const isGemini = provider === 'gemini'
  const isAntigravity = provider === 'antigravity'
  const methodOptions: { method: AuthMethod; label: string }[] = isGemini
    ? [
        { method: 'oauth_cli', label: 'Google OAuth (free tier — flash/lite)' },
        { method: 'api_key', label: 'API Key (AI Studio)' },
      ]
    : isAntigravity
      ? [
          { method: 'oauth_antigravity', label: 'Antigravity login (Gemini 3 Flash / 3.1 Pro high/low)' },
        ]
      : oauthOnly
        ? [{ method: 'oauth', label: 'OAuth (Browser Login)' }]
        : supportsOAuth
          ? [
              { method: 'oauth', label: 'OAuth (Browser Login)' },
              { method: 'api_key', label: 'API Key' },
            ]
          : []

  const [state, setState] = useState<FlowState>(
    methodOptions.length > 0 ? { step: 'choose_method' } : { step: 'api_key_input' },
  )
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyCursorOffset, setApiKeyCursorOffset] = useState(0)
  const [selectedMethod, setSelectedMethod] = useState<number>(0)
  const inputColumns = Math.max(20, (process.stdout.columns ?? 80) - 12)

  function runOAuthFlow(method: AuthMethod) {
    // Cursor requires manual token paste — there's no public OAuth app.
    if (provider === 'cursor') {
      setState({ step: 'cursor_paste' })
      return
    }

    // GitHub Copilot + Kiro use device-code flows that need the user_code
    // visible in the terminal (the verification_uri does NOT pre-fill
    // the code for Copilot, and Kiro's completeUri isn't always honored).
    if (provider === 'copilot') {
      setState({ step: 'oauth_pending' })
      initiateCopilotOAuth()
        .then(async (handles: CopilotDeviceHandles) => {
          setState({
            step: 'device_code',
            userCode: handles.userCode,
            verificationUri: handles.verificationUri,
          })
          await openBrowser(handles.verificationUri).catch(() => {})
          const tokens = await completeCopilotOAuth(handles)
          deleteProviderKey(provider)
          setState({ step: 'success' })
          setTimeout(() => onDone(true), 1000)
          return tokens
        })
        .catch((err) => {
          setState({ step: 'error', message: err?.message ?? 'Copilot OAuth failed' })
        })
      return
    }

    if (provider === 'kiro') {
      setState({ step: 'oauth_pending' })
      initiateKiroOAuth()
        .then(async (handles: KiroDeviceHandles) => {
          setState({
            step: 'device_code',
            userCode: handles.userCode,
            verificationUri: handles.verificationUriComplete || handles.verificationUri,
          })
          await openBrowser(handles.verificationUriComplete || handles.verificationUri).catch(() => {})
          const tokens = await completeKiroOAuth(handles)
          deleteProviderKey(provider)
          setState({ step: 'success' })
          setTimeout(() => onDone(true), 1000)
          return tokens
        })
        .catch((err) => {
          setState({ step: 'error', message: err?.message ?? 'Kiro OAuth failed' })
        })
      return
    }

    setState({ step: 'oauth_pending' })
    const oauthPromise =
      method === 'oauth_cli' ? startGeminiOAuthFlow('cli')
        : method === 'oauth_antigravity' ? startGeminiOAuthFlow('antigravity')
          : startProviderOAuth(provider)
    oauthPromise
      .then(() => {
        // Activating OAuth deactivates API key for this provider.
        deleteProviderKey(provider)
        setState({ step: 'success' })
        setTimeout(() => onDone(true), 1000)
      })
      .catch((err) => {
        setState({ step: 'error', message: err?.message ?? 'OAuth flow failed' })
      })
  }

  function handleCursorTokenSubmit(value: string) {
    const token = value.trim()
    if (!token) return
    try {
      saveCursorToken(token)
      deleteProviderKey('cursor')  // remove any stale api_key record
      setState({ step: 'success' })
      setTimeout(() => onDone(true), 800)
    } catch (err) {
      setState({
        step: 'error',
        message: (err as Error)?.message ?? 'Cursor token save failed',
      })
    }
  }

  useInput((input: string, key: { return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean }) => {
    if (key.escape) {
      onDone(false)
      return
    }

    if (state.step === 'choose_method') {
      const total = methodOptions.length
      if (key.upArrow) {
        setSelectedMethod((i) => (i > 0 ? i - 1 : total - 1))
        return
      }
      if (key.downArrow) {
        setSelectedMethod((i) => (i < total - 1 ? i + 1 : 0))
        return
      }
      if (key.return) {
        const chosen = methodOptions[selectedMethod]
        if (!chosen) return
        if (chosen.method === 'api_key') {
          setState({ step: 'api_key_input' })
        } else {
          runOAuthFlow(chosen.method)
        }
      }
    }

    if (state.step === 'success') {
      onDone(true)
    }
    if (state.step === 'error' && key.return) {
      onDone(false)
    }
  })

  // ─── API key submission handler ──────────────────────────────────
  //
  // Save is unconditional — for every provider, every key shape, every
  // model tier. Format checks (prefix rules) and the /models network
  // test are both advisory: they never block the save. Rationale:
  //   - Provider prefix rules drift (NVIDIA ships non-nvapi- keys for
  //     certain models; DeepSeek Coder tokens vary; proxies re-issue
  //     keys with their own schemes).
  //   - /models 401/403 can fail on a perfectly valid key when the key
  //     is plan-tier-restricted or scoped to a subset of endpoints.
  //   - A saved-but-flagged key is strictly better UX than a rejected
  //     key; the user sees the warning and either keeps it or retries.
  function handleApiKeySubmit(value: string) {
    const key = value.trim()
    if (!key) return

    setState({ step: 'validating' })

    const persistAndFinish = (warnings: string[]) => {
      saveProviderKey(provider, key)
      deleteProviderKey(`${provider}_oauth`)
      if (provider === 'gemini') {
        // Only clear the CLI-tier Gemini OAuth. The Antigravity OAuth is
        // owned by its own provider row now — don't nuke it from under
        // the user just because they added a Studio key.
        deleteProviderKey('gemini_oauth_cli')
      }
      const envVar = meta?.envVar
      if (envVar) process.env[envVar] = key
      if (warnings.length > 0) {
        setState({
          step: 'error',
          message: `Key saved. Warnings:\n  • ${warnings.join('\n  • ')}`,
        })
        setTimeout(() => onDone(true), 2000)
      } else {
        setState({ step: 'success' })
        setTimeout(() => onDone(true), 800)
      }
    }

    const warnings: string[] = []
    const formatCheck = validateKeyFormat(provider, key)
    if (!formatCheck.valid && formatCheck.error) warnings.push(formatCheck.error)

    _testApiKey(provider, key)
      .then((testResult) => {
        if (!testResult.ok) warnings.push(testResult.error)
        persistAndFinish(warnings)
      })
      .catch(() => persistAndFinish(warnings))
  }

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1}>
        <Text bold color="claude">
          Login to {name}
        </Text>
      </Box>

      {state.step === 'choose_method' && (
        <Box flexDirection="column">
          <Text dimColor>Choose authentication method:</Text>
          <Box marginTop={1} flexDirection="column">
            {methodOptions.map((opt, i) => (
              <Text key={opt.method} bold={selectedMethod === i} color={selectedMethod === i ? 'claude' : undefined}>
                {selectedMethod === i ? '> ' : '  '}{opt.label}
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Arrow keys to select, Enter to confirm, Esc to cancel</Text>
          </Box>
        </Box>
      )}

      {state.step === 'api_key_input' && (
        <Box flexDirection="column">
          {meta && (
            <Text dimColor>
              Get your API key at: <Text color="suggestion">{meta.getKeyUrl}</Text>
            </Text>
          )}
          {meta && (
            <Text dimColor>
              Expected format: <Text color="warning">{meta.keyPrefix}...</Text>
            </Text>
          )}
          {'error' in state && state.error && (
            <Box marginTop={1}>
              <Text color="error">{state.error}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text>API Key: </Text>
            <TextInput
              value={apiKeyInput}
              onChange={setApiKeyInput}
              onSubmit={handleApiKeySubmit}
              mask="*"
              placeholder="Paste your API key here..."
              focus={true}
              showCursor={true}
              columns={inputColumns}
              cursorOffset={apiKeyCursorOffset}
              onChangeCursorOffset={setApiKeyCursorOffset}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Enter to submit, Esc to cancel</Text>
          </Box>
        </Box>
      )}

      {state.step === 'oauth_pending' && (
        <Box flexDirection="column">
          <Text color="warning">Opening browser for {name} authentication...</Text>
          <Text dimColor>Complete the login in your browser. Waiting for callback...</Text>
        </Box>
      )}

      {state.step === 'device_code' && (
        <Box flexDirection="column">
          <Text color="warning">Enter this code in your browser to authorize {name}:</Text>
          <Box marginTop={1} marginBottom={1}>
            <Text bold color="claude">  {state.userCode}</Text>
          </Box>
          <Text dimColor>URL: <Text color="suggestion">{state.verificationUri}</Text></Text>
          <Text dimColor>Waiting for authorization...</Text>
        </Box>
      )}

      {state.step === 'cursor_paste' && (
        <Box flexDirection="column">
          <Text dimColor>
            Cursor does not expose a public OAuth app. Paste your Cursor access token below.
          </Text>
          <Text dimColor>
            Get it from: <Text color="suggestion">Cursor → Settings → Cursor Auth → Copy token</Text>
          </Text>
          <Box marginTop={1}>
            <Text>Token: </Text>
            <TextInput
              value={apiKeyInput}
              onChange={setApiKeyInput}
              onSubmit={handleCursorTokenSubmit}
              mask="*"
              placeholder="Paste Cursor token..."
              focus={true}
              showCursor={true}
              columns={inputColumns}
              cursorOffset={apiKeyCursorOffset}
              onChangeCursorOffset={setApiKeyCursorOffset}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Enter to submit, Esc to cancel</Text>
          </Box>
        </Box>
      )}

      {state.step === 'validating' && (
        <Text color="warning">Validating credentials...</Text>
      )}

      {state.step === 'success' && (
        <Text color="success">Successfully logged in to {name}!</Text>
      )}

      {state.step === 'error' && (
        <Box flexDirection="column">
          <Text color="error">Login failed: {state.message}</Text>
          <Text dimColor>Press Enter to dismiss, or try again with /login</Text>
        </Box>
      )}
    </Box>
  )
}
