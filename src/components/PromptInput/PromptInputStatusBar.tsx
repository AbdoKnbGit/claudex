import * as React from 'react'
import path from 'path'
import { homedir } from 'os'
import { Box, Text } from 'src/ink.js'
import { getCwd } from '../../utils/cwd.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'

type Props = {
  mcpClients?: MCPServerConnection[]
}

function shortenCwd(cwd: string): string {
  const home = homedir()
  if (home && (cwd === home || cwd.startsWith(home + path.sep))) {
    return '~' + cwd.slice(home.length)
  }
  return cwd
}

/**
 * Studio status row: cwd on the left, MCP indicators and a /status hint
 * on the right. Sits below the existing PromptInputFooter; intentionally
 * subtle so it doesn't compete with the dense footer above.
 */
export function PromptInputStatusBar({ mcpClients }: Props): React.ReactNode {
  const cwd = shortenCwd(getCwd())
  const list = mcpClients ?? []
  const connected = list.filter(c => c.type === 'connected').length
  const failed = list.filter(c => c.type === 'failed' || c.type === 'needs-auth').length
  if (!cwd && connected === 0 && failed === 0) return null
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={2} flexShrink={0}>
      <Text color="textMuted" wrap="truncate">
        {cwd}
      </Text>
      <Box flexDirection="row" gap={2} flexShrink={0}>
        {failed > 0 && <Text color="error">⊙ {failed} MCP issue{failed === 1 ? '' : 's'}</Text>}
        {connected > 0 && <Text color="textMuted">⊙ {connected} MCP</Text>}
        <Text color="textMuted">/status</Text>
      </Box>
    </Box>
  )
}
