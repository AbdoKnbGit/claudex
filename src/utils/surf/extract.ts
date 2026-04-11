/**
 * Message-array helpers for surf phase detection.
 *
 * `detectPhase` wants a tiny slice of conversation state (last user text,
 * recent tool names, total count). These helpers walk the transcript
 * without allocating a new copy — cheap enough to run on every turn.
 *
 * Kept in their own module so `detectPhase` stays a pure function with
 * no knowledge of the Message shape, and the walking logic has a single
 * home if the transcript schema changes.
 */

import type { Message } from '../../types/message.js'

/**
 * Extract the last user-authored text block from a messages slice.
 * Walks newest-first and returns the first string it finds, or '' if
 * none. Handles both string-content and block-array-content shapes.
 */
export function extractLastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.type !== 'user') continue
    const content = (m as { message?: { content?: unknown } }).message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text'
        ) {
          const text = (block as { text?: unknown }).text
          if (typeof text === 'string') return text
        }
      }
    }
    // Found a user message but couldn't pull text — don't keep walking;
    // the phase detector treats empty as "no signal" and falls through.
    return ''
  }
  return ''
}

/**
 * Extract the names of the most recent tool_use blocks across the
 * transcript, newest first. `limit` caps how many we return — the
 * detector only looks at ~5 anyway, and walking the whole history
 * is wasted work.
 */
export function extractRecentToolNames(
  messages: readonly Message[],
  limit = 5,
): string[] {
  const names: string[] = []
  for (let i = messages.length - 1; i >= 0 && names.length < limit; i--) {
    const m = messages[i]
    if (!m || m.type !== 'assistant') continue
    const content = (m as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    // Walk this assistant message newest-first too, so the surface-most
    // tool_use is at index 0 of the result.
    for (let j = content.length - 1; j >= 0 && names.length < limit; j--) {
      const block = content[j]
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'tool_use'
      ) {
        const name = (block as { name?: unknown }).name
        if (typeof name === 'string') names.push(name)
      }
    }
  }
  return names
}
