import { getInitialSettings } from '../settings/settings.js'

/**
 * Resolve the default shell for input-box `!` commands and the agent
 * shell tool on Windows.
 *
 * Resolution order:
 *   1. Explicit settings.defaultShell → honor it (user knows best).
 *   2. Everywhere else → 'bash'.
 *
 * Missing bash is handled by the first-run bash setup flow. We do not
 * silently flip Bash commands to PowerShell because the syntax and tool
 * semantics are different.
 */
export function resolveDefaultShell(): 'bash' | 'powershell' {
  const explicit = getInitialSettings().defaultShell
  if (explicit) return explicit

  return 'bash'
}
