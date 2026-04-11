/**
 * Surf phase detection — pure function.
 *
 * Classifies the current turn as one of four phases so /surf can route
 * to the right model. Rules are first-match-wins and run every turn at
 * the top of the query loop.
 *
 * Detection signals:
 *   1. permissionMode === 'plan'              → planning (hard override)
 *   2. last user message mentions review/audit → reviewing
 *   3. recent tool calls are Edit/Write heavy → building
 *   4. trivial one-shot question, no tools    → background
 *   5. default                                 → planning (safest)
 */

import type { SurfPhase } from './state.js'

export interface PhaseDetectionContext {
  /** Current permission mode from AppState — 'plan' hard-routes to planning. */
  permissionMode?: string
  /** Tool names from the last ~5 tool calls in the transcript, newest first. */
  recentToolNames?: readonly string[]
  /** The most recent user message text (raw). */
  lastUserMessage?: string
  /** Total message count in the conversation so far. */
  messageCount?: number
}

const REVIEW_KEYWORD_RE =
  /\b(review|audit|check|verify|is this|looks? right|correct|safe|inspect|lgtm|approve)\b/i

const BUILD_TOOL_SET = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
  'Replace',
])

/**
 * Classify a turn into a surf phase based on the current context.
 * Runs every turn — keep this cheap (no async, no I/O).
 */
export function detectPhase(ctx: PhaseDetectionContext): SurfPhase {
  const {
    permissionMode,
    recentToolNames = [],
    lastUserMessage = '',
    messageCount = 0,
  } = ctx

  // 1. Plan mode is an explicit user signal — trust it unconditionally.
  if (permissionMode === 'plan') return 'planning'

  // 2. Review keywords in the user message.
  if (lastUserMessage && REVIEW_KEYWORD_RE.test(lastUserMessage)) {
    return 'reviewing'
  }

  // 3. Recent tool activity is edit-heavy.
  const buildToolCount = recentToolNames.filter(name =>
    BUILD_TOOL_SET.has(name),
  ).length
  if (buildToolCount >= 2) return 'building'

  // 4. Trivial one-shot questions — short message, new conversation, no tools.
  if (
    messageCount <= 2 &&
    lastUserMessage.length > 0 &&
    lastUserMessage.length <= 200 &&
    recentToolNames.length === 0
  ) {
    return 'background'
  }

  // 5. Default — keep the strongest model engaged.
  return 'planning'
}
