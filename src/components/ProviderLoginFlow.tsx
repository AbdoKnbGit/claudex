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
  saveProviderKey,
  validateKeyFormat,
} from '../services/api/auth/api_key_manager.js'
import { startProviderOAuth } from '../services/api/auth/provider_auth.js'
import TextInput from './TextInput.js'

// ─── Provider metadata ───────────────────────────────────────────

interface ProviderMeta {
  envVar: string
  keyPrefix: string
  getKeyUrl: string
  supportsOAuth: boolean
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
}

type AuthMethod = 'api_key' | 'oauth'

type Props = {
  provider: APIProvider
  onDone: (success: boolean) => void
}

type FlowState =
  | { step: 'choose_method' }
  | { step: 'api_key_input'; error?: string }
  | { step: 'oauth_pending' }
  | { step: 'validating' }
  | { step: 'success' }
  | { step: 'error'; message: string }

export function ProviderLoginFlow({ provider, onDone }: Props) {
  const meta = PROVIDER_META[provider]
  const name = PROVIDER_DISPLAY_NAMES[provider]
  const supportsOAuth = meta?.supportsOAuth ?? false

  const [state, setState] = useState<FlowState>(
    supportsOAuth ? { step: 'choose_method' } : { step: 'api_key_input' },
  )
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyCursorOffset, setApiKeyCursorOffset] = useState(0)
  const [selectedMethod, setSelectedMethod] = useState<number>(0)
  const inputColumns = Math.max(20, (process.stdout.columns ?? 80) - 12)

  useInput((input: string, key: { return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean }) => {
    if (key.escape) {
      onDone(false)
      return
    }

    if (state.step === 'choose_method') {
      if (key.upArrow || key.downArrow) {
        setSelectedMethod((i) => (i === 0 ? 1 : 0))
        return
      }
      if (key.return) {
        const method: AuthMethod = selectedMethod === 0 ? 'oauth' : 'api_key'
        if (method === 'oauth') {
          setState({ step: 'oauth_pending' })
          startProviderOAuth(provider)
            .then(({ accessToken, refreshToken }) => {
              // Store OAuth tokens as JSON in the key store
              saveProviderKey(`${provider}_oauth`, JSON.stringify({
                accessToken,
                refreshToken,
                savedAt: new Date().toISOString(),
              }))
              setState({ step: 'success' })
              setTimeout(() => onDone(true), 1000)
            })
            .catch((err) => {
              setState({ step: 'error', message: err?.message ?? 'OAuth flow failed' })
            })
        } else {
          setState({ step: 'api_key_input' })
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
  function handleApiKeySubmit(value: string) {
    const key = value.trim()
    if (!key) return

    const validation = validateKeyFormat(provider, key)
    if (!validation.valid) {
      setState({ step: 'api_key_input', error: validation.error })
      setApiKeyInput('')
      setApiKeyCursorOffset(0)
      return
    }

    setState({ step: 'validating' })

    // Store the key
    saveProviderKey(provider, key)

    // Also set as environment variable for the current session
    const envVar = meta?.envVar
    if (envVar) {
      process.env[envVar] = key
    }

    setState({ step: 'success' })
    setTimeout(() => onDone(true), 800)
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
            <Text bold={selectedMethod === 0} color={selectedMethod === 0 ? 'claude' : undefined}>
              {selectedMethod === 0 ? '> ' : '  '}OAuth (Browser Login)
            </Text>
            <Text bold={selectedMethod === 1} color={selectedMethod === 1 ? 'claude' : undefined}>
              {selectedMethod === 1 ? '> ' : '  '}API Key
            </Text>
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
