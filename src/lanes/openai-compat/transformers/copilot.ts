/**
 * GitHub Copilot transformer.
 *
 * Copilot exposes an OpenAI-compatible chat completions endpoint at
 * https://api.githubcopilot.com/chat/completions. The wire format is
 * canonical OpenAI Chat Completions; the quirks are auth (the bearer is
 * the Copilot internal token, NOT the GitHub OAuth access token — see
 * oauth_services.ts::completeCopilotOAuth) and a handful of editor-shaped
 * headers the gateway uses to gate requests.
 *
 * Reference: reference/9router-master/open-sse/executors/github.js.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

// Headers below mirror the reference executor exactly. The chat gateway
// gates non-VSCode UAs hard, so don't tweak these unless GitHub bumps
// the editor-version expected on api.githubcopilot.com.
const COPILOT_INTEGRATION_ID = 'vscode-chat'
const COPILOT_VSCODE_VERSION = '1.110.0'
const COPILOT_CHAT_VERSION = '0.38.0'
const COPILOT_USER_AGENT = `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`
const COPILOT_API_VERSION = '2025-04-01'

function _requestId(): string {
  // crypto.randomUUID exists on Node 16+; fall back for older runtimes.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function _requiresMaxCompletionTokens(model: string): boolean {
  // gpt-5*, o1*, o3*, o4* reject `max_tokens`; they want max_completion_tokens.
  return /gpt-5|o[134]-/i.test(model)
}

function _supportsTemperature(model: string): boolean {
  // gpt-5.4 (and any future variant matching the pattern) rejects temperature.
  return !/gpt-5\.4/i.test(model)
}

export const copilotTransformer: Transformer = {
  id: 'copilot',
  displayName: 'GitHub Copilot',
  defaultBaseUrl: 'https://api.githubcopilot.com',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  buildHeaders(_apiKey: string): Record<string, string> {
    return {
      'copilot-integration-id': COPILOT_INTEGRATION_ID,
      'editor-version': `vscode/${COPILOT_VSCODE_VERSION}`,
      'editor-plugin-version': `copilot-chat/${COPILOT_CHAT_VERSION}`,
      'user-agent': COPILOT_USER_AGENT,
      'openai-intent': 'conversation-panel',
      'x-github-api-version': COPILOT_API_VERSION,
      'x-vscode-user-agent-library-version': 'electron-fetch',
      'X-Initiator': 'user',
      'x-request-id': _requestId(),
    }
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    if (_requiresMaxCompletionTokens(ctx.model) && body.max_tokens !== undefined) {
      const v = body.max_tokens
      delete body.max_tokens
      ;(body as unknown as Record<string, unknown>).max_completion_tokens = v
    }
    if (!_supportsTemperature(ctx.model) && body.temperature !== undefined) {
      delete body.temperature
    }
    // Chat-completions endpoint rejects thinking/reasoning_effort. The
    // /responses route handles those, but we don't ship a /responses path
    // in v0.4.1 — the few Codex-class models that need it can be added later.
    delete body.thinking
    delete body.reasoning_effort
    delete body.reasoning
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'too long']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    const m = model.toLowerCase()
    if (m.includes('claude-')) return 'apply_patch'
    if (m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3')) return 'apply_patch'
    if (m.includes('gemini-3') || m.includes('gemini-2.5')) return 'apply_patch'
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return 'gpt-4o-mini'
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    const m = model.toLowerCase()
    if (m.includes('claude-')) return 'last-only'
    return 'none'
  },

  // Curated catalog mirrors reference/9router-master/open-sse/config/providerModels.js
  // (the `gh` block). Mix of OpenAI / Anthropic / Google / xAI / vendor-internal IDs.
  staticCatalog() {
    return [
      // OpenAI
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
      { id: 'gpt-4', name: 'GPT-4' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
      { id: 'gpt-5.1', name: 'GPT-5.1' },
      { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
      { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
      { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
      { id: 'gpt-5.2', name: 'GPT-5.2' },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      // Anthropic
      { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
      { id: 'claude-opus-4.1', name: 'Claude Opus 4.1' },
      { id: 'claude-opus-4.5', name: 'Claude Opus 4.5' },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
      { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
      // Google
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash' },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro' },
      // Other
      { id: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
      { id: 'oswe-vscode-prime', name: 'Raptor Mini' },
    ]
  },
}
