/**
 * Bidirectional tool name mapping between Claudex (Anthropic-format)
 * tool names and Kiro's native tool names.
 *
 * Kiro models are post-trained on their native tool names (shell, read,
 * write, grep, glob, web_search, web_fetch, etc.). Claudex uses
 * Anthropic-format names (Bash, Read, Write, Grep, Glob, WebSearch,
 * WebFetch, etc.). This module maps between the two so:
 *
 *   1. Tools sent to the CodeWhisperer API use Kiro-native names.
 *   2. Tool calls returned by Kiro are mapped back to Claudex names
 *      before passing to context.executeTool().
 *
 * NOTE: Only 1:1 mappings are listed here. Tools that would create
 * duplicates (e.g. PowerShell → shell when Bash → shell already exists)
 * are excluded — the dedup logic in _buildToolSpecs handles those.
 * Edit is kept as-is because Kiro has no equivalent (Kiro's "write"
 * covers both create and edit, but Claudex separates them).
 */

/** Claudex tool name → Kiro native tool name */
const CLAUDEX_TO_KIRO: Record<string, string> = {
  // Shell — Bash on Unix, PowerShell on Windows; only one is active
  Bash:        'shell',
  PowerShell:  'shell',
  // File operations
  Read:        'read',
  Write:       'write',
  // Edit has NO direct Kiro equivalent — keep as 'Edit'
  // Search
  Grep:        'grep',
  Glob:        'glob',
  // Web
  WebSearch:   'web_search',
  WebFetch:    'web_fetch',
  // Productivity
  TodoWrite:   'todo_list',
  // Agents
  Agent:       'subagent',
}

const SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell'])

/** Kiro native tool name → Claudex tool name (reverse map) */
const KIRO_TO_CLAUDEX: Record<string, string> = {}
for (const [claudex, kiro] of Object.entries(CLAUDEX_TO_KIRO)) {
  // First Claudex name wins (Bash beats PowerShell for 'shell')
  if (!(kiro in KIRO_TO_CLAUDEX)) {
    KIRO_TO_CLAUDEX[kiro] = claudex
  }
}

/**
 * Map a Claudex tool name to the Kiro-native name the model was trained
 * on. Returns the original name if no mapping exists (e.g. MCP tools,
 * Edit which has no Kiro equivalent).
 */
export function toKiroToolName(claudexName: string): string {
  return CLAUDEX_TO_KIRO[claudexName] ?? claudexName
}

/**
 * Choose which local shell tool should back Kiro's single native `shell`
 * capability for this session.
 *
 * On Windows, prefer PowerShell when available so native Kiro shell calls
 * can execute cmdlets like `Get-ChildItem` instead of being forced through
 * the Bash executor. Elsewhere, Bash remains the natural default.
 */
export function resolvePreferredKiroShellToolName(
  toolNames: readonly string[],
): 'Bash' | 'PowerShell' | null {
  const hasBash = toolNames.includes('Bash')
  const hasPowerShell = toolNames.includes('PowerShell')

  if (process.platform === 'win32') {
    if (hasPowerShell) return 'PowerShell'
    if (hasBash) return 'Bash'
  } else {
    if (hasBash) return 'Bash'
    if (hasPowerShell) return 'PowerShell'
  }

  return null
}

export function isKiroShellCandidate(claudexName: string): boolean {
  return SHELL_TOOL_NAMES.has(claudexName)
}

/**
 * Map a Kiro-native tool name back to the Claudex tool name for
 * execution. Returns the original name if no mapping exists.
 */
export function toClaudexToolName(
  kiroName: string,
  preferredShellToolName?: string | null,
): string {
  if (kiroName === 'shell' && preferredShellToolName) {
    return preferredShellToolName
  }
  return KIRO_TO_CLAUDEX[kiroName] ?? kiroName
}
