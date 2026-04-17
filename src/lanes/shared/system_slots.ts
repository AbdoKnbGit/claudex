/**
 * System-prompt slot boundary — shared cache discipline for every lane.
 *
 * Cache keys (Anthropic `cache_control`, Gemini `cachedContents`, OpenAI
 * `prompt_cache_key`) are byte-identity hashes over the stable section
 * of the system prompt. If env / git status / memory bleed into that
 * section, the hash mutates each turn and the cache never hits after
 * the first request.
 *
 * This module enforces the split at the type level:
 *
 *   - Stable slot   — cross-turn identical content: preamble, core
 *                     mandates, workflow descriptions, tool usage
 *                     guidelines, skills context, MCP intro. Feeds the
 *                     cache key.
 *   - Volatile slot — per-turn content: memory (CLAUDE.md etc.),
 *                     environment block, git status, date. Lives
 *                     AFTER the cache boundary — inline in the first
 *                     user message, or in a trailing system block past
 *                     the last cache_control breakpoint.
 *
 * Lanes MUST use `StableSlot.toString()` for cache-keying fields and
 * `VolatileSlot.toString()` for everywhere else. The type brands are
 * there to make "I passed volatile content to the cache field" a
 * compile-time error, not a production cache-miss.
 */

import type { SystemPromptParts } from '../types.js'

// ─── Branded types ───────────────────────────────────────────────

declare const __stableSlotBrand: unique symbol
declare const __volatileSlotBrand: unique symbol

export type StableSlot = string & { readonly [__stableSlotBrand]: 'stable' }
export type VolatileSlot = string & { readonly [__volatileSlotBrand]: 'volatile' }

// ─── Stable rendering ────────────────────────────────────────────

/**
 * Render the stable portion of a system prompt from SystemPromptParts.
 *
 * ONLY cross-turn-stable sections are eligible:
 *   - customInstructions (from user config / env)
 *   - toolsAddendum (from hooks or skill metadata)
 *   - mcpIntro (list of active MCP servers)
 *   - skillsContext (active skill definitions)
 *
 * Each lane pre-pends its own preamble / core-mandates / workflow /
 * tool-usage / operational-guidelines to this string. Those are also
 * stable (they depend only on model family) and belong in the cache
 * key too — lanes call `stableFrom(laneSpecificPreamble, parts)` to
 * get the composed stable slot.
 */
export function renderStableSlot(parts: SystemPromptParts): StableSlot {
  const sections: string[] = []
  if (parts.customInstructions) {
    sections.push(`## Additional Instructions\n\n${parts.customInstructions}`)
  }
  if (parts.toolsAddendum) {
    sections.push(`## Tool Configuration\n\n${parts.toolsAddendum}`)
  }
  if (parts.mcpIntro) {
    sections.push(`## MCP Tools\n\n${parts.mcpIntro}`)
  }
  if (parts.skillsContext) {
    sections.push(
      `## Available Skills\n\n<available_skills>\n${parts.skillsContext}\n</available_skills>`,
    )
  }
  return sections.join('\n\n') as StableSlot
}

/**
 * Compose a lane-specific stable preamble with the user/project
 * instructions. The first argument is the lane's hand-written static
 * block (preamble + mandates + workflow + tool-usage + guidelines —
 * same every turn). The second is the user-derived stable content.
 */
export function stableFrom(
  lanePreamble: string,
  parts: SystemPromptParts,
): StableSlot {
  const user = renderStableSlot(parts)
  return (user ? `${lanePreamble}\n\n${user}` : lanePreamble) as StableSlot
}

// ─── Volatile rendering ──────────────────────────────────────────

/**
 * Render the volatile portion — content that changes turn-to-turn.
 *
 * Volatile sections:
 *   - memory (CLAUDE.md / GEMINI.md / AGENTS.md / QWEN.md merged)
 *   - environment (cwd, date, os, shell)
 *   - gitStatus (branch, dirty/clean, ahead/behind)
 *
 * Lanes place this AFTER the cache boundary. Concrete placement per
 * lane:
 *   - Gemini → first user message in `contents[]`, never in
 *              `systemInstruction` when `cachedContent` is in use
 *   - Claude → trailing system block after the last `cache_control`
 *              breakpoint (or inlined as a user context message)
 *   - Codex  → leading input item, marked with `cache_control: false`
 *   - Compat → prepended to the first user message text, or a separate
 *              `role: 'system'` message AFTER the cached system block
 */
export function renderVolatileSlot(parts: SystemPromptParts): VolatileSlot {
  const sections: string[] = []
  if (parts.memory) {
    sections.push(`## Context\n\n<loaded_context>\n${parts.memory}\n</loaded_context>`)
  }
  if (parts.environment || parts.gitStatus) {
    const envParts: string[] = []
    if (parts.environment) envParts.push(parts.environment)
    if (parts.gitStatus) envParts.push(`Git status:\n${parts.gitStatus}`)
    sections.push(`## Environment\n\n${envParts.join('\n\n')}`)
  }
  return sections.join('\n\n') as VolatileSlot
}

// ─── Cache key derivation ────────────────────────────────────────

/**
 * Deterministic cache key for a stable slot. Lanes that need a key to
 * pass along (Codex `prompt_cache_key`, Gemini `cachedContents.name`,
 * etc.) call this helper so the key stays identical across turns.
 *
 * Uses SHA-256 via Node crypto. Prefix with `claudex:` so the key
 * namespace is distinguishable from other consumers if the upstream
 * ever cross-indexes.
 */
export function cacheKeyOf(slot: StableSlot | string): string {
  // Lazy require — keeps the module tree-shakable for contexts that
  // only need the branded types.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { createHash } = require('crypto') as typeof import('crypto')
  const h = createHash('sha256').update(slot).digest('hex')
  return `claudex:${h.slice(0, 32)}`
}

// ─── Convenience ─────────────────────────────────────────────────

/**
 * Glue both slots into one string for lanes that need a single system
 * prompt and don't support a separate cache surface (Ollama, xAI, etc).
 * The caller loses cache benefit when using this path — intended only
 * for lanes that can't carry the split natively.
 */
export function flatten(stable: StableSlot, volatile: VolatileSlot): string {
  if (!volatile) return stable
  if (!stable) return volatile
  return `${stable}\n\n${volatile}`
}
