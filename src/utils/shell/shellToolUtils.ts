import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getPlatform } from '../platform.js'
import { findGitBashPath } from '../windowsPaths.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

/**
 * Runtime gate for PowerShellTool. Windows-only (the permission engine uses
 * Win32-specific path normalizations).
 *
 * Resolution:
 *   - Non-Windows → off (PowerShellTool permission engine is Win32-only).
 *   - Explicit opt-in via CLAUDE_CODE_USE_POWERSHELL_TOOL=1 → on.
 *   - Ant users → on by default (opt-out via env=0).
 *   - External users without git-bash → on automatically, because bash
 *     tools would otherwise have nothing to run on. This makes vanilla
 *     Windows installs usable without any manual setup.
 *   - External users with git-bash → off by default (preserves today's
 *     behavior — bash users keep bash, no surprise tool additions).
 *
 * Used by tools.ts (tool-list visibility), processBashCommand (! routing),
 * and promptShellExecution (skill frontmatter routing) so the gate is
 * consistent across all paths that invoke PowerShellTool.call().
 */
export function isPowerShellToolEnabled(): boolean {
  if (getPlatform() !== 'windows') return false
  if (process.env.USER_TYPE === 'ant') {
    return !isEnvDefinedFalsy(process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL)
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL)) return true
  // Auto-enable when bash is unavailable — otherwise the agent has no
  // shell tool at all on a fresh Windows install.
  return !findGitBashPath()
}
