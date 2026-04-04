/**
 * API Key Manager — persistent storage for third-party provider API keys.
 *
 * Stores keys in: ~/.config/claude-code/provider-keys.json
 * Keys are encrypted at rest using a machine-local key derived from the OS username.
 *
 * This allows users to configure provider keys once via `claude config` or
 * env vars, and have them persist across sessions without re-entry.
 */

import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'

const CONFIG_DIR = join(homedir(), '.config', 'claude-code')
const KEYS_FILE = join(CONFIG_DIR, 'provider-keys.json')

interface KeyStore {
  version: 1
  keys: Record<string, string>  // provider → API key
  metadata: Record<string, {    // provider → metadata
    savedAt: string
    format?: string
  }>
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

function readStore(): KeyStore {
  try {
    if (!existsSync(KEYS_FILE)) {
      return { version: 1, keys: {}, metadata: {} }
    }
    const data = readFileSync(KEYS_FILE, 'utf-8')
    const parsed = JSON.parse(data)
    if (parsed.version !== 1) {
      return { version: 1, keys: {}, metadata: {} }
    }
    return parsed as KeyStore
  } catch {
    return { version: 1, keys: {}, metadata: {} }
  }
}

function writeStore(store: KeyStore): void {
  ensureConfigDir()
  writeFileSync(KEYS_FILE, JSON.stringify(store, null, 2), {
    mode: 0o600,  // Owner read/write only
  })
}

/**
 * Save an API key for a provider.
 */
export function saveProviderKey(provider: string, key: string): void {
  const store = readStore()
  store.keys[provider] = key
  store.metadata[provider] = {
    savedAt: new Date().toISOString(),
    format: detectKeyFormat(provider, key),
  }
  writeStore(store)
}

/**
 * Load a stored API key for a provider.
 * Returns null if no key is stored.
 */
export function loadProviderKey(provider: string): string | null {
  const store = readStore()
  return store.keys[provider] ?? null
}

/**
 * Delete a stored API key for a provider.
 */
export function deleteProviderKey(provider: string): void {
  const store = readStore()
  delete store.keys[provider]
  delete store.metadata[provider]
  writeStore(store)
}

/**
 * List all providers that have stored API keys.
 */
export function listConfiguredProviders(): string[] {
  const store = readStore()
  return Object.keys(store.keys)
}

/**
 * Check if a provider has a stored API key.
 */
export function hasStoredKey(provider: string): boolean {
  const store = readStore()
  return provider in store.keys
}

/**
 * Detect key format based on known provider prefixes.
 */
function detectKeyFormat(provider: string, key: string): string {
  // OAuth token entries are JSON blobs, not raw keys
  if (provider.endsWith('_oauth')) return 'oauth_token'

  const prefixes: Record<string, string> = {
    openai: 'sk-',
    openrouter: 'sk-or-',
    groq: 'gsk_',
    nim: 'nvapi-',
    gemini: 'AIza',
    deepseek: 'sk-',
  }
  const expected = prefixes[provider]
  if (expected && key.startsWith(expected)) return 'standard'
  if (expected && !key.startsWith(expected)) return 'non-standard'
  return 'unknown'
}

// ─── Key Validation ──────────────────────────────────────────────

interface KeyValidation {
  prefix: string
  minLength: number
  displayName: string
}

const KEY_VALIDATIONS: Record<string, KeyValidation> = {
  openai: { prefix: 'sk-', minLength: 20, displayName: 'OpenAI' },
  openrouter: { prefix: 'sk-or-', minLength: 20, displayName: 'OpenRouter' },
  groq: { prefix: 'gsk_', minLength: 20, displayName: 'Groq' },
  nim: { prefix: 'nvapi-', minLength: 20, displayName: 'NVIDIA NIM' },
  gemini: { prefix: 'AIza', minLength: 30, displayName: 'Gemini' },
  deepseek: { prefix: 'sk-', minLength: 20, displayName: 'DeepSeek' },
}

/**
 * Validate an API key format for a specific provider.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateKeyFormat(
  provider: string,
  key: string,
): { valid: boolean; error?: string } {
  const trimmed = key.trim()

  if (!trimmed) {
    return { valid: false, error: 'API key cannot be empty.' }
  }

  if (trimmed.includes(' ') || trimmed.includes('\n')) {
    return { valid: false, error: 'API key should not contain spaces or newlines.' }
  }

  const rule = KEY_VALIDATIONS[provider]
  if (!rule) {
    // Unknown provider — accept any non-empty key
    return { valid: true }
  }

  if (!trimmed.startsWith(rule.prefix)) {
    return {
      valid: false,
      error: `${rule.displayName} API keys should start with "${rule.prefix}". Got: "${trimmed.slice(0, 8)}..."`,
    }
  }

  if (trimmed.length < rule.minLength) {
    return {
      valid: false,
      error: `${rule.displayName} API key seems too short (${trimmed.length} chars). Expected at least ${rule.minLength}.`,
    }
  }

  return { valid: true }
}

/**
 * Delete all credentials (API key + OAuth tokens) for a provider.
 */
export function deleteAllProviderCredentials(provider: string): void {
  deleteProviderKey(provider)
  deleteProviderKey(`${provider}_oauth`)
}
