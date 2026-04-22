import type { APIProvider } from './providers.js'

/**
 * Anthropic tool-search uses Anthropic-specific defer_loading/tool_reference
 * request shapes. Native third-party lanes, including Cursor, must receive
 * full tool schemas directly so tools remain callable.
 */
export function providerSupportsAnthropicToolSearch(
  provider: APIProvider,
): boolean {
  return (
    provider === 'firstParty' ||
    provider === 'bedrock' ||
    provider === 'vertex' ||
    provider === 'foundry'
  )
}
