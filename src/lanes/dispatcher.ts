/**
 * Lane Dispatcher
 *
 * Auto-routes models to their native lane. Zero user configuration needed.
 * User picks a provider via /provider, picks a model via /models, and the
 * dispatcher automatically routes to the correct native lane.
 *
 * Routing:
 *   Claude models    → Anthropic lane (existing claude.ts, no dispatch)
 *   Gemini models    → Gemini lane (native gemini-cli patterns)
 *   OpenAI/GPT/Codex → Codex lane (native Responses API + apply_patch)
 *   Everything else  → OpenAI-compat lane (Chat Completions)
 *
 * The dispatcher is an in-process function — no proxy, no port, no daemon.
 * No env vars, no config files. It just works.
 */

import type {
  Lane,
  LaneRunContext,
  LaneRunResult,
} from './types.js'
import type { AnthropicStreamEvent } from '../services/api/providers/base_provider.js'

// ─── Lane Registry ───────────────────────────────────────────────

const _lanes = new Map<string, Lane>()

/** Register a lane. Called once per lane at startup. */
export function registerLane(lane: Lane): void {
  _lanes.set(lane.name, lane)
}

/** Get a registered lane by name. */
export function getLane(name: string): Lane | undefined {
  return _lanes.get(name)
}

/** Get all registered lanes. */
export function getAllLanes(): Lane[] {
  const result: Lane[] = []
  _lanes.forEach(lane => result.push(lane))
  return result
}

// ─── Auto-Routing ────────────────────────────────────────────────
//
// No configuration needed. The dispatcher looks at the model name
// and routes to the correct lane automatically. Users never see
// or think about lanes — they just pick a model and it works.

/**
 * Find the native lane for a model. Returns null for Anthropic models
 * (they use the existing claude.ts path, not a dispatched lane).
 */
export function resolveRoute(model: string): RouteDecision {
  // Anthropic models → existing path, no dispatch needed
  if (isAnthropicModel(model)) {
    return { type: 'existing', reason: 'anthropic-native' }
  }

  // Find the lane that handles this model
  const lane = findLaneForModel(model)
  if (!lane) {
    // No lane registered yet — fall through to existing shim path
    return { type: 'existing', reason: 'no-lane-registered' }
  }

  // Lane exists but isn't healthy (API down, auth expired)
  if (!lane.isHealthy()) {
    return { type: 'existing', reason: 'lane-unhealthy', lane: lane.name }
  }

  return { type: 'native', lane }
}

/** Find the lane that supports a given model ID. */
function findLaneForModel(model: string): Lane | undefined {
  let found: Lane | undefined
  _lanes.forEach(lane => {
    if (!found && lane.supportsModel(model)) found = lane
  })
  return found
}

// ─── Model Family Detection ──────────────────────────────────────

function isAnthropicModel(model: string): boolean {
  const m = model.toLowerCase()
  return m.startsWith('claude-') || m.includes('anthropic')
}

// ─── Route Decision ──────────────────────────────────────────────

export type RouteDecision =
  | { type: 'native'; lane: Lane }
  | { type: 'existing'; reason: string; lane?: string }

// ─── Dispatch ────────────────────────────────────────────────────

/**
 * Run a model turn through its native lane.
 *
 * Returns an async generator of Anthropic IR events, or null if the
 * model should use the existing claude.ts + shim path.
 *
 * The caller just does:
 *   const gen = dispatch(model, context)
 *   if (gen) { yield* gen } else { // existing path }
 */
export function dispatch(
  model: string,
  context: LaneRunContext,
): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> | null {
  const route = resolveRoute(model)
  if (route.type !== 'native') return null
  return route.lane.run(context)
}

// ─── Diagnostics ─────────────────────────────────────────────────

/** Get lane status for /status or debugging. */
export function getLaneStatus(): LaneStatusEntry[] {
  const entries: LaneStatusEntry[] = []
  _lanes.forEach(lane => {
    entries.push({ name: lane.name, displayName: lane.displayName, healthy: lane.isHealthy() })
  })
  return entries
}

export interface LaneStatusEntry {
  name: string
  displayName: string
  healthy: boolean
}
