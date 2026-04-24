import { getPlatform } from '../platform.js'
import { getInitialSettings } from '../settings/settings.js'
import { findGitBashPath } from '../windowsPaths.js'

/**
 * Resolve the default shell for input-box `!` commands and the agent
 * shell tool on Windows.
 *
 * Resolution order:
 *   1. Explicit settings.defaultShell → honor it (user knows best).
 *   2. Windows without git-bash → 'powershell' (only shell available).
 *   3. Everywhere else → 'bash'.
 *
 * This keeps existing bash-on-Windows users unchanged while letting
 * vanilla Windows installs work out of the box on PowerShell.
 */
export function resolveDefaultShell(): 'bash' | 'powershell' {
  const explicit = getInitialSettings().defaultShell
  if (explicit) return explicit

  if (getPlatform() === 'windows' && !findGitBashPath()) {
    return 'powershell'
  }
  return 'bash'
}
