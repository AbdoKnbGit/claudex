/**
 * /provider — connect / disconnect AI providers.
 *
 * Two-view state machine:
 *   list       → overview of all manageable providers with auth badges
 *   configure  → per-provider options: Activate OAuth / Activate API Key / Deactivate
 *
 * Core rules (from spec):
 *   - Multiple providers can be connected simultaneously.
 *   - OAuth and API Key on the SAME provider are mutually exclusive —
 *     switching one deactivates the other (mutex is already enforced
 *     inside saveProviderKey / OAuth finish paths, we just call them).
 *   - The user only sees "OpenAI" and "Google Gemini" — CLIProxyAPI /
 *     Antigravity / Codex are implicit engines behind OAuth and never
 *     surface as provider rows.
 *   - OAuth flow is one step: browser opens, user picks account, done.
 *   - API Key flow: prompt → paste → validate → done.
 *
 * This command does NOT flip the "active provider" for routing — that's
 * owned by /model and surf. /provider is purely about which credentials
 * are connected.
 */

import * as React from 'react'
import { useEffect, useState } from 'react'
import chalk from 'chalk'
import { Box, Text, useInput } from '../../ink.js'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  PROVIDER_DISPLAY_NAMES,
  type APIProvider,
} from '../../utils/model/providers.js'
import {
  deleteAllProviderCredentials,
  deleteProviderKey,
  hasStoredKey,
  loadProviderKey,
  saveProviderKey,
} from '../../services/api/auth/api_key_manager.js'
import TextInput from '../../components/TextInput.js'

// ─── Config ──────────────────────────────────────────────────────

/**
 * Providers the user can connect via /provider.
 *
 * Excluded on purpose:
 *   - firstParty (Anthropic)  → handled by /login
 *   - bedrock/vertex/foundry  → env/IAM-based, no credentials to manage here
 *
 * Ollama is a special case: no OAuth, no API key — the "credential" is
 * whether the local daemon is reachable at the configured base URL, and
 * the only configurable bit is that base URL.
 *
 * CLIProxyAPI/Antigravity/Codex are implicit engines behind Gemini &
 * OpenAI OAuth — not listed as separate rows.
 */
// `groq` is intentionally hidden — the free / on-demand TPM budget is
// too tight for claudex's tool suite. Restoring it = add `'groq'` back
// here + in SELECTABLE_PROVIDERS + flip GROQ_ENABLED in
// src/lanes/openai-compat/index.ts. No code was removed; the transformer,
// auth flow, and env detection (CLAUDE_CODE_USE_GROQ) stay wired.
const MANAGEABLE_PROVIDERS = [
  'openai',
  'gemini',
  'antigravity',
  'openrouter',
  'nim',
  'deepseek',
  'ollama',
  // Phase 4 (v0.4.0) — 3 full-chat + 3 login-only stubs.
  'kilocode',
  'cline',
  'iflow',
  'copilot',
  'kiro',
  'cursor',
] as const satisfies readonly APIProvider[]

type ManageableProvider = (typeof MANAGEABLE_PROVIDERS)[number]

/** Storage key for the user-supplied Ollama base URL (persisted in provider-keys.json). */
const OLLAMA_BASE_URL_KEY = 'ollama_base_url'
const OLLAMA_DEFAULT_BASE = 'http://localhost:11434'

type KeyedProvider = Exclude<ManageableProvider, 'ollama'>

// ─── Auth state helpers ──────────────────────────────────────────

type AuthState = 'oauth' | 'api_key' | 'inactive'

function getAuthState(provider: KeyedProvider): AuthState {
  // Gemini row = CLI-tier OAuth (free flash/lite) or AI Studio API key.
  if (provider === 'gemini') {
    if (hasStoredKey('gemini_oauth_cli') || hasStoredKey('gemini_oauth')) return 'oauth'
    if (hasStoredKey('gemini')) return 'api_key'
    return 'inactive'
  }
  // Antigravity row = its own Google-login OAuth pool.
  if (provider === 'antigravity') {
    if (hasStoredKey('gemini_oauth_antigravity')) return 'oauth'
    return 'inactive'
  }
  if (hasStoredKey(`${provider}_oauth`)) return 'oauth'
  if (hasStoredKey(provider)) return 'api_key'
  return 'inactive'
}

/** Detailed Gemini auth state — shows CLI-tier OAuth + AI Studio API key. */
function getGeminiDetailedState(): { cliOAuth: boolean; apiKey: boolean } {
  return {
    cliOAuth: hasStoredKey('gemini_oauth_cli') || hasStoredKey('gemini_oauth'),
    apiKey: hasStoredKey('gemini'),
  }
}

function formatBadge(state: AuthState): string {
  switch (state) {
    case 'oauth':
      return chalk.green('[OAuth ✅]')
    case 'api_key':
      return chalk.green('[API Key ✅]')
    case 'inactive':
      return chalk.dim('[   –   ]')
  }
}

function formatGeminiBadge(): string {
  const { cliOAuth, apiKey } = getGeminiDetailedState()
  const parts: string[] = []
  if (cliOAuth) parts.push('CLI')
  if (apiKey) parts.push('Key')
  if (parts.length === 0) return chalk.dim('[   –   ]')
  return chalk.green(`[${parts.join(' + ')} ✅]`)
}

// ─── Ollama reachability ──────────────────────────────────────────
//
// Ollama has no credentials — we treat the "state" as whether the
// daemon actually answers. The reachability probe is async so the
// list view holds it in React state and the badge reflects the last
// result.

type OllamaStatus = 'unknown' | 'running' | 'offline'

function getOllamaBaseUrl(): string {
  // Order of precedence matches ollamaCatalog.ts:
  //   OLLAMA_HOST → OLLAMA_BASE_URL → stored override → default.
  // We normalise to a bare origin (no /v1 suffix) because /api/tags
  // lives under the root, not under the OpenAI-compat path.
  const envHost = process.env.OLLAMA_HOST ?? process.env.OLLAMA_BASE_URL
  const stored = loadProviderKey(OLLAMA_BASE_URL_KEY)
  const raw = envHost ?? stored ?? OLLAMA_DEFAULT_BASE
  const withScheme = /^https?:/i.test(raw) ? raw : `http://${raw}`
  return withScheme.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

async function probeOllama(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal })
    return res.ok
  } catch {
    return false
  }
}

function formatOllamaBadge(status: OllamaStatus): string {
  switch (status) {
    case 'running':
      return chalk.green('[🟢 Running]')
    case 'offline':
      return chalk.red('[🔴 Offline]')
    case 'unknown':
      return chalk.dim('[   ?    ]')
  }
}

// ─── View state machine ─────────────────────────────────────────

type View =
  | { kind: 'list'; selectedIndex: number }
  | { kind: 'configure'; provider: ManageableProvider; selectedIndex: number }
  | {
      kind: 'ollama_url_input'
      error?: string
    }
  | {
      kind: 'result'
      provider: ManageableProvider
      message: string
      tone: 'success' | 'error'
    }

type ConfigureOption =
  | { kind: 'deactivate' }
  | { kind: 'set_ollama_url' }
  | { kind: 'reset_ollama_url' }
  | { kind: 'test_ollama' }
  | { kind: 'back' }

function buildConfigureOptions(
  provider: ManageableProvider,
  ollamaStatus: OllamaStatus,
): ConfigureOption[] {
  // Ollama has its own option set.
  if (provider === 'ollama') {
    const options: ConfigureOption[] = []
    options.push({ kind: 'test_ollama' })
    options.push({ kind: 'set_ollama_url' })
    if (hasStoredKey(OLLAMA_BASE_URL_KEY)) {
      options.push({ kind: 'reset_ollama_url' })
    }
    options.push({ kind: 'back' })
    void ollamaStatus
    return options
  }

  const options: ConfigureOption[] = []

  // Gemini: check CLI-tier OAuth + API key (Antigravity has its own row).
  if (provider === 'gemini') {
    const gemini = getGeminiDetailedState()
    if (gemini.cliOAuth || gemini.apiKey) {
      options.push({ kind: 'deactivate' })
    }
  } else {
    const state = getAuthState(provider)
    if (state !== 'inactive') {
      options.push({ kind: 'deactivate' })
    }
  }

  options.push({ kind: 'back' })
  return options
}

function labelConfigureOption(
  option: ConfigureOption,
  _provider: ManageableProvider,
): string {
  switch (option.kind) {
    case 'deactivate':
      return 'Deactivate (clear all credentials)'
    case 'set_ollama_url':
      return 'Set custom base URL'
    case 'reset_ollama_url':
      return 'Reset base URL to default (http://localhost:11434)'
    case 'test_ollama':
      return 'Test connection'
    case 'back':
      return '← Back to provider list'
  }
}

// ─── Component ──────────────────────────────────────────────────

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

function ProviderManager({ onDone }: { onDone: OnDone }) {
  const [view, setView] = useState<View>({ kind: 'list', selectedIndex: 0 })
  // Refresh tick forces re-read of auth state after saves/deletes.
  const [refreshTick, setRefreshTick] = useState(0)
  const refresh = () => setRefreshTick(t => t + 1)

  const [ollamaUrlInput, setOllamaUrlInput] = useState('')
  const [ollamaUrlCursorOffset, setOllamaUrlCursorOffset] = useState(0)
  const inputColumns = Math.max(20, (process.stdout.columns ?? 80) - 14)

  // Live reachability status for Ollama, computed when we first render
  // the list or configure view and refreshed when the user asks for it.
  // The badge starts at "unknown" and flips after the probe resolves.
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>('unknown')

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    setOllamaStatus('unknown')
    probeOllama(getOllamaBaseUrl(), controller.signal).then(ok => {
      if (cancelled) return
      setOllamaStatus(ok ? 'running' : 'offline')
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [refreshTick])

  // ─── Handlers ─────────────────────────────────────────────────

  function enterConfigure(provider: ManageableProvider) {
    setView({ kind: 'configure', provider, selectedIndex: 0 })
  }

  function backToList() {
    // Preserve the list selection on the provider the user just configured.
    const lastProvider =
      view.kind === 'configure' || view.kind === 'result'
        ? view.provider
        : undefined
    const idx = lastProvider ? MANAGEABLE_PROVIDERS.indexOf(lastProvider) : 0
    setView({ kind: 'list', selectedIndex: idx >= 0 ? idx : 0 })
  }

  function handleDeactivate(provider: KeyedProvider) {
    deleteAllProviderCredentials(provider)
    if (provider === 'gemini') {
      // Gemini row = CLI-tier only; Antigravity has its own row.
      deleteProviderKey('gemini_oauth_cli')
      deleteProviderKey('gemini_oauth')
    }
    if (provider === 'antigravity') {
      deleteProviderKey('gemini_oauth_antigravity')
    }
    refresh()
    setView({
      kind: 'result',
      provider,
      tone: 'success',
      message: `${PROVIDER_DISPLAY_NAMES[provider]} disconnected.`,
    })
  }

  // ─── Ollama handlers ──────────────────────────────────────────

  function handleTestOllama() {
    // Refreshing forces the reachability effect to re-run.
    setOllamaStatus('unknown')
    refresh()
  }

  function handleOllamaUrlSubmit(value: string) {
    const raw = value.trim()
    if (!raw) return

    // Accept either a full URL or a host:port shorthand, matching
    // ollamaCatalog.ts's ollamaBase().
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
    try {
      const parsed = new URL(withScheme)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('bad protocol')
      }
    } catch {
      setView({
        kind: 'ollama_url_input',
        error: 'Not a valid URL. Try "http://localhost:11434" or "my-box:11434".',
      })
      return
    }

    const normalised = withScheme.replace(/\/+$/, '').replace(/\/v1$/i, '')
    saveProviderKey(OLLAMA_BASE_URL_KEY, normalised)
    process.env.OLLAMA_BASE_URL = normalised

    setOllamaUrlInput('')
    setOllamaUrlCursorOffset(0)
    setOllamaStatus('unknown')
    refresh()
    setView({
      kind: 'result',
      provider: 'ollama',
      tone: 'success',
      message: `Ollama base URL set to ${normalised}. Testing connection…`,
    })
  }

  function handleResetOllamaUrl() {
    deleteProviderKey(OLLAMA_BASE_URL_KEY)
    // Clear the env override too, so we fall back to the default.
    delete process.env.OLLAMA_BASE_URL
    delete process.env.OLLAMA_HOST
    setOllamaStatus('unknown')
    refresh()
    setView({
      kind: 'result',
      provider: 'ollama',
      tone: 'success',
      message: `Ollama base URL reset to ${OLLAMA_DEFAULT_BASE}.`,
    })
  }

  // ─── Input routing ────────────────────────────────────────────

  useInput((input: string, key: {
    upArrow?: boolean
    downArrow?: boolean
    return?: boolean
    escape?: boolean
  }) => {
    // Global: Esc cancels the whole flow from any non-input view.
    // TextInput-backed views handle their own Esc (ollama_url_input).
    if (key.escape && view.kind !== 'ollama_url_input') {
      if (view.kind === 'list') {
        onDone('Provider setup closed.', { display: 'system' })
        return
      }
      backToList()
      return
    }

    // ollama_url_input: Esc goes back to the ollama configure screen.
    if (view.kind === 'ollama_url_input' && key.escape) {
      setOllamaUrlInput('')
      setOllamaUrlCursorOffset(0)
      setView({ kind: 'configure', provider: 'ollama', selectedIndex: 0 })
      return
    }

    // ─── list view ───
    if (view.kind === 'list') {
      if (key.upArrow) {
        setView({
          kind: 'list',
          selectedIndex:
            view.selectedIndex > 0
              ? view.selectedIndex - 1
              : MANAGEABLE_PROVIDERS.length - 1,
        })
        return
      }
      if (key.downArrow) {
        setView({
          kind: 'list',
          selectedIndex:
            view.selectedIndex < MANAGEABLE_PROVIDERS.length - 1
              ? view.selectedIndex + 1
              : 0,
        })
        return
      }
      if (key.return) {
        const provider = MANAGEABLE_PROVIDERS[view.selectedIndex]
        if (provider) enterConfigure(provider)
        return
      }
      return
    }

    // ─── configure view ───
    if (view.kind === 'configure') {
      const options = buildConfigureOptions(view.provider, ollamaStatus)
      if (key.upArrow) {
        setView({
          ...view,
          selectedIndex:
            view.selectedIndex > 0
              ? view.selectedIndex - 1
              : options.length - 1,
        })
        return
      }
      if (key.downArrow) {
        setView({
          ...view,
          selectedIndex:
            view.selectedIndex < options.length - 1
              ? view.selectedIndex + 1
              : 0,
        })
        return
      }
      if (key.return) {
        const chosen = options[view.selectedIndex]
        if (!chosen) return
        switch (chosen.kind) {
          case 'deactivate':
            if (view.provider !== 'ollama') handleDeactivate(view.provider)
            return
          case 'set_ollama_url':
            setOllamaUrlInput('')
            setOllamaUrlCursorOffset(0)
            setView({ kind: 'ollama_url_input' })
            return
          case 'reset_ollama_url':
            handleResetOllamaUrl()
            return
          case 'test_ollama':
            handleTestOllama()
            return
          case 'back':
            backToList()
            return
        }
      }
      return
    }

    // ─── result view ───
    if (view.kind === 'result') {
      if (key.return) backToList()
      return
    }
  })

  // ─── Render ───────────────────────────────────────────────────

  const header = (
    <Box marginBottom={1}>
      <Text bold color="claude">
        🔌 Providers
      </Text>
    </Box>
  )

  if (view.kind === 'list') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        <Text dimColor>
          Connect the AI accounts you want ClaudeX to use. Multiple providers
          can be active at once.
        </Text>
        <Box marginTop={1} flexDirection="column">
          {MANAGEABLE_PROVIDERS.map((provider, i) => {
            const isSelected = i === view.selectedIndex
            const name = PROVIDER_DISPLAY_NAMES[provider]
            const prefix = isSelected ? '>' : ' '
            const badge =
              provider === 'ollama'
                ? formatOllamaBadge(ollamaStatus)
                : provider === 'gemini'
                  ? formatGeminiBadge()
                  : formatBadge(getAuthState(provider))
            return (
              <Box key={provider}>
                <Text
                  bold={isSelected}
                  color={isSelected ? 'claude' : undefined}
                  dimColor={!isSelected}
                >
                  {prefix} {name.padEnd(16)}
                </Text>
                <Text> {badge}</Text>
              </Box>
            )
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            ↑↓ navigate · Enter to configure · Esc to close
          </Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'configure') {
    const provider = view.provider
    const name = PROVIDER_DISPLAY_NAMES[provider]
    const options = buildConfigureOptions(provider, ollamaStatus)
    const badge =
      provider === 'ollama'
        ? formatOllamaBadge(ollamaStatus)
        : provider === 'gemini'
          ? formatGeminiBadge()
          : formatBadge(getAuthState(provider))
    const currentUrl = provider === 'ollama' ? getOllamaBaseUrl() : null
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        <Box>
          <Text bold>{name}</Text>
          <Text> {badge}</Text>
        </Box>
        {currentUrl && (
          <Text dimColor>Base URL: {currentUrl}</Text>
        )}
        <Box marginTop={1} flexDirection="column">
          {options.map((option, i) => {
            const isSelected = i === view.selectedIndex
            const prefix = isSelected ? '>' : ' '
            const label = labelConfigureOption(option, provider)
            return (
              <Text
                key={option.kind}
                bold={isSelected}
                color={isSelected ? 'claude' : undefined}
                dimColor={!isSelected}
              >
                {prefix} {label}
              </Text>
            )
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            ↑↓ navigate · Enter to select · Esc to go back
          </Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'ollama_url_input') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        <Text bold>Set Ollama base URL</Text>
        <Text dimColor>
          Default: <Text color="suggestion">{OLLAMA_DEFAULT_BASE}</Text>
        </Text>
        <Text dimColor>
          Accepts full URLs (http://host:port) or host:port shorthand.
        </Text>
        {view.error && (
          <Box marginTop={1}>
            <Text color="error">{view.error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text>URL: </Text>
          <TextInput
            value={ollamaUrlInput}
            onChange={setOllamaUrlInput}
            onSubmit={handleOllamaUrlSubmit}
            placeholder="http://localhost:11434"
            focus={true}
            showCursor={true}
            columns={inputColumns}
            cursorOffset={ollamaUrlCursorOffset}
            onChangeCursorOffset={setOllamaUrlCursorOffset}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to submit · Esc to go back</Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'result') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        <Text color={view.tone === 'success' ? 'success' : 'error'}>
          {view.tone === 'success' ? '✓ ' : '✗ '}
          {view.message}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Enter to return to the provider list</Text>
        </Box>
      </Box>
    )
  }

  return null
}

// ─── Entry point ────────────────────────────────────────────────

export const call: LocalJSXCommandCall = async onDone => (
  <ProviderManager onDone={onDone} />
)
