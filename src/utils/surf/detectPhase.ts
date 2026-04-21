/**
 * Surf phase detection — pure function.
 *
 * Classifies the current turn as one of the main-loop phases so /surf can
 * route to the right model. First-match-wins; runs every turn at the top
 * of the query loop. Returns a `MainLoopSurfPhase` — `subagent` is routed
 * separately at AgentTool spawn time, never by this function.
 *
 * Detection priority:
 *   1. permissionMode === 'plan'         → planning (hard override, bypasses debounce)
 *   2. transcriptTokens > threshold      → longContext
 *   3. thinking keywords / trigger       → thinking
 *   4. review keywords                   → reviewing
 *   5. recent tool calls are Edit/Write  → building
 *   6. trivial one-shot, no tools        → background
 *   7. default                           → planning (safest fallback)
 */

import type { MainLoopSurfPhase } from './state.js'

export interface PhaseDetectionContext {
  /** Current permission mode from AppState — 'plan' hard-routes to planning. */
  permissionMode?: string
  /** Tool names from the last ~5 tool calls in the transcript, newest first. */
  recentToolNames?: readonly string[]
  /** The most recent user message text (raw). */
  lastUserMessage?: string
  /** Total message count in the conversation so far. */
  messageCount?: number
  /** Rough token count of the whole transcript (estimateTranscriptTokens).
   * Used to trigger the longContext phase when the conversation has grown
   * beyond what the default model handles efficiently. */
  transcriptTokens?: number
}

const REVIEW_KEYWORD_RE =
  /\b(review|audit|check|verify|is this|looks? right|correct|safe|inspect|lgtm|approve)\b/i

const THINKING_KEYWORD_RE =
  /\b(ultrathink|think hard|think deeply|think step[- ]by[- ]step|deep analysis|root cause|reason through|extended thinking|think carefully)\b/i

const BUILD_TOOL_SET = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
  'Replace',
])

/** Flip to longContext once the transcript crosses this rough token count.
 * Matches claude-router-main's default (60k) — comfortable headroom before
 * typical 200k-ctx models start losing recall. */
export const LONG_CONTEXT_TOKEN_THRESHOLD = 60_000

/**
 * Classify a turn into a main-loop surf phase based on the current context.
 * Runs every turn — keep this cheap (no async, no I/O).
 */
export function detectPhase(ctx: PhaseDetectionContext): MainLoopSurfPhase {
  const {
    permissionMode,
    recentToolNames = [],
    lastUserMessage = '',
    messageCount = 0,
    transcriptTokens = 0,
  } = ctx

  // 1. Plan mode is an explicit user signal — trust it unconditionally.
  //    Callers that honor the debounce should treat this as a hard override
  //    and skip the dwell check (see applyPhase.ts).
  if (permissionMode === 'plan') return 'planning'

  // 2. Long context — swap to a long-context-capable model once the
  //    transcript has grown. Ordered above thinking/review so even a
  //    reasoning-heavy question still routes to the long-context model
  //    when the conversation is already huge.
  if (transcriptTokens > LONG_CONTEXT_TOKEN_THRESHOLD) {
    return 'longContext'
  }

  // 3. Explicit deep-reasoning trigger. "think hard"/"ultrathink"/etc are
  //    specific asks for extended thinking, not generic planning.
  if (lastUserMessage && THINKING_KEYWORD_RE.test(lastUserMessage)) {
    return 'thinking'
  }

  // 4. Review keywords in the user message.
  if (lastUserMessage && REVIEW_KEYWORD_RE.test(lastUserMessage)) {
    return 'reviewing'
  }

  // 5. Recent tool activity is edit-heavy.
  const buildToolCount = recentToolNames.filter(name =>
    BUILD_TOOL_SET.has(name),
  ).length
  if (buildToolCount >= 2) return 'building'

  // 6. Trivial one-shot questions — short message, new conversation, no tools.
  if (
    messageCount <= 2 &&
    lastUserMessage.length > 0 &&
    lastUserMessage.length <= 200 &&
    recentToolNames.length === 0
  ) {
    return 'background'
  }

  // 7. Default — keep the strongest model engaged.
  return 'planning'
}

/**
 * Phases the caller should skip the 2-turn debounce for. Plan mode is an
 * explicit user action, not a fuzzy signal — waiting a turn to honor it
 * would feel broken. Every other phase requires two consecutive detections
 * before we actually switch providers.
 */
export function isHardOverridePhase(
  ctx: PhaseDetectionContext,
  detected: MainLoopSurfPhase,
): boolean {
  return ctx.permissionMode === 'plan' && detected === 'planning'
}
