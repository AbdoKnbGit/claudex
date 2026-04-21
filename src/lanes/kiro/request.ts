/**
 * Build a CodeWhisperer `GenerateAssistantResponse` payload from
 * Anthropic-IR messages + tools.
 *
 * Wire format reference: reference/9router-master/open-sse/translator/
 *   request/openai-to-kiro.js. The shape:
 *
 *   conversationState:
 *     chatTriggerType: "MANUAL"
 *     conversationId:  uuid
 *     currentMessage:
 *       userInputMessage:
 *         content, modelId, origin: "AI_EDITOR"
 *         userInputMessageContext?: { tools?, toolResults? }
 *     history: [ { userInputMessage } | { assistantResponseMessage } ]
 *   profileArn?
 *   inferenceConfig?: { maxTokens, temperature, topP }
 *
 * History rules (the Kiro API rejects traffic that violates these):
 *   - Alternating user/assistant roles only.
 *   - Merge consecutive same-role messages.
 *   - Empty content is illegal — fall back to "continue" (user) / "..." (assistant).
 *   - `tools` only live inside `currentMessage.userInputMessageContext`.
 *   - Every historical `userInputMessage` needs `modelId` set.
 */

import { randomUUID } from 'crypto'
import type {
  ProviderMessage,
  ProviderTool,
  ProviderContentBlock,
} from '../../services/api/providers/base_provider.js'

interface KiroToolSpec {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: Record<string, unknown> }
  }
}

interface KiroToolResult {
  toolUseId: string
  status: 'success'
  content: Array<{ text: string }>
}

interface KiroToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

interface KiroUserMessage {
  userInputMessage: {
    content: string
    modelId: string
    origin?: string
    userInputMessageContext?: {
      tools?: KiroToolSpec[]
      toolResults?: KiroToolResult[]
    }
  }
}

interface KiroAssistantMessage {
  assistantResponseMessage: {
    content: string
    toolUses?: KiroToolUse[]
  }
}

type KiroHistoryEntry = KiroUserMessage | KiroAssistantMessage

export interface KiroPayload {
  conversationState: {
    chatTriggerType: 'MANUAL'
    conversationId: string
    currentMessage: KiroUserMessage
    history: KiroHistoryEntry[]
  }
  profileArn?: string
  inferenceConfig?: {
    maxTokens?: number
    temperature?: number
    topP?: number
  }
}

export interface BuildKiroPayloadParams {
  model: string
  system: string
  messages: ProviderMessage[]
  tools: ProviderTool[]
  maxTokens?: number
  temperature?: number
  topP?: number
  profileArn?: string
}

export function buildKiroPayload(params: BuildKiroPayloadParams): KiroPayload {
  const { model, system, messages, tools, maxTokens, temperature, topP, profileArn } = params

  const specs = _buildToolSpecs(tools)
  const { history, currentMessage } = _convertMessages(messages, system, specs, model)

  // CodeWhisperer prepends the current wall-clock — 9router does the
  // same so models that rely on "current time" skills (scheduling,
  // file timestamps) see fresh context each turn.
  const stampedContent = `[Context: Current time is ${new Date().toISOString()}]\n\n${
    currentMessage.userInputMessage.content
  }`

  const payload: KiroPayload = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: randomUUID(),
      currentMessage: {
        userInputMessage: {
          content: stampedContent,
          modelId: model,
          origin: 'AI_EDITOR',
          ...(currentMessage.userInputMessage.userInputMessageContext && {
            userInputMessageContext: currentMessage.userInputMessage.userInputMessageContext,
          }),
        },
      },
      history,
    },
  }

  if (profileArn) payload.profileArn = profileArn
  if (maxTokens != null || temperature !== undefined || topP !== undefined) {
    payload.inferenceConfig = {}
    if (maxTokens != null) payload.inferenceConfig.maxTokens = maxTokens
    if (temperature !== undefined) payload.inferenceConfig.temperature = temperature
    if (topP !== undefined) payload.inferenceConfig.topP = topP
  }
  return payload
}

// ─── Tool specs ──────────────────────────────────────────────────

function _buildToolSpecs(tools: ProviderTool[]): KiroToolSpec[] {
  return tools.map(t => {
    const schema = (t.input_schema ?? {}) as Record<string, unknown>
    const normalized = Object.keys(schema).length === 0
      ? { type: 'object', properties: {}, required: [] }
      : { ...schema, required: (schema.required as unknown[]) ?? [] }
    return {
      toolSpecification: {
        name: t.name,
        description: (t.description && t.description.trim()) || `Tool: ${t.name}`,
        inputSchema: { json: normalized as Record<string, unknown> },
      },
    }
  })
}

// ─── Message conversion ──────────────────────────────────────────

function _convertMessages(
  messages: ProviderMessage[],
  systemText: string,
  tools: KiroToolSpec[],
  model: string,
): { history: KiroHistoryEntry[]; currentMessage: KiroUserMessage } {
  const history: KiroHistoryEntry[] = []

  let currentRole: 'user' | 'assistant' | null = null
  let pendingUserText: string[] = []
  let pendingAssistantText: string[] = []
  let pendingToolResults: KiroToolResult[] = []

  const flush = (): void => {
    if (currentRole === 'user') {
      const content = pendingUserText.join('\n\n').trim() || 'continue'
      const msg: KiroUserMessage = {
        userInputMessage: { content, modelId: model },
      }
      if (pendingToolResults.length > 0) {
        msg.userInputMessage.userInputMessageContext = {
          toolResults: pendingToolResults,
        }
      }
      history.push(msg)
      pendingUserText = []
      pendingToolResults = []
    } else if (currentRole === 'assistant') {
      const content = pendingAssistantText.join('\n\n').trim() || '...'
      history.push({ assistantResponseMessage: { content } })
      pendingAssistantText = []
    }
  }

  // Kiro has no system role — 9router prepends the system prompt onto
  // the first user turn. Mirror that so CLAUDE.md / environment / git
  // status still reach the model. Sent once; subsequent user turns carry
  // only their own content.
  let systemInjected = !systemText

  for (const msg of messages) {
    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user'

    if (currentRole !== null && role !== currentRole) flush()
    currentRole = role

    if (role === 'user') {
      const { text, toolResults } = _extractUserBlocks(msg.content)
      let content = text
      if (!systemInjected) {
        content = content ? `${systemText}\n\n${content}` : systemText
        systemInjected = true
      }
      if (content) pendingUserText.push(content)
      pendingToolResults.push(...toolResults)
    } else {
      const { text, toolUses } = _extractAssistantBlocks(msg.content)
      if (text) pendingAssistantText.push(text)
      if (toolUses.length > 0) {
        flush()
        const last = history[history.length - 1]
        if (last && 'assistantResponseMessage' in last) {
          last.assistantResponseMessage.toolUses = toolUses
        } else {
          // Tool call with no preceding text — Kiro still wants an
          // assistant envelope to attach the toolUses to.
          history.push({ assistantResponseMessage: { content: '...', toolUses } })
        }
        currentRole = null
      }
    }
  }

  if (currentRole !== null) flush()

  // The Kiro envelope separates `currentMessage` (the prompt we're
  // sending this turn) from `history` (the preceding turns). Pop the
  // LAST user message off history and promote it. If the trailing turn
  // is an assistant tool-call (common: model just returned a tool call
  // and we are about to send tool_result back), inject a placeholder
  // "continue" user message so there's always a currentMessage.
  let currentMessage: KiroUserMessage | undefined
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if ('userInputMessage' in entry) {
      currentMessage = entry
      history.splice(i, 1)
      break
    }
  }
  if (!currentMessage) {
    currentMessage = {
      userInputMessage: { content: 'continue', modelId: model },
    }
  }

  // Clean up stale tool scaffolding from historical user messages —
  // only the currentMessage carries the active `tools` array.
  for (const entry of history) {
    if ('userInputMessage' in entry) {
      const ctx = entry.userInputMessage.userInputMessageContext
      if (ctx) {
        delete (ctx as { tools?: unknown }).tools
        if (Object.keys(ctx).length === 0) {
          delete entry.userInputMessage.userInputMessageContext
        }
      }
      if (!entry.userInputMessage.modelId) entry.userInputMessage.modelId = model
    }
  }

  // Merge consecutive user messages (Kiro requires alternating roles).
  const merged: KiroHistoryEntry[] = []
  for (const entry of history) {
    const last = merged[merged.length - 1]
    if (
      last
      && 'userInputMessage' in entry
      && 'userInputMessage' in last
    ) {
      last.userInputMessage.content += `\n\n${entry.userInputMessage.content}`
    } else {
      merged.push(entry)
    }
  }

  // Attach tools to the outgoing prompt (only ever on currentMessage).
  if (tools.length > 0) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {}
    }
    currentMessage.userInputMessage.userInputMessageContext.tools = tools
  }

  return { history: merged, currentMessage }
}

function _extractUserBlocks(content: string | ProviderContentBlock[]): {
  text: string
  toolResults: KiroToolResult[]
} {
  if (typeof content === 'string') return { text: content, toolResults: [] }

  const texts: string[] = []
  const toolResults: KiroToolResult[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    } else if (block.type === 'tool_result' && block.tool_use_id) {
      toolResults.push({
        toolUseId: block.tool_use_id,
        status: 'success',
        content: [{ text: _stringifyToolResultContent(block.content) }],
      })
    }
    // Images: Kiro supports base64 via a separate `images` field on
    // userInputMessage, but the claudex tool stack never emits image
    // blocks in provider messages (screenshots go through the Read
    // tool), so we intentionally skip them.
  }
  return { text: texts.join('\n'), toolResults }
}

function _extractAssistantBlocks(content: string | ProviderContentBlock[]): {
  text: string
  toolUses: KiroToolUse[]
} {
  if (typeof content === 'string') return { text: content, toolUses: [] }

  const texts: string[] = []
  const toolUses: KiroToolUse[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    } else if (block.type === 'tool_use' && block.id && block.name) {
      toolUses.push({
        toolUseId: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      })
    }
    // thinking blocks: Kiro has no reasoning channel we can round-trip —
    // the model emits reasoningContentEvent but won't accept it back.
    // Dropping on re-submission keeps the history legal.
  }
  return { text: texts.join('\n').trim(), toolUses }
}

function _stringifyToolResultContent(
  content: string | ProviderContentBlock[] | undefined,
): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (typeof block === 'object' && block) {
      parts.push(JSON.stringify(block))
    }
  }
  return parts.join('\n')
}
