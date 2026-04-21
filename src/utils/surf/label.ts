/**
 * Shared surf label helpers — used by UI surfaces (logo banner, /status
 * pane, /model picker) that normally show the main-loop model name.
 *
 * When surf is on, these surfaces should reflect that the router — not a
 * single fixed model — is in charge. Keeping the formatting in one place
 * means the banner text stays consistent everywhere the user might look.
 */

import {
  getCurrentSurfPhase,
  isSurfEnabled,
  type SurfPhase,
} from './state.js'

/** Display-case phase names, shared with /surf status and the wizard. */
const PHASE_LABEL: Record<SurfPhase, string> = {
  planning: 'Planning',
  building: 'Building',
  reviewing: 'Reviewing',
  thinking: 'Thinking',
  subagent: 'Subagent',
  longContext: 'Long Context',
  background: 'Background',
}

/**
 * Returns the surf banner string ("🌊 surf mode on" or, once a phase has
 * been detected for the current turn, "🌊 surf mode on · {Phase}"). When
 * surf is off this returns null so callers can fall through to their
 * normal model-name rendering — the null branch is the "unchanged
 * behavior" guarantee for surf-off.
 */
export function getSurfBannerLabel(): string | null {
  if (!isSurfEnabled()) return null
  const phase = getCurrentSurfPhase()
  if (!phase) return '🌊 surf mode on'
  return `🌊 surf mode on · ${PHASE_LABEL[phase] ?? phase}`
}
