import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getPlatform } from '../platform.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

/**
 * Runtime gate for PowerShellTool. Windows-only (the permission engine uses
 * Win32-specific path normalizations).
 *
 * Resolution:
 *   - Non-Windows → off (PowerShellTool permission engine is Win32-only).
 *   - Explicit opt-in via CLAUDE_CODE_USE_POWERSHELL_TOOL=1 → on.
 *   - Ant users → on by default (opt-out via env=0).
 *   - External users → off by default. Missing bash is handled by the
 *     first-run Git Bash setup flow, not by switching command syntax.
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
  return false
}
