import { createHash } from 'crypto'
import type {
  ProviderContentBlock,
  ProviderMessage,
} from './base_provider.js'

const CURSOR_TOOL_CALL_METADATA_MARKER = '\nmc_'
const MAX_PROVIDER_TOOL_CALL_ID_LENGTH = 64
const SAFE_PROVIDER_TOOL_CALL_ID = /^[A-Za-z0-9._:-]{1,64}$/

export function sanitizeProviderMessagesForNonCursorTransport(
  messages: ProviderMessage[],
): ProviderMessage[] {
  const rewrittenIds = new Map<string, string>()
  let changed = false

  const sanitizeId = (rawId: string): string => {
    const cached = rewrittenIds.get(rawId)
    if (cached) return cached
    const next = makeProviderSafeToolCallId(rawId)
    rewrittenIds.set(rawId, next)
    return next
  }

  const nextMessages = messages.map(message => {
    if (typeof message.content === 'string') return message

    let messageChanged = false
    const nextBlocks = (message.content as ProviderContentBlock[]).map(block => {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const nextId = sanitizeId(block.id)
        if (nextId !== block.id) {
          changed = true
          messageChanged = true
          return { ...block, id: nextId }
        }
        return block
      }

      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const nextId = sanitizeId(block.tool_use_id)
        if (nextId !== block.tool_use_id) {
          changed = true
          messageChanged = true
          return { ...block, tool_use_id: nextId }
        }
        return block
      }

      return block
    })

    return messageChanged ? { ...message, content: nextBlocks } : message
  })

  return changed ? nextMessages : messages
}

function makeProviderSafeToolCallId(rawId: string): string {
  const normalized = stripCursorMetadata(rawId)
  if (SAFE_PROVIDER_TOOL_CALL_ID.test(normalized)) {
    return normalized
  }

  const cleaned = normalized
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._:-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (SAFE_PROVIDER_TOOL_CALL_ID.test(cleaned)) {
    return cleaned
  }

  const prefix = cleaned.startsWith('call_')
    ? 'call_'
    : cleaned.startsWith('toolu_') || rawId.startsWith('toolu_')
      ? 'toolu_'
      : 'toolu_'
  const stem = cleaned.replace(/^(toolu_|call_)/, '')
  const hash = createHash('sha256').update(rawId).digest('hex').slice(0, 16)
  const maxStemLength = Math.max(
    0,
    MAX_PROVIDER_TOOL_CALL_ID_LENGTH - prefix.length - hash.length - 1,
  )
  const truncatedStem = stem.slice(0, maxStemLength)
  return truncatedStem
    ? `${prefix}${truncatedStem}_${hash}`
    : `${prefix}${hash}`
}

function stripCursorMetadata(id: string): string {
  const idx = id.indexOf(CURSOR_TOOL_CALL_METADATA_MARKER)
  return idx >= 0 ? id.slice(0, idx) : id
}
