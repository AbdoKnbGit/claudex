/**
 * Session-level cache for Gemini thought_signature values.
 *
 * Gemini thinking models include a `thought_signature` on functionCall parts
 * in their responses. This signature must be included when the functionCall
 * appears in subsequent request conversation history — the API rejects
 * requests where it is missing.
 *
 * The conversation state pipeline (normalizeMessagesForAPI) can strip custom
 * fields from content blocks, so we also cache signatures here keyed by
 * tool_use_id to guarantee they survive the round-trip.
 */

const _signatures = new Map<string, string>()

/** Store a thought_signature for a tool_use ID. */
export function storeThoughtSignature(toolUseId: string, signature: string): void {
  _signatures.set(toolUseId, signature)
}

/** Retrieve a stored thought_signature by tool_use ID. */
export function getThoughtSignature(toolUseId: string): string | undefined {
  return _signatures.get(toolUseId)
}
