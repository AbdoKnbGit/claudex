/**
 * Cursor ConnectRPC protobuf codec.
 *
 * Port of reference/9router-master/open-sse/utils/cursorProtobuf.js. The
 * Cursor chat endpoint speaks `application/connect+proto` — each HTTP
 * message is a stream of 5-byte-prefixed protobuf payloads:
 *
 *   [flag:u8] [length:u32 BE] [protobuf bytes…]
 *
 * flag & 0x01 → payload is gzipped. Response frames sometimes use deflate
 * (zlib) or raw deflate instead; we try all three on decompress error.
 *
 * The wire schema lives inline as field-number constants — full .proto
 * definitions are in `reference/…/open-sse/executors/cursor.js` above
 * the JS impl. We encode the fields the server actually requires; unknown
 * trailing fields from newer protocol versions are ignored on decode.
 */

import { gunzipSync, gzipSync, inflateSync, inflateRawSync } from 'zlib'

// ─── Wire constants ──────────────────────────────────────────────

const WIRE = { VARINT: 0, FIXED64: 1, LEN: 2, FIXED32: 5 } as const

const ROLE = { USER: 1, ASSISTANT: 2 } as const
const UNIFIED_MODE = { CHAT: 1, AGENT: 2 } as const
const THINKING_LEVEL = { UNSPECIFIED: 0, MEDIUM: 1, HIGH: 2 } as const
const CLIENT_SIDE_TOOL_V2_MCP = 19

/** Field-number map for every message type we touch. */
const F = {
  // StreamUnifiedChatWithToolsRequest
  REQUEST: 1,

  // StreamUnifiedChatRequest
  MESSAGES: 1,
  UNKNOWN_2: 2,
  INSTRUCTION: 3,
  UNKNOWN_4: 4,
  MODEL: 5,
  WEB_TOOL: 8,
  UNKNOWN_13: 13,
  CURSOR_SETTING: 15,
  UNKNOWN_19: 19,
  CONVERSATION_ID: 23,
  METADATA: 26,
  IS_AGENTIC: 27,
  SUPPORTED_TOOLS: 29,
  MESSAGE_IDS: 30,
  MCP_TOOLS: 34,
  LARGE_CONTEXT: 35,
  UNKNOWN_38: 38,
  UNIFIED_MODE: 46,
  UNKNOWN_47: 47,
  SHOULD_DISABLE_TOOLS: 48,
  THINKING_LEVEL: 49,
  UNKNOWN_51: 51,
  UNKNOWN_53: 53,
  UNIFIED_MODE_NAME: 54,

  // ConversationMessage
  MSG_CONTENT: 1,
  MSG_ROLE: 2,
  MSG_ID: 13,
  MSG_TOOL_RESULTS: 18,
  MSG_IS_AGENTIC: 29,
  MSG_SERVER_BUBBLE_ID: 32,
  MSG_UNIFIED_MODE: 47,
  MSG_SUPPORTED_TOOLS: 51,

  // ConversationMessage.ToolResult
  TR_CALL_ID: 1,
  TR_NAME: 2,
  TR_INDEX: 3,
  TR_RAW_ARGS: 5,
  TR_RESULT: 8,
  TR_TOOL_CALL: 11,
  TR_MODEL_CALL_ID: 12,

  // ClientSideToolV2Result
  CV2R_TOOL: 1,
  CV2R_MCP_RESULT: 28,
  CV2R_CALL_ID: 35,
  CV2R_MODEL_CALL_ID: 48,
  CV2R_TOOL_INDEX: 49,

  // MCPResult
  MCPR_SELECTED_TOOL: 1,
  MCPR_RESULT: 2,

  // ClientSideToolV2Call
  CV2C_TOOL: 1,
  CV2C_MCP_PARAMS: 27,
  CV2C_CALL_ID: 3,
  CV2C_NAME: 9,
  CV2C_RAW_ARGS: 10,
  CV2C_TOOL_INDEX: 48,
  CV2C_MODEL_CALL_ID: 49,

  // Model
  MODEL_NAME: 1,
  MODEL_EMPTY: 4,

  // Instruction
  INSTRUCTION_TEXT: 1,

  // CursorSetting
  SETTING_PATH: 1,
  SETTING_UNKNOWN_3: 3,
  SETTING_UNKNOWN_6: 6,
  SETTING_UNKNOWN_8: 8,
  SETTING_UNKNOWN_9: 9,
  SETTING6_FIELD_1: 1,
  SETTING6_FIELD_2: 2,

  // Metadata
  META_PLATFORM: 1,
  META_ARCH: 2,
  META_VERSION: 3,
  META_CWD: 4,
  META_TIMESTAMP: 5,

  // MessageId
  MSGID_ID: 1,
  MSGID_SUMMARY: 2,
  MSGID_ROLE: 3,

  // MCPTool
  MCP_TOOL_NAME: 1,
  MCP_TOOL_DESC: 2,
  MCP_TOOL_PARAMS: 3,
  MCP_TOOL_SERVER: 4,

  // StreamUnifiedChatResponseWithTools
  TOOL_CALL: 1,
  RESPONSE: 2,

  // Response ClientSideToolV2Call (same codec as request-side cv2c)
  TOOL_ID: 3,
  TOOL_NAME: 9,
  TOOL_RAW_ARGS: 10,
  TOOL_IS_LAST: 11,
  TOOL_IS_LAST_ALT: 15,
  TOOL_MCP_PARAMS: 27,

  // MCPParams nested inside ClientSideToolV2Call (response side)
  MCP_TOOLS_LIST: 1,
  MCP_NESTED_NAME: 1,
  MCP_NESTED_PARAMS: 3,

  // StreamUnifiedChatResponse
  RESPONSE_TEXT: 1,
  THINKING: 25,
  THINKING_TEXT: 1,
} as const

// ─── Primitive encoding ──────────────────────────────────────────

const _encoder = new TextEncoder()
const _decoder = new TextDecoder()

export function encodeVarint(value: number): Uint8Array {
  const out: number[] = []
  let v = value
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v & 0x7f)
  return new Uint8Array(out)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

type FieldValue = string | Uint8Array | number

export function encodeField(fieldNum: number, wireType: number, value: FieldValue): Uint8Array {
  const tag = encodeVarint((fieldNum << 3) | wireType)
  if (wireType === WIRE.VARINT) {
    return concat(tag, encodeVarint(value as number))
  }
  if (wireType === WIRE.LEN) {
    const data = typeof value === 'string'
      ? _encoder.encode(value)
      : value as Uint8Array
    return concat(tag, encodeVarint(data.length), data)
  }
  return new Uint8Array(0)
}

// ─── Tool name parsing ───────────────────────────────────────────

/**
 * Cursor's MCP-compat protocol wraps plain tool names with a
 * "mcp_<server>_<tool>" prefix. Claudex tool names (Bash, Read, Write…)
 * become "mcp_custom_Bash" on the wire. Anthropic-IR round-trips them
 * unprefixed so the rest of the stack isn't aware of the wrap.
 */
function formatToolName(name: string): string {
  const base = name || 'tool'
  if (base.startsWith('mcp__')) {
    const rest = base.slice(5)
    const idx = rest.indexOf('__')
    if (idx >= 0) {
      const server = rest.slice(0, idx) || 'custom'
      const tool = rest.slice(idx + 2) || 'tool'
      return `mcp_${server}_${tool}`
    }
    return `mcp_custom_${rest || 'tool'}`
  }
  if (base.startsWith('mcp_')) return base
  return `mcp_custom_${base}`
}

function unformatToolName(formatted: string): string {
  if (formatted.startsWith('mcp_custom_')) return formatted.slice('mcp_custom_'.length)
  if (formatted.startsWith('mcp_')) {
    const tail = formatted.slice(4)
    const idx = tail.indexOf('_')
    return idx >= 0 ? tail.slice(idx + 1) : tail
  }
  return formatted
}

function parseToolName(formatted: string): { serverName: string; selectedTool: string } {
  if (!formatted.startsWith('mcp_')) {
    return { serverName: 'custom', selectedTool: formatted || 'tool' }
  }
  const tail = formatted.slice(4)
  const idx = tail.indexOf('_')
  if (idx < 0) return { serverName: 'custom', selectedTool: tail || 'tool' }
  return {
    serverName: tail.slice(0, idx) || 'custom',
    selectedTool: tail.slice(idx + 1) || 'tool',
  }
}

/** Cursor concatenates a "\nmc_<modelCallId>" suffix onto tool ids. */
function parseToolId(id: string): { toolCallId: string; modelCallId: string | null } {
  const idx = id.indexOf('\nmc_')
  if (idx >= 0) return { toolCallId: id.slice(0, idx), modelCallId: id.slice(idx + 4) }
  return { toolCallId: id, modelCallId: null }
}

// ─── Composite encoders ──────────────────────────────────────────

function encMcpResult(selectedTool: string, resultContent: string): Uint8Array {
  return concat(
    encodeField(F.MCPR_SELECTED_TOOL, WIRE.LEN, selectedTool),
    encodeField(F.MCPR_RESULT, WIRE.LEN, resultContent),
  )
}

function encCv2Result(args: {
  toolCallId: string
  modelCallId: string | null
  selectedTool: string
  resultContent: string
  toolIndex: number
}): Uint8Array {
  const { toolCallId, modelCallId, selectedTool, resultContent, toolIndex } = args
  const idx = toolIndex > 0 ? toolIndex : 1
  return concat(
    encodeField(F.CV2R_TOOL, WIRE.VARINT, CLIENT_SIDE_TOOL_V2_MCP),
    encodeField(F.CV2R_MCP_RESULT, WIRE.LEN, encMcpResult(selectedTool, resultContent)),
    encodeField(F.CV2R_CALL_ID, WIRE.LEN, toolCallId),
    ...(modelCallId ? [encodeField(F.CV2R_MODEL_CALL_ID, WIRE.LEN, modelCallId)] : []),
    encodeField(F.CV2R_TOOL_INDEX, WIRE.VARINT, idx),
  )
}

function encMcpParamsForCall(toolName: string, rawArgs: string, serverName: string): Uint8Array {
  const tool = concat(
    encodeField(F.MCP_TOOL_NAME, WIRE.LEN, toolName),
    encodeField(F.MCP_TOOL_PARAMS, WIRE.LEN, rawArgs),
    encodeField(F.MCP_TOOL_SERVER, WIRE.LEN, serverName),
  )
  return encodeField(F.MCP_TOOLS_LIST, WIRE.LEN, tool)
}

function encCv2Call(args: {
  toolCallId: string
  toolName: string
  selectedTool: string
  serverName: string
  rawArgs: string
  modelCallId: string | null
  toolIndex: number
}): Uint8Array {
  const idx = args.toolIndex > 0 ? args.toolIndex : 1
  return concat(
    encodeField(F.CV2C_TOOL, WIRE.VARINT, CLIENT_SIDE_TOOL_V2_MCP),
    encodeField(F.CV2C_MCP_PARAMS, WIRE.LEN, encMcpParamsForCall(args.selectedTool, args.rawArgs, args.serverName)),
    encodeField(F.CV2C_CALL_ID, WIRE.LEN, args.toolCallId),
    encodeField(F.CV2C_NAME, WIRE.LEN, args.toolName),
    encodeField(F.CV2C_RAW_ARGS, WIRE.LEN, args.rawArgs),
    encodeField(F.CV2C_TOOL_INDEX, WIRE.VARINT, idx),
    ...(args.modelCallId ? [encodeField(F.CV2C_MODEL_CALL_ID, WIRE.LEN, args.modelCallId)] : []),
  )
}

export interface EncodeToolResultInput {
  tool_call_id: string
  tool_name: string
  result_content: string
  raw_args?: string
  tool_index?: number
}

export function encodeToolResult(tr: EncodeToolResultInput): Uint8Array {
  const formatted = formatToolName(tr.tool_name || '')
  const rawArgs = tr.raw_args || '{}'
  const { toolCallId, modelCallId } = parseToolId(tr.tool_call_id || '')
  const idx = tr.tool_index ?? 1
  const { serverName, selectedTool } = parseToolName(formatted)
  return concat(
    encodeField(F.TR_CALL_ID, WIRE.LEN, toolCallId),
    encodeField(F.TR_NAME, WIRE.LEN, formatted),
    encodeField(F.TR_INDEX, WIRE.VARINT, idx > 0 ? idx : 1),
    ...(modelCallId ? [encodeField(F.TR_MODEL_CALL_ID, WIRE.LEN, modelCallId)] : []),
    encodeField(F.TR_RAW_ARGS, WIRE.LEN, rawArgs),
    encodeField(F.TR_RESULT, WIRE.LEN, encCv2Result({
      toolCallId, modelCallId, selectedTool, resultContent: tr.result_content, toolIndex: idx,
    })),
    encodeField(F.TR_TOOL_CALL, WIRE.LEN, encCv2Call({
      toolCallId, toolName: formatted, selectedTool, serverName, rawArgs, modelCallId, toolIndex: idx,
    })),
  )
}

export interface EncodeMessageInput {
  content: string
  role: 'user' | 'assistant'
  messageId: string
  isLast: boolean
  hasTools: boolean
  toolResults: EncodeToolResultInput[]
}

export function encodeMessage(m: EncodeMessageInput): Uint8Array {
  const roleId = m.role === 'user' ? ROLE.USER : ROLE.ASSISTANT
  return concat(
    encodeField(F.MSG_CONTENT, WIRE.LEN, m.content),
    encodeField(F.MSG_ROLE, WIRE.VARINT, roleId),
    encodeField(F.MSG_ID, WIRE.LEN, m.messageId),
    ...m.toolResults.map(tr => encodeField(F.MSG_TOOL_RESULTS, WIRE.LEN, encodeToolResult(tr))),
    encodeField(F.MSG_IS_AGENTIC, WIRE.VARINT, m.hasTools ? 1 : 0),
    encodeField(F.MSG_UNIFIED_MODE, WIRE.VARINT, m.hasTools ? UNIFIED_MODE.AGENT : UNIFIED_MODE.CHAT),
    ...(m.isLast && m.hasTools ? [encodeField(F.MSG_SUPPORTED_TOOLS, WIRE.LEN, encodeVarint(1))] : []),
  )
}

function encodeModel(modelName: string): Uint8Array {
  return concat(
    encodeField(F.MODEL_NAME, WIRE.LEN, modelName),
    encodeField(F.MODEL_EMPTY, WIRE.LEN, new Uint8Array(0)),
  )
}

function encodeInstruction(text: string): Uint8Array {
  return text ? encodeField(F.INSTRUCTION_TEXT, WIRE.LEN, text) : new Uint8Array(0)
}

function encodeCursorSetting(): Uint8Array {
  const unknown6 = concat(
    encodeField(F.SETTING6_FIELD_1, WIRE.LEN, new Uint8Array(0)),
    encodeField(F.SETTING6_FIELD_2, WIRE.LEN, new Uint8Array(0)),
  )
  return concat(
    encodeField(F.SETTING_PATH, WIRE.LEN, 'cursor\\aisettings'),
    encodeField(F.SETTING_UNKNOWN_3, WIRE.LEN, new Uint8Array(0)),
    encodeField(F.SETTING_UNKNOWN_6, WIRE.LEN, unknown6),
    encodeField(F.SETTING_UNKNOWN_8, WIRE.VARINT, 1),
    encodeField(F.SETTING_UNKNOWN_9, WIRE.VARINT, 1),
  )
}

function encodeMetadata(): Uint8Array {
  let cwd = '/'
  try { cwd = process.cwd() } catch { cwd = '/' }
  return concat(
    encodeField(F.META_PLATFORM, WIRE.LEN, process.platform || 'linux'),
    encodeField(F.META_ARCH, WIRE.LEN, process.arch || 'x64'),
    encodeField(F.META_VERSION, WIRE.LEN, process.version || 'v20.0.0'),
    encodeField(F.META_CWD, WIRE.LEN, cwd),
    encodeField(F.META_TIMESTAMP, WIRE.LEN, new Date().toISOString()),
  )
}

function encodeMessageId(id: string, role: 'user' | 'assistant'): Uint8Array {
  const roleId = role === 'user' ? ROLE.USER : ROLE.ASSISTANT
  return concat(
    encodeField(F.MSGID_ID, WIRE.LEN, id),
    encodeField(F.MSGID_ROLE, WIRE.VARINT, roleId),
  )
}

export interface EncodeMcpToolInput {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

function encodeMcpTool(tool: EncodeMcpToolInput): Uint8Array {
  const name = tool.name || ''
  const desc = tool.description || ''
  const params = tool.parameters && Object.keys(tool.parameters).length > 0
    ? JSON.stringify(tool.parameters)
    : null
  return concat(
    ...(name ? [encodeField(F.MCP_TOOL_NAME, WIRE.LEN, name)] : []),
    ...(desc ? [encodeField(F.MCP_TOOL_DESC, WIRE.LEN, desc)] : []),
    ...(params ? [encodeField(F.MCP_TOOL_PARAMS, WIRE.LEN, params)] : []),
    encodeField(F.MCP_TOOL_SERVER, WIRE.LEN, 'custom'),
  )
}

// ─── Request builders ────────────────────────────────────────────

export interface NormalizedCursorMessage {
  role: 'user' | 'assistant'
  content: string
  tool_results?: EncodeToolResultInput[]
}

export function encodeRequest(
  messages: NormalizedCursorMessage[],
  modelName: string,
  tools: EncodeMcpToolInput[],
  reasoningEffort: 'medium' | 'high' | null,
): Uint8Array {
  const hasTools = tools.length > 0
  const isAgentic = hasTools

  interface Prepared {
    content: string
    role: 'user' | 'assistant'
    messageId: string
    isLast: boolean
    hasTools: boolean
    toolResults: EncodeToolResultInput[]
  }
  const prepared: Prepared[] = []
  const messageIds: { messageId: string; role: 'user' | 'assistant' }[] = []

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    const id = _randomUUID()
    prepared.push({
      content: m.content,
      role: m.role,
      messageId: id,
      isLast: i === messages.length - 1,
      hasTools,
      toolResults: m.tool_results ?? [],
    })
    messageIds.push({ messageId: id, role: m.role })
  }

  const thinkingLevel = reasoningEffort === 'high'
    ? THINKING_LEVEL.HIGH
    : reasoningEffort === 'medium'
      ? THINKING_LEVEL.MEDIUM
      : THINKING_LEVEL.UNSPECIFIED

  return concat(
    ...prepared.map(p => encodeField(F.MESSAGES, WIRE.LEN, encodeMessage(p))),
    encodeField(F.UNKNOWN_2, WIRE.VARINT, 1),
    encodeField(F.INSTRUCTION, WIRE.LEN, encodeInstruction('')),
    encodeField(F.UNKNOWN_4, WIRE.VARINT, 1),
    encodeField(F.MODEL, WIRE.LEN, encodeModel(modelName)),
    encodeField(F.WEB_TOOL, WIRE.LEN, ''),
    encodeField(F.UNKNOWN_13, WIRE.VARINT, 1),
    encodeField(F.CURSOR_SETTING, WIRE.LEN, encodeCursorSetting()),
    encodeField(F.UNKNOWN_19, WIRE.VARINT, 1),
    encodeField(F.CONVERSATION_ID, WIRE.LEN, _randomUUID()),
    encodeField(F.METADATA, WIRE.LEN, encodeMetadata()),
    encodeField(F.IS_AGENTIC, WIRE.VARINT, isAgentic ? 1 : 0),
    ...(isAgentic ? [encodeField(F.SUPPORTED_TOOLS, WIRE.LEN, encodeVarint(1))] : []),
    ...messageIds.map(m => encodeField(F.MESSAGE_IDS, WIRE.LEN, encodeMessageId(m.messageId, m.role))),
    ...tools.map(t => encodeField(F.MCP_TOOLS, WIRE.LEN, encodeMcpTool(t))),
    encodeField(F.LARGE_CONTEXT, WIRE.VARINT, 0),
    encodeField(F.UNKNOWN_38, WIRE.VARINT, 0),
    encodeField(F.UNIFIED_MODE, WIRE.VARINT, isAgentic ? UNIFIED_MODE.AGENT : UNIFIED_MODE.CHAT),
    encodeField(F.UNKNOWN_47, WIRE.LEN, ''),
    encodeField(F.SHOULD_DISABLE_TOOLS, WIRE.VARINT, isAgentic ? 0 : 1),
    encodeField(F.THINKING_LEVEL, WIRE.VARINT, thinkingLevel),
    encodeField(F.UNKNOWN_51, WIRE.VARINT, 0),
    encodeField(F.UNKNOWN_53, WIRE.VARINT, 1),
    encodeField(F.UNIFIED_MODE_NAME, WIRE.LEN, isAgentic ? 'Agent' : 'Ask'),
  )
}

export function buildChatRequestPayload(
  messages: NormalizedCursorMessage[],
  modelName: string,
  tools: EncodeMcpToolInput[],
  reasoningEffort: 'medium' | 'high' | null,
): Uint8Array {
  return encodeField(
    F.REQUEST,
    WIRE.LEN,
    encodeRequest(messages, modelName, tools, reasoningEffort),
  )
}

/** Wrap a protobuf payload in the 5-byte ConnectRPC frame (flag + u32 BE length). */
export function wrapConnectFrame(payload: Uint8Array, compress = false): Uint8Array {
  let body = payload
  let flags = 0
  if (compress) {
    body = new Uint8Array(gzipSync(Buffer.from(payload)))
    flags = 1
  }
  const frame = new Uint8Array(5 + body.length)
  frame[0] = flags
  frame[1] = (body.length >>> 24) & 0xff
  frame[2] = (body.length >>> 16) & 0xff
  frame[3] = (body.length >>> 8) & 0xff
  frame[4] = body.length & 0xff
  frame.set(body, 5)
  return frame
}

export function generateCursorBody(
  messages: NormalizedCursorMessage[],
  modelName: string,
  tools: EncodeMcpToolInput[],
  reasoningEffort: 'medium' | 'high' | null,
): Uint8Array {
  // Cursor rejects compressed REQUEST frames — compression is only a
  // server→client thing. Send with flags=0.
  const protobuf = buildChatRequestPayload(messages, modelName, tools, reasoningEffort)
  return wrapConnectFrame(protobuf, false)
}

// ─── Primitive decoding ──────────────────────────────────────────

export function decodeVarint(buf: Uint8Array, offset: number): { value: number; next: number } {
  let result = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const b = buf[pos]!
    result |= (b & 0x7f) << shift
    pos++
    if (!(b & 0x80)) break
    shift += 7
  }
  return { value: result, next: pos }
}

interface DecodedField {
  fieldNum: number
  wireType: number
  value: Uint8Array | number | null
  next: number
}

function decodeField(buf: Uint8Array, offset: number): DecodedField | null {
  if (offset >= buf.length) return null
  const { value: tag, next: afterTag } = decodeVarint(buf, offset)
  const fieldNum = tag >>> 3
  const wireType = tag & 0x07
  if (wireType === WIRE.VARINT) {
    const { value, next } = decodeVarint(buf, afterTag)
    return { fieldNum, wireType, value, next }
  }
  if (wireType === WIRE.LEN) {
    const { value: len, next: afterLen } = decodeVarint(buf, afterTag)
    const end = afterLen + len
    return { fieldNum, wireType, value: buf.slice(afterLen, end), next: end }
  }
  if (wireType === WIRE.FIXED64) {
    return { fieldNum, wireType, value: buf.slice(afterTag, afterTag + 8), next: afterTag + 8 }
  }
  if (wireType === WIRE.FIXED32) {
    return { fieldNum, wireType, value: buf.slice(afterTag, afterTag + 4), next: afterTag + 4 }
  }
  return null
}

export function decodeMessage(buf: Uint8Array): Map<number, Array<{ wireType: number; value: Uint8Array | number | null }>> {
  const fields = new Map<number, Array<{ wireType: number; value: Uint8Array | number | null }>>()
  let pos = 0
  while (pos < buf.length) {
    const f = decodeField(buf, pos)
    if (!f) break
    if (!fields.has(f.fieldNum)) fields.set(f.fieldNum, [])
    fields.get(f.fieldNum)!.push({ wireType: f.wireType, value: f.value })
    pos = f.next
  }
  return fields
}

/** Pop a single length-prefixed frame off `buf`. Returns null until enough
 *  bytes are available (frames straddle fetch() chunks). Decompresses the
 *  payload when `flag & 0x01` is set.
 *
 *  Return-type uses `Uint8Array<ArrayBufferLike>` so the value produced by
 *  `buf.slice()` (which is `<ArrayBufferLike>` when `buf` itself came from
 *  a fetch chunk) flows back out without an upcast — TypeScript 5.7+ stopped
 *  silently accepting the narrower `<ArrayBuffer>` in this position. */
export function parseConnectFrame(
  buf: Uint8Array,
): { payload: Uint8Array<ArrayBufferLike>; consumed: number } | null {
  if (buf.length < 5) return null
  const flags = buf[0]!
  const length = ((buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!) >>> 0
  const total = 5 + length
  if (buf.length < total) return null
  let payload: Uint8Array<ArrayBufferLike> = buf.slice(5, total)

  // Early bail-out: frames that start with '{' are usually JSON error
  // envelopes (e.g. rate-limit), not gzipped protobuf. Decompression
  // would fail and mangle the message — return the JSON bytes verbatim.
  if (payload.length > 0 && payload[0] === 0x7b) {
    return { payload, consumed: total }
  }

  if (flags & 0x01) {
    payload = _decompressWithFallback(payload)
  }
  return { payload, consumed: total }
}

function _decompressWithFallback(payload: Uint8Array): Uint8Array<ArrayBufferLike> {
  try {
    return new Uint8Array(gunzipSync(Buffer.from(payload)))
  } catch {
    // TRAILER / GZIP_TRAILER frames sometimes carry zlib-deflate bytes
    // instead of a real gzip wrapper. Try in order.
    try {
      return new Uint8Array(inflateSync(Buffer.from(payload)))
    } catch {
      try {
        return new Uint8Array(inflateRawSync(Buffer.from(payload)))
      } catch {
        // Last resort — return raw bytes so the JSON error path can at
        // least detect `{"error":…}` envelopes that weren't compressed.
        return payload
      }
    }
  }
}

// ─── Response payload → normalized event ─────────────────────────

export interface CursorToolCall {
  id: string
  name: string
  argumentsDelta: string
  isLast: boolean
}

export interface CursorExtracted {
  text: string | null
  thinking: string | null
  toolCall: CursorToolCall | null
  error: string | null
  /** Set on undecodable payloads so the caller can log + keep going. */
  decodeError: string | null
}

function extractToolCall(data: Uint8Array): CursorToolCall | null {
  const fields = decodeMessage(data)
  let toolCallId = ''
  let toolName = ''
  let rawArgs = ''
  let isLast = false

  const idField = fields.get(F.TOOL_ID)?.[0]
  if (idField && idField.value instanceof Uint8Array) {
    const full = _decoder.decode(idField.value)
    toolCallId = full.split('\n')[0] || ''
  }
  const nameField = fields.get(F.TOOL_NAME)?.[0]
  if (nameField && nameField.value instanceof Uint8Array) {
    toolName = _decoder.decode(nameField.value)
  }
  const isLastField = fields.get(F.TOOL_IS_LAST)?.[0] ?? fields.get(F.TOOL_IS_LAST_ALT)?.[0]
  if (isLastField && typeof isLastField.value === 'number') {
    isLast = isLastField.value !== 0
  }

  const mcpParamsField = fields.get(F.TOOL_MCP_PARAMS)?.[0]
  if (mcpParamsField && mcpParamsField.value instanceof Uint8Array) {
    try {
      const mcpParams = decodeMessage(mcpParamsField.value)
      const listEntry = mcpParams.get(F.MCP_TOOLS_LIST)?.[0]
      if (listEntry && listEntry.value instanceof Uint8Array) {
        const nested = decodeMessage(listEntry.value)
        const nestedName = nested.get(F.MCP_NESTED_NAME)?.[0]
        if (nestedName && nestedName.value instanceof Uint8Array) {
          toolName = _decoder.decode(nestedName.value)
        }
        const nestedParams = nested.get(F.MCP_NESTED_PARAMS)?.[0]
        if (nestedParams && nestedParams.value instanceof Uint8Array) {
          rawArgs = _decoder.decode(nestedParams.value)
        }
      }
    } catch {
      // Fall through to the flat raw_args fallback below.
    }
  }

  if (!rawArgs) {
    const rawField = fields.get(F.TOOL_RAW_ARGS)?.[0]
    if (rawField && rawField.value instanceof Uint8Array) {
      rawArgs = _decoder.decode(rawField.value)
    }
  }

  if (!toolCallId || !toolName) return null
  return {
    id: toolCallId,
    name: unformatToolName(toolName),
    argumentsDelta: rawArgs || '',
    isLast,
  }
}

function extractTextAndThinking(data: Uint8Array): { text: string | null; thinking: string | null } {
  const nested = decodeMessage(data)
  let text: string | null = null
  let thinking: string | null = null
  const textField = nested.get(F.RESPONSE_TEXT)?.[0]
  if (textField && textField.value instanceof Uint8Array) {
    text = _decoder.decode(textField.value)
  }
  const thinkingField = nested.get(F.THINKING)?.[0]
  if (thinkingField && thinkingField.value instanceof Uint8Array) {
    try {
      const tm = decodeMessage(thinkingField.value)
      const t = tm.get(F.THINKING_TEXT)?.[0]
      if (t && t.value instanceof Uint8Array) thinking = _decoder.decode(t.value)
    } catch {
      // swallow — treat as no thinking content
    }
  }
  return { text, thinking }
}

/** Parse a single response payload (already unframed + decompressed). */
export function extractFromResponsePayload(payload: Uint8Array): CursorExtracted {
  // JSON error path — server sometimes returns `{"error": {...}}` as the
  // frame body when rate-limiting or when the bearer token is invalid.
  if (payload.length > 0 && payload[0] === 0x7b) {
    try {
      const text = _decoder.decode(payload)
      if (text.includes('"error"')) {
        const parsed = JSON.parse(text) as {
          error?: {
            message?: string
            code?: string
            details?: Array<{ debug?: { details?: { title?: string; detail?: string }; error?: string } }>
          }
        }
        const msg = parsed.error?.details?.[0]?.debug?.details?.title
          ?? parsed.error?.details?.[0]?.debug?.details?.detail
          ?? parsed.error?.message
          ?? 'API error'
        return { text: null, thinking: null, toolCall: null, error: msg, decodeError: null }
      }
    } catch {
      // Not actually JSON — fall through to protobuf path.
    }
  }

  try {
    const fields = decodeMessage(payload)
    const tc = fields.get(F.TOOL_CALL)?.[0]
    if (tc && tc.value instanceof Uint8Array) {
      const call = extractToolCall(tc.value)
      if (call) {
        return { text: null, thinking: null, toolCall: call, error: null, decodeError: null }
      }
    }
    const resp = fields.get(F.RESPONSE)?.[0]
    if (resp && resp.value instanceof Uint8Array) {
      const { text, thinking } = extractTextAndThinking(resp.value)
      if (text || thinking) {
        return { text, thinking, toolCall: null, error: null, decodeError: null }
      }
    }
    return { text: null, thinking: null, toolCall: null, error: null, decodeError: null }
  } catch (err) {
    return {
      text: null,
      thinking: null,
      toolCall: null,
      error: null,
      decodeError: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── Tiny helpers ────────────────────────────────────────────────

function _randomUUID(): string {
  // Node 14.17+. Lower-bound check in case the harness loads a legacy
  // polyfill without it.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  // Minimal fallback — enough for id uniqueness within one session.
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  )
}
