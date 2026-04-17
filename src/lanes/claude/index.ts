/**
 * Claude Lane — symmetry + /lane / /models surface.
 *
 * Claude is the one lane where the "extract native behavior into a
 * dedicated lane module" exercise is genuinely simpler to defer: the
 * existing `src/services/api/claude.ts` already speaks the Anthropic
 * Messages API natively (cache markers, streaming, tool_use IR shape,
 * thinking blocks — all of it) exactly as Claude Code upstream does.
 * Claude Code WAS the native Claude lane; the legacy path IS the
 * native path.
 *
 * This module exists for three specific reasons:
 *
 *   1. **Symmetry** — `/models` and `/lane status` show every
 *      provider lane uniformly. Users see "Claude (native Anthropic
 *      Messages)" alongside "Gemini", "Codex", "Qwen", "OpenAI-compat"
 *      rather than a silent special case.
 *   2. **`smallFastModel` lookup** — session titles / tool-use
 *      summaries / commit-message drafts pick claude-haiku-4-5 when
 *      the main-loop model is Claude, without hard-coding the name
 *      in a dozen places.
 *   3. **Future extraction hook** — if we ever need to override
 *      Claude behavior (multi-org rotation, custom cache markers,
 *      alt-tool-schema variants), the lane is already wired and we
 *      flip `isHealthy()` to `true` + implement `streamAsProvider`.
 *
 * Until that flip, the lane reports `isHealthy() = false` and the
 * dispatcher correctly falls through to the existing claude.ts path
 * via its `isAnthropicModel` early return. Zero behavioral risk.
 */

export { claudeLane, ClaudeLane } from './loop.js'

import { claudeLane } from './loop.js'
import { registerLane } from '../dispatcher.js'

export function initClaudeLane(): void {
  registerLane(claudeLane)
  // Unhealthy on purpose — see the module doc above. Dispatcher's
  // isAnthropicModel special case means no Claude request ever enters
  // this lane; we're registered purely for the /lane / /models UX.
  claudeLane.setHealthy(false)
}
