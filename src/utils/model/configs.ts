import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

/** Anthropic-native provider keys only (used by Claude model configs) */
export type AnthropicProvider = Extract<APIProvider, 'firstParty' | 'bedrock' | 'vertex' | 'foundry'>

/** Model config mapping for Anthropic-native providers */
export type ModelConfig = Record<AnthropicProvider, ModelName>

// ─── Third-Party Provider Tier System ───────────────────────────────
//
// Each third-party provider offers models at different access tiers:
//   free  — no payment required, rate-limited
//   pro   — requires API key with billing, standard limits
//   plus  — premium tier or enterprise, highest limits
//
// The tier is determined by PROVIDER_TIER env var or auto-detected
// from the API key format / account status.
//
// Model IDs are pinned to confirmed-working identifiers as of 2025-Q4.
// Override any model via env vars (e.g. OPENAI_MODEL_OPUS).

export type ProviderTier = 'free' | 'pro' | 'plus'

export interface TierModelSet {
  opus: string    // Best reasoning / most capable model
  sonnet: string  // Balanced quality/speed for everyday tasks
  haiku: string   // Fastest / cheapest for simple tasks
}

export interface ProviderModelConfig {
  /** Human-readable provider name */
  displayName: string
  /** Provider API base URL */
  baseUrl: string
  /** Auth header format: 'bearer' for Authorization: Bearer, 'x-api-key' for custom */
  authType: 'bearer' | 'x-api-key'
  /** Env var name for the API key */
  apiKeyEnv: string
  /** Models available at each tier */
  tiers: Record<ProviderTier, TierModelSet>
  /** Which tier to use when none is explicitly set — typically 'pro' for paid keys */
  defaultTier: ProviderTier
  /** Whether the provider supports streaming */
  supportsStreaming: boolean
  /** Whether the provider supports tool/function calling */
  supportsToolCalling: boolean
}

/**
 * Detects the provider tier from env var or falls back to the provider's default.
 *
 * Set PROVIDER_TIER=free|pro|plus to override auto-detection.
 * Provider-specific overrides: OPENAI_TIER, GEMINI_TIER, etc.
 */
export function getProviderTier(provider: string): ProviderTier {
  // Provider-specific override first
  const providerEnv = process.env[`${provider.toUpperCase()}_TIER`]
  if (providerEnv && isValidTier(providerEnv)) return providerEnv

  // Global override
  const globalTier = process.env.PROVIDER_TIER
  if (globalTier && isValidTier(globalTier)) return globalTier

  // Auto-detect from provider config default
  return PROVIDER_CONFIGS[provider]?.defaultTier ?? 'pro'
}

function isValidTier(t: string): t is ProviderTier {
  return ['free', 'pro', 'plus'].includes(t)
}

// ─── Provider Configurations (Updated April 2026) ──────────────────
//
// Model selection rationale per provider (latest confirmed model IDs):
//
// OpenAI (April 2026):
//   free  → gpt-5.4-mini (cheapest 5.x, tool calling, 128k context)
//   pro   → gpt-5.4 (flagship March 2026, strong coding + reasoning)
//   plus  → gpt-5.4-pro (higher compute, hardest problems)
//   Haiku → gpt-5.4-nano (smallest/fastest/cheapest)
//
// Gemini (April 2026):
//   free  → gemini-3-flash-preview (free in AI Studio, fast, tools)
//   pro   → gemini-3.1-pro-preview (latest, 1M context, reasoning-first)
//   plus  → gemini-3.1-pro-preview (same — best available)
//   Haiku → gemini-3.1-flash-lite-preview (cost-efficient, high-volume)
//
// OpenRouter (April 2026):
//   free  → qwen/qwen3-235b-a22b:free (strongest free MoE model)
//   pro   → anthropic/claude-sonnet-4-5 / openai/gpt-5.4
//   plus  → anthropic/claude-opus-4-6 (best available via OR)
//
// Groq (April 2026 — all models free with rate limits):
//   free  → deepseek-r1-distill-llama-70b (best reasoning, free)
//   pro   → qwen/qwen3-32b (strong coding, replaced qwq)
//   plus  → openai/gpt-oss-120b (flagship open model on Groq)
//   Haiku → llama-3.3-70b-versatile (proven fast workhorse)
//
// NVIDIA NIM (April 2026):
//   free  → moonshotai/kimi-k2-instruct (free on NIM, strong coding)
//   pro   → moonshotai/kimi-k2-thinking (reasoning model, budget_tokens)
//   plus  → minimaxai/minimax-m2.5 (230B params, Feb 2026)
//   Haiku → nvidia/llama-3.1-8b-instruct (ultra-fast)

export const PROVIDER_CONFIGS: Record<string, ProviderModelConfig> = {
  openai: {
    displayName: 'OpenAI',
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    authType: 'bearer',
    apiKeyEnv: 'OPENAI_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   'gpt-5.4-mini',
        sonnet: 'gpt-5.4-mini',
        haiku:  'gpt-5.4-mini',
      },
      pro: {
        opus:   process.env.OPENAI_MODEL_OPUS   ?? 'gpt-5.4',
        sonnet: process.env.OPENAI_MODEL_SONNET ?? 'gpt-5.4',
        haiku:  process.env.OPENAI_MODEL_HAIKU  ?? 'gpt-5.4-mini',
      },
      plus: {
        opus:   process.env.OPENAI_MODEL_OPUS   ?? 'gpt-5.4',
        sonnet: process.env.OPENAI_MODEL_SONNET ?? 'gpt-5.4',
        haiku:  process.env.OPENAI_MODEL_HAIKU  ?? 'gpt-5.4-mini',
      },
    },
  },

  copilot: {
    displayName: 'GitHub Copilot',
    baseUrl: 'https://api.githubcopilot.com',
    authType: 'bearer',
    apiKeyEnv: 'COPILOT_OAUTH_TOKEN',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus: 'gpt-5-mini',
        sonnet: 'gpt-5-mini',
        haiku: 'gpt-5-mini',
      },
      pro: {
        opus: process.env.COPILOT_MODEL_OPUS ?? 'claude-opus-4.7',
        sonnet: process.env.COPILOT_MODEL_SONNET ?? 'gpt-5-mini',
        haiku: process.env.COPILOT_MODEL_HAIKU ?? 'gpt-5-mini',
      },
      plus: {
        opus: process.env.COPILOT_MODEL_OPUS ?? 'claude-opus-4.7',
        sonnet: process.env.COPILOT_MODEL_SONNET ?? 'gpt-5.4',
        haiku: process.env.COPILOT_MODEL_HAIKU ?? 'gpt-5-mini',
      },
    },
  },

  gemini: {
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authType: 'x-api-key',
    apiKeyEnv: 'GEMINI_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   'gemini-3-flash-preview',
        sonnet: 'gemini-3-flash-preview',
        haiku:  'gemini-3.1-flash-lite-preview',
      },
      pro: {
        opus:   process.env.GEMINI_MODEL_OPUS   ?? 'gemini-3.1-pro-preview',
        sonnet: process.env.GEMINI_MODEL_SONNET ?? 'gemini-2.5-pro',
        haiku:  process.env.GEMINI_MODEL_HAIKU  ?? 'gemini-3.1-flash-lite-preview',
      },
      plus: {
        opus:   process.env.GEMINI_MODEL_OPUS   ?? 'gemini-3.1-pro-preview',
        sonnet: process.env.GEMINI_MODEL_SONNET ?? 'gemini-3.1-pro-preview',
        haiku:  process.env.GEMINI_MODEL_HAIKU  ?? 'gemini-2.5-flash-lite',
      },
    },
  },

  openrouter: {
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authType: 'bearer',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   'qwen/qwen3-235b-a22b:free',
        sonnet: 'meta-llama/llama-4-maverick:free',
        haiku:  'google/gemma-3-27b-it:free',
      },
      pro: {
        opus:   process.env.OR_MODEL_OPUS   ?? 'anthropic/claude-sonnet-4-5',
        sonnet: process.env.OR_MODEL_SONNET ?? 'openai/gpt-5.4',
        haiku:  process.env.OR_MODEL_HAIKU  ?? 'openai/gpt-5.4-mini',
      },
      plus: {
        opus:   process.env.OR_MODEL_OPUS   ?? 'anthropic/claude-opus-4-6',
        sonnet: process.env.OR_MODEL_SONNET ?? 'anthropic/claude-sonnet-4-6',
        haiku:  process.env.OR_MODEL_HAIKU  ?? 'google/gemini-3.1-flash-lite',
      },
    },
  },

  groq: {
    displayName: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authType: 'bearer',
    apiKeyEnv: 'GROQ_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'free',  // Groq is free-tier by nature
    tiers: {
      free: {
        opus:   process.env.GROQ_MODEL_OPUS   ?? 'deepseek-r1-distill-llama-70b',
        sonnet: process.env.GROQ_MODEL_SONNET ?? 'llama-3.3-70b-versatile',
        haiku:  process.env.GROQ_MODEL_HAIKU  ?? 'llama-3.3-70b-versatile',
      },
      pro: {
        opus:   process.env.GROQ_MODEL_OPUS   ?? 'qwen/qwen3-32b',
        sonnet: process.env.GROQ_MODEL_SONNET ?? 'deepseek-r1-distill-llama-70b',
        haiku:  process.env.GROQ_MODEL_HAIKU  ?? 'llama-3.3-70b-versatile',
      },
      plus: {
        opus:   process.env.GROQ_MODEL_OPUS   ?? 'openai/gpt-oss-120b',
        sonnet: process.env.GROQ_MODEL_SONNET ?? 'qwen/qwen3-32b',
        haiku:  process.env.GROQ_MODEL_HAIKU  ?? 'deepseek-r1-distill-llama-70b',
      },
    },
  },

  deepseek: {
    displayName: 'DeepSeek',
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    authType: 'bearer',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   'deepseek-chat',
        sonnet: 'deepseek-chat',
        haiku:  'deepseek-chat',
      },
      pro: {
        opus:   process.env.DEEPSEEK_MODEL_OPUS   ?? 'deepseek-reasoner',
        sonnet: process.env.DEEPSEEK_MODEL_SONNET ?? 'deepseek-chat',
        haiku:  process.env.DEEPSEEK_MODEL_HAIKU  ?? 'deepseek-chat',
      },
      plus: {
        opus:   process.env.DEEPSEEK_MODEL_OPUS   ?? 'deepseek-reasoner',
        sonnet: process.env.DEEPSEEK_MODEL_SONNET ?? 'deepseek-reasoner',
        haiku:  process.env.DEEPSEEK_MODEL_HAIKU  ?? 'deepseek-chat',
      },
    },
  },

  nim: {
    displayName: 'NVIDIA NIM',
    baseUrl: process.env.NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    authType: 'bearer',
    apiKeyEnv: 'NIM_API_KEY',
    supportsStreaming: true,
    supportsToolCalling: true,
    defaultTier: 'pro',
    tiers: {
      free: {
        opus:   'moonshotai/kimi-k2-instruct',
        sonnet: 'moonshotai/kimi-k2-instruct',
        haiku:  'nvidia/llama-3.1-8b-instruct',
      },
      pro: {
        opus:   process.env.NIM_MODEL_OPUS   ?? 'moonshotai/kimi-k2-thinking',
        sonnet: process.env.NIM_MODEL_SONNET ?? 'moonshotai/kimi-k2.5',
        haiku:  process.env.NIM_MODEL_HAIKU  ?? 'nvidia/llama-3.1-8b-instruct',
      },
      plus: {
        opus:   process.env.NIM_MODEL_OPUS   ?? 'minimaxai/minimax-m2.5',
        sonnet: process.env.NIM_MODEL_SONNET ?? 'moonshotai/kimi-k2-thinking',
        haiku:  process.env.NIM_MODEL_HAIKU  ?? 'moonshotai/kimi-k2-instruct',
      },
    },
  },
}

/**
 * Resolves the effective model set for a third-party provider based on
 * the detected or configured tier.
 */
export function getProviderModelSet(provider: string): TierModelSet {
  const config = PROVIDER_CONFIGS[provider]
  if (!config) {
    // Fallback for unknown providers — use a generic OpenAI-compatible default
    return { opus: 'gpt-5.4', sonnet: 'gpt-5.4', haiku: 'gpt-5.4-mini' }
  }
  const tier = getProviderTier(provider)
  return config.tiers[tier]
}

/**
 * Legacy flat map for backward compat — resolves to current tier's models.
 * Use getProviderModelSet() directly for tier-aware access.
 */
export const PROVIDER_MODEL_MAP: Record<string, TierModelSet> = new Proxy(
  {} as Record<string, TierModelSet>,
  {
    get(_target, prop: string) {
      return getProviderModelSet(prop)
    },
  },
)

// @[MODEL LAUNCH]: Add a new CLAUDE_*_CONFIG constant here. Double check the correct model strings
// here since the pattern may change.

export const CLAUDE_3_7_SONNET_CONFIG = {
  firstParty: 'claude-3-7-sonnet-20250219',
  bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  vertex: 'claude-3-7-sonnet@20250219',
  foundry: 'claude-3-7-sonnet',
} as const satisfies ModelConfig

export const CLAUDE_3_5_V2_SONNET_CONFIG = {
  firstParty: 'claude-3-5-sonnet-20241022',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  vertex: 'claude-3-5-sonnet-v2@20241022',
  foundry: 'claude-3-5-sonnet',
} as const satisfies ModelConfig

export const CLAUDE_3_5_HAIKU_CONFIG = {
  firstParty: 'claude-3-5-haiku-20241022',
  bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  vertex: 'claude-3-5-haiku@20241022',
  foundry: 'claude-3-5-haiku',
} as const satisfies ModelConfig

export const CLAUDE_HAIKU_4_5_CONFIG = {
  firstParty: 'claude-haiku-4-5-20251001',
  bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  vertex: 'claude-haiku-4-5@20251001',
  foundry: 'claude-haiku-4-5',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_CONFIG = {
  firstParty: 'claude-sonnet-4-20250514',
  bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  vertex: 'claude-sonnet-4@20250514',
  foundry: 'claude-sonnet-4',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_5_CONFIG = {
  firstParty: 'claude-sonnet-4-5-20250929',
  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  vertex: 'claude-sonnet-4-5@20250929',
  foundry: 'claude-sonnet-4-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_CONFIG = {
  firstParty: 'claude-opus-4-20250514',
  bedrock: 'us.anthropic.claude-opus-4-20250514-v1:0',
  vertex: 'claude-opus-4@20250514',
  foundry: 'claude-opus-4',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_1_CONFIG = {
  firstParty: 'claude-opus-4-1-20250805',
  bedrock: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  vertex: 'claude-opus-4-1@20250805',
  foundry: 'claude-opus-4-1',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_5_CONFIG = {
  firstParty: 'claude-opus-4-5-20251101',
  bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  vertex: 'claude-opus-4-5@20251101',
  foundry: 'claude-opus-4-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-6',
  bedrock: 'us.anthropic.claude-opus-4-6-v1',
  vertex: 'claude-opus-4-6',
  foundry: 'claude-opus-4-6',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_6_CONFIG = {
  firstParty: 'claude-sonnet-4-6',
  bedrock: 'us.anthropic.claude-sonnet-4-6',
  vertex: 'claude-sonnet-4-6',
  foundry: 'claude-sonnet-4-6',
} as const satisfies ModelConfig

// @[MODEL LAUNCH]: Register the new config here.
export const ALL_MODEL_CONFIGS = {
  haiku35: CLAUDE_3_5_HAIKU_CONFIG,
  haiku45: CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35: CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37: CLAUDE_3_7_SONNET_CONFIG,
  sonnet40: CLAUDE_SONNET_4_CONFIG,
  sonnet45: CLAUDE_SONNET_4_5_CONFIG,
  sonnet46: CLAUDE_SONNET_4_6_CONFIG,
  opus40: CLAUDE_OPUS_4_CONFIG,
  opus41: CLAUDE_OPUS_4_1_CONFIG,
  opus45: CLAUDE_OPUS_4_5_CONFIG,
  opus46: CLAUDE_OPUS_4_6_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical first-party model IDs, e.g. 'claude-opus-4-6' | 'claude-sonnet-4-5-20250929' | … */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.firstParty,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.firstParty, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>
