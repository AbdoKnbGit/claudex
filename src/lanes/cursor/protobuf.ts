/**
 * Cursor InferenceService protobuf codec.
 *
 * Cursor's current chat lane uses `aiserver.v1.InferenceService/Stream`
 * over ConnectRPC framing, not the older unified-chat schema. This file
 * encodes the request fields we need for native Cursor chat and decodes the
 * streaming response parts Cursor emits back to the agent loop.
 */

import { gunzipSync, gzipSync, inflateSync, inflateRawSync } from 'zlib'

const WIRE = { VARINT: 0, FIXED64: 1, LEN: 2, FIXED32: 5 } as const

const INFERENCE_ROLE = {
  UNSPECIFIED: 0,
  USER: 1,
  ASSISTANT: 2,
  TOOL: 3,
  SYSTEM: 4,
} as const

const F = {
  REQUEST_MESSAGES: 1,
  REQUEST_TOOLS: 2,
  REQUEST_PROVIDER_DEFINED_TOOLS: 3,
  REQUEST_MODEL_CONFIG: 4,
  REQUEST_MODEL_ID: 5,
  REQUEST_INVOCATION_ID: 6,
  REQUEST_REQUESTED_MODEL: 7,
  REQUEST_CONVERSATION_ID: 8,

  CORE_ROLE: 1,
  CORE_TEXT: 2,
  CORE_PARTS: 3,
  CORE_TOOL_CALLS: 4,
  CORE_TOOL_CONTENT: 6,

  CONTENT_PARTS: 1,
  CONTENT_PART_TEXT: 1,
  CONTENT_PART_IMAGE: 2,
  CONTENT_PART_FILE: 3,

  TEXT_PART_TEXT: 1,

  TOOL_CALL_ID: 1,
  TOOL_CALL_NAME: 2,
  TOOL_CALL_ARGS: 3,

  AGENT_TOOL_NAME: 1,
  AGENT_TOOL_DESCRIPTION: 2,
  AGENT_TOOL_PARAMETERS: 3,
  AGENT_TOOL_CUSTOM_FORMAT: 4,

  CUSTOM_TOOL_FORMAT_TYPE: 1,
  CUSTOM_TOOL_FORMAT_DEFINITION: 2,
  CUSTOM_TOOL_FORMAT_SYNTAX: 3,

  REQUESTED_MODEL_ID: 1,
  REQUESTED_MODEL_MAX_MODE: 2,
  REQUESTED_MODEL_PARAMETERS: 3,
  REQUESTED_MODEL_BUILT_IN: 4,
  REQUESTED_MODEL_VARIANT_REPR: 5,

  MODEL_PARAMETER_ID: 1,
  MODEL_PARAMETER_VALUE: 2,

  TOOL_RESULT_CONTENT_PARTS: 1,
  TOOL_RESULT_PART_ID: 1,
  TOOL_RESULT_PART_NAME: 2,
  TOOL_RESULT_PART_RESULT: 3,
  TOOL_RESULT_PART_IS_ERROR: 4,

  MODEL_CONFIG_MAX_TOKENS: 1,
  MODEL_CONFIG_TEMPERATURE: 2,
  MODEL_CONFIG_TOP_P: 3,
  MODEL_CONFIG_STOP_SEQUENCES: 4,

  RESPONSE_TEXT_PART: 1,
  RESPONSE_TOOL_CALL_PART: 2,
  RESPONSE_USAGE: 3,
  RESPONSE_INFO: 4,
  RESPONSE_EXTENDED_USAGE: 5,
  RESPONSE_PROVIDER_METADATA: 6,
  RESPONSE_INVOCATION_ID: 7,
  RESPONSE_ERROR: 8,
  RESPONSE_THINKING_PART: 9,

  TEXT_STREAM_TEXT: 1,
  TEXT_STREAM_IS_FINAL: 2,

  THINKING_STREAM_TEXT: 1,
  THINKING_STREAM_SIGNATURE: 2,
  THINKING_STREAM_IS_FINAL: 3,

  TOOL_CALL_STREAM_ID: 1,
  TOOL_CALL_STREAM_NAME: 2,
  TOOL_CALL_STREAM_ARGS: 3,
  TOOL_CALL_STREAM_IS_COMPLETE: 4,
  TOOL_CALL_STREAM_INDEX: 5,

  USAGE_PROMPT_TOKENS: 1,
  USAGE_COMPLETION_TOKENS: 2,
  USAGE_TOTAL_TOKENS: 3,

  EXTENDED_USAGE_INPUT_TOKENS: 1,
  EXTENDED_USAGE_OUTPUT_TOKENS: 2,
  EXTENDED_USAGE_CACHE_READ_TOKENS: 3,
  EXTENDED_USAGE_CACHE_WRITE_TOKENS: 4,
  EXTENDED_USAGE_MAX_TOKENS: 5,

  RESPONSE_INFO_ID: 1,
  RESPONSE_INFO_MODEL: 2,
  RESPONSE_INFO_CREATED_AT: 3,
  RESPONSE_INFO_MESSAGES: 4,
  RESPONSE_INFO_ERROR_MESSAGE: 5,
  RESPONSE_INFO_EXTRA_DATA: 6,

  INVOCATION_INFO_ID: 1,

  ERROR_MESSAGE: 1,
  ERROR_CODE: 2,
  ERROR_IS_INPUT_TOKEN_LIMIT: 3,
  ERROR_IS_OUTPUT_TOKEN_LIMIT: 4,
  ERROR_TYPE: 5,

  PROVIDER_METADATA_METADATA: 1,

  PROVIDER_OPTIONS_ANTHROPIC: 1,
  ANTHROPIC_OPTIONS_CACHE_CONTROL: 1,
  CACHE_CONTROL_TYPE: 1,

  JSON_STRUCT_FIELDS: 1,
  JSON_STRUCT_ENTRY_KEY: 1,
  JSON_STRUCT_ENTRY_VALUE: 2,
  JSON_VALUE_NULL: 1,
  JSON_VALUE_NUMBER: 2,
  JSON_VALUE_STRING: 3,
  JSON_VALUE_BOOL: 4,
  JSON_VALUE_STRUCT: 5,
  JSON_VALUE_LIST: 6,
  JSON_LIST_VALUES: 1,
} as const

const _encoder = new TextEncoder()
const _decoder = new TextDecoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function encodeTag(fieldNum: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNum << 3) | wireType)
}

function encodeFixed64Double(value: number): Uint8Array {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setFloat64(0, value, true)
  return out
}

function encodeFieldVarint(fieldNum: number, value: number): Uint8Array {
  return concat(encodeTag(fieldNum, WIRE.VARINT), encodeVarint(value))
}

function encodeFieldLen(fieldNum: number, value: string | Uint8Array): Uint8Array {
  const data = typeof value === 'string' ? _encoder.encode(value) : value
  return concat(encodeTag(fieldNum, WIRE.LEN), encodeVarint(data.length), data)
}

function encodeFieldFixed64(fieldNum: number, value: number): Uint8Array {
  return concat(encodeTag(fieldNum, WIRE.FIXED64), encodeFixed64Double(value))
}

function encodeJsonStruct(
  input: Record<string, unknown> | null | undefined,
): Uint8Array {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return new Uint8Array(0)
  }

  const fields: Uint8Array[] = []
  for (const [key, value] of Object.entries(input)) {
    const entry = concat(
      encodeFieldLen(F.JSON_STRUCT_ENTRY_KEY, key),
      encodeFieldLen(F.JSON_STRUCT_ENTRY_VALUE, encodeJsonValue(value)),
    )
    fields.push(encodeFieldLen(F.JSON_STRUCT_FIELDS, entry))
  }
  return concat(...fields)
}

function encodeJsonList(values: unknown[]): Uint8Array {
  return concat(...values.map(value => encodeFieldLen(F.JSON_LIST_VALUES, encodeJsonValue(value))))
}

function encodeJsonValue(value: unknown): Uint8Array {
  if (value == null) {
    return encodeFieldVarint(F.JSON_VALUE_NULL, 0)
  }
  if (typeof value === 'string') {
    return encodeFieldLen(F.JSON_VALUE_STRING, value)
  }
  if (typeof value === 'boolean') {
    return encodeFieldVarint(F.JSON_VALUE_BOOL, value ? 1 : 0)
  }
  if (typeof value === 'number') {
    return encodeFieldFixed64(F.JSON_VALUE_NUMBER, value)
  }
  if (Array.isArray(value)) {
    return encodeFieldLen(F.JSON_VALUE_LIST, encodeJsonList(value))
  }
  if (typeof value === 'object') {
    return encodeFieldLen(F.JSON_VALUE_STRUCT, encodeJsonStruct(value as Record<string, unknown>))
  }
  return encodeFieldLen(F.JSON_VALUE_STRING, String(value))
}

function encodeProviderOptions(
  input: CursorProviderOptions | undefined,
): Uint8Array {
  const cacheType = input?.anthropic?.cacheControl?.type
  if (!cacheType) return new Uint8Array(0)

  const cacheControl = encodeFieldLen(
    F.ANTHROPIC_OPTIONS_CACHE_CONTROL,
    encodeFieldLen(F.CACHE_CONTROL_TYPE, cacheType),
  )
  const anthropic = encodeFieldLen(F.PROVIDER_OPTIONS_ANTHROPIC, cacheControl)
  return anthropic
}

export function encodeVarint(value: number): Uint8Array {
  const out: number[] = []
  let current = value >>> 0
  while (current >= 0x80) {
    out.push((current & 0x7f) | 0x80)
    current >>>= 7
  }
  out.push(current)
  return new Uint8Array(out)
}

export function decodeVarint(
  buf: Uint8Array,
  offset: number,
): { value: number; next: number } {
  let result = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const byte = buf[pos]!
    result |= (byte & 0x7f) << shift
    pos += 1
    if ((byte & 0x80) === 0) break
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
    return {
      fieldNum,
      wireType,
      value: buf.slice(afterTag, afterTag + 8),
      next: afterTag + 8,
    }
  }
  if (wireType === WIRE.FIXED32) {
    return {
      fieldNum,
      wireType,
      value: buf.slice(afterTag, afterTag + 4),
      next: afterTag + 4,
    }
  }
  return null
}

export function decodeMessage(
  buf: Uint8Array,
): Map<number, Array<{ wireType: number; value: Uint8Array | number | null }>> {
  const fields = new Map<number, Array<{ wireType: number; value: Uint8Array | number | null }>>()
  let pos = 0
  while (pos < buf.length) {
    const field = decodeField(buf, pos)
    if (!field) break
    if (!fields.has(field.fieldNum)) fields.set(field.fieldNum, [])
    fields.get(field.fieldNum)!.push({ wireType: field.wireType, value: field.value })
    pos = field.next
  }
  return fields
}

function fieldBytes(
  fields: Map<number, Array<{ wireType: number; value: Uint8Array | number | null }>>,
  fieldNum: number,
): Uint8Array | null {
  const value = fields.get(fieldNum)?.[0]?.value
  return value instanceof Uint8Array ? value : null
}

function fieldString(
  fields: Map<number, Array<{ wireType: number; value: Uint8Array | number | null }>>,
  fieldNum: number,
): string | undefined {
  const value = fieldBytes(fields, fieldNum)
  return value ? _decoder.decode(value) : undefined
}

function fieldNumber(
  fields: Map<number, Array<{ wireType: number; value: Uint8Array | number | null }>>,
  fieldNum: number,
): number | undefined {
  const value = fields.get(fieldNum)?.[0]?.value
  return typeof value === 'number' ? value : undefined
}

function fieldBool(
  fields: Map<number, Array<{ wireType: number; value: Uint8Array | number | null }>>,
  fieldNum: number,
): boolean | undefined {
  const value = fieldNumber(fields, fieldNum)
  return value == null ? undefined : value !== 0
}

function decodeFixed64Double(bytes: Uint8Array | null): number | undefined {
  if (!bytes || bytes.length !== 8) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getFloat64(0, true)
}

function fieldDouble(
  fields: Map<number, Array<{ wireType: number; value: Uint8Array | number | null }>>,
  fieldNum: number,
): number | undefined {
  return decodeFixed64Double(fieldBytes(fields, fieldNum))
}

export interface EncodeToolResultInput {
  tool_call_id: string
  tool_name: string
  result_content: string
  raw_args?: string
  tool_index?: number
}

export interface CursorProviderOptions {
  anthropic?: {
    cacheControl?: {
      type: string
    }
  }
}

export type CursorContentPart =
  | {
      type: 'text'
      text: string
      providerOptions?: CursorProviderOptions
    }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
    }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      result: unknown
      isError?: boolean
    }

export interface NormalizedCursorMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string | CursorContentPart[]
}

export interface EncodeMcpToolInput {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  customToolFormat?: {
    type: string
    definition: string
    syntax: string
  }
}

function encodeTextContentPart(part: Extract<CursorContentPart, { type: 'text' }>): Uint8Array {
  const providerOptions = encodeProviderOptions(part.providerOptions)
  const textPart = concat(
    encodeFieldLen(F.TEXT_PART_TEXT, part.text),
    ...(providerOptions.length > 0 ? [encodeFieldLen(2, providerOptions)] : []),
  )
  return encodeFieldLen(F.CONTENT_PART_TEXT, textPart)
}

function encodeContentParts(parts: CursorContentPart[]): Uint8Array {
  const out: Uint8Array[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      out.push(encodeFieldLen(F.CONTENT_PARTS, encodeTextContentPart(part)))
    }
  }
  return concat(...out)
}

function encodeToolCall(part: Extract<CursorContentPart, { type: 'tool-call' }>): Uint8Array {
  return concat(
    encodeFieldLen(F.TOOL_CALL_ID, part.toolCallId),
    encodeFieldLen(F.TOOL_CALL_NAME, part.toolName),
    encodeFieldLen(F.TOOL_CALL_ARGS, encodeJsonStruct(part.args)),
  )
}

function encodeToolResultPart(
  part: Extract<CursorContentPart, { type: 'tool-result' }>,
): Uint8Array {
  return concat(
    encodeFieldLen(F.TOOL_RESULT_PART_ID, part.toolCallId),
    encodeFieldLen(F.TOOL_RESULT_PART_NAME, part.toolName),
    encodeFieldLen(F.TOOL_RESULT_PART_RESULT, encodeJsonValue(part.result)),
    ...(part.isError ? [encodeFieldVarint(F.TOOL_RESULT_PART_IS_ERROR, 1)] : []),
  )
}

function encodeToolResultContent(
  parts: Array<Extract<CursorContentPart, { type: 'tool-result' }>>,
): Uint8Array {
  return concat(
    ...parts.map(part => encodeFieldLen(F.TOOL_RESULT_CONTENT_PARTS, encodeToolResultPart(part))),
  )
}

function encodeCoreMessage(message: NormalizedCursorMessage): Uint8Array {
  const role = message.role === 'user'
    ? INFERENCE_ROLE.USER
    : message.role === 'assistant'
      ? INFERENCE_ROLE.ASSISTANT
      : message.role === 'tool'
        ? INFERENCE_ROLE.TOOL
        : INFERENCE_ROLE.SYSTEM

  const out: Uint8Array[] = [encodeFieldVarint(F.CORE_ROLE, role)]

  if (typeof message.content === 'string') {
    out.push(encodeFieldLen(F.CORE_TEXT, message.content))
    return concat(...out)
  }

  if (message.role === 'tool') {
    const toolResults = message.content.filter(
      (part): part is Extract<CursorContentPart, { type: 'tool-result' }> =>
        part.type === 'tool-result',
    )
    if (toolResults.length > 0) {
      out.push(encodeFieldLen(F.CORE_TOOL_CONTENT, encodeToolResultContent(toolResults)))
    }
    return concat(...out)
  }

  if (message.role === 'assistant') {
    const text = message.content
      .filter((part): part is Extract<CursorContentPart, { type: 'text' }> => part.type === 'text')
      .map(part => part.text)
      .join('')
    if (text) {
      out.push(encodeFieldLen(F.CORE_TEXT, text))
    }
    const toolCalls = message.content.filter(
      (part): part is Extract<CursorContentPart, { type: 'tool-call' }> =>
        part.type === 'tool-call',
    )
    out.push(...toolCalls.map(part => encodeFieldLen(F.CORE_TOOL_CALLS, encodeToolCall(part))))
    return concat(...out)
  }

  const encodedParts = encodeContentParts(message.content)
  if (encodedParts.length > 0) {
    out.push(encodeFieldLen(F.CORE_PARTS, encodedParts))
  }
  return concat(...out)
}

function encodeCustomToolFormat(
  tool: EncodeMcpToolInput,
): Uint8Array {
  if (!tool.customToolFormat) return new Uint8Array(0)
  return concat(
    encodeFieldLen(F.CUSTOM_TOOL_FORMAT_TYPE, tool.customToolFormat.type),
    encodeFieldLen(F.CUSTOM_TOOL_FORMAT_DEFINITION, tool.customToolFormat.definition),
    encodeFieldLen(F.CUSTOM_TOOL_FORMAT_SYNTAX, tool.customToolFormat.syntax),
  )
}

function encodeTool(tool: EncodeMcpToolInput): Uint8Array {
  const parameters = encodeJsonStruct(tool.parameters ?? {})
  const customToolFormat = encodeCustomToolFormat(tool)
  return concat(
    encodeFieldLen(F.AGENT_TOOL_NAME, tool.name),
    encodeFieldLen(F.AGENT_TOOL_DESCRIPTION, tool.description ?? ''),
    encodeFieldLen(F.AGENT_TOOL_PARAMETERS, parameters),
    ...(customToolFormat.length > 0
      ? [encodeFieldLen(F.AGENT_TOOL_CUSTOM_FORMAT, customToolFormat)]
      : []),
  )
}

function encodeRequestedModel(
  modelName: string,
  options?: {
    maxMode?: boolean
    builtInModel?: boolean
    isVariantStringRepresentation?: boolean
    parameters?: Array<{ id: string; value: string }>
  },
): Uint8Array {
  return concat(
    encodeFieldLen(F.REQUESTED_MODEL_ID, modelName),
    ...(options?.maxMode ? [encodeFieldVarint(F.REQUESTED_MODEL_MAX_MODE, 1)] : []),
    ...(options?.parameters ?? []).map(parameter =>
      encodeFieldLen(
        F.REQUESTED_MODEL_PARAMETERS,
        concat(
          encodeFieldLen(F.MODEL_PARAMETER_ID, parameter.id),
          encodeFieldLen(F.MODEL_PARAMETER_VALUE, parameter.value),
        ),
      ),
    ),
    ...((options?.builtInModel ?? true) ? [encodeFieldVarint(F.REQUESTED_MODEL_BUILT_IN, 1)] : []),
    ...(options?.isVariantStringRepresentation
      ? [encodeFieldVarint(F.REQUESTED_MODEL_VARIANT_REPR, 1)]
      : []),
  )
}

function encodeModelConfig(config: {
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
}): Uint8Array {
  return concat(
    ...(config.maxTokens != null ? [encodeFieldVarint(F.MODEL_CONFIG_MAX_TOKENS, config.maxTokens)] : []),
    ...(config.temperature != null ? [encodeFieldFixed64(F.MODEL_CONFIG_TEMPERATURE, config.temperature)] : []),
    ...(config.topP != null ? [encodeFieldFixed64(F.MODEL_CONFIG_TOP_P, config.topP)] : []),
    ...(config.stopSequences ?? []).map(stop => encodeFieldLen(F.MODEL_CONFIG_STOP_SEQUENCES, stop)),
  )
}

export function encodeRequest(
  messages: NormalizedCursorMessage[],
  modelName: string,
  tools: EncodeMcpToolInput[],
  _supportedToolEnums: number[],
  _reasoningEffort: 'medium' | 'high' | null,
  opts?: {
    conversationId?: string | null
    invocationId?: string | null
    modelConfig?: {
      maxTokens?: number
      temperature?: number
      topP?: number
      stopSequences?: string[]
    }
  },
): Uint8Array {
  const conversationId =
    typeof opts?.conversationId === 'string' && opts.conversationId.trim()
      ? opts.conversationId.trim()
      : _randomUUID()
  const invocationId =
    typeof opts?.invocationId === 'string' && opts.invocationId.trim()
      ? opts.invocationId.trim()
      : _randomUUID()

  const requestFields: Uint8Array[] = [
    ...messages.map(message => encodeFieldLen(F.REQUEST_MESSAGES, encodeCoreMessage(message))),
    ...tools.map(tool => encodeFieldLen(F.REQUEST_TOOLS, encodeTool(tool))),
    encodeFieldLen(F.REQUEST_MODEL_ID, modelName),
    encodeFieldLen(F.REQUEST_REQUESTED_MODEL, encodeRequestedModel(modelName)),
    encodeFieldLen(F.REQUEST_INVOCATION_ID, invocationId),
    encodeFieldLen(F.REQUEST_CONVERSATION_ID, conversationId),
  ]

  if (opts?.modelConfig) {
    const encodedModelConfig = encodeModelConfig(opts.modelConfig)
    if (encodedModelConfig.length > 0) {
      requestFields.splice(
        requestFields.length - 2,
        0,
        encodeFieldLen(F.REQUEST_MODEL_CONFIG, encodedModelConfig),
      )
    }
  }

  return concat(...requestFields)
}

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
  supportedToolEnums: number[],
  reasoningEffort: 'medium' | 'high' | null,
  opts?: {
    conversationId?: string | null
    invocationId?: string | null
  },
): Uint8Array {
  const protobuf = encodeRequest(
    messages,
    modelName,
    tools,
    supportedToolEnums,
    reasoningEffort,
    opts,
  )
  return wrapConnectFrame(protobuf, false)
}

export function parseConnectFrame(
  buf: Uint8Array,
): { payload: Uint8Array<ArrayBufferLike>; consumed: number } | null {
  if (buf.length < 5) return null
  const flags = buf[0]!
  const length = ((buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!) >>> 0
  const total = 5 + length
  if (buf.length < total) return null

  let payload: Uint8Array<ArrayBufferLike> = buf.slice(5, total)

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
    try {
      return new Uint8Array(inflateSync(Buffer.from(payload)))
    } catch {
      try {
        return new Uint8Array(inflateRawSync(Buffer.from(payload)))
      } catch {
        return payload
      }
    }
  }
}

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
  decodeError: string | null
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  } | null
}

function extractCursorJsonErrorText(parsed: unknown): string | null {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null
  }

  const record = parsed as Record<string, unknown>
  const topLevelDetails =
    record.details != null
    && typeof record.details === 'object'
    && !Array.isArray(record.details)
      ? record.details as Record<string, unknown>
      : null
  const topLevelTitle =
    topLevelDetails && typeof topLevelDetails.title === 'string'
      ? topLevelDetails.title.trim()
      : ''
  const topLevelDetail =
    topLevelDetails && typeof topLevelDetails.detail === 'string'
      ? topLevelDetails.detail.trim()
      : ''
  if (topLevelTitle || topLevelDetail) {
    return [topLevelTitle, topLevelDetail].filter(Boolean).join('\n')
  }

  const errorValue = record.error
  const nestedError =
    errorValue != null
    && typeof errorValue === 'object'
    && !Array.isArray(errorValue)
      ? errorValue as Record<string, unknown>
      : null
  const detailFromDebug =
    nestedError && Array.isArray(nestedError.details)
      ? nestedError.details
          .map(detail => {
            if (!detail || typeof detail !== 'object') return ''
            const debug = 'debug' in detail ? detail.debug : null
            if (!debug || typeof debug !== 'object') return ''
            const debugRecord = debug as Record<string, unknown>
            const debugDetails =
              debugRecord.details != null
              && typeof debugRecord.details === 'object'
              && !Array.isArray(debugRecord.details)
                ? debugRecord.details as Record<string, unknown>
                : null
            const title =
              debugDetails && typeof debugDetails.title === 'string'
                ? debugDetails.title.trim()
                : ''
            const body =
              debugDetails && typeof debugDetails.detail === 'string'
                ? debugDetails.detail.trim()
                : ''
            if (title || body) return [title, body].filter(Boolean).join('\n')
            return typeof debugRecord.error === 'string' ? debugRecord.error.trim() : ''
          })
          .find(Boolean) ?? null
      : null
  if (detailFromDebug) return detailFromDebug

  const nestedMessage =
    nestedError && typeof nestedError.message === 'string'
      ? nestedError.message.trim()
      : ''
  if (nestedMessage) return nestedMessage

  const topLevelMessage =
    typeof record.message === 'string'
      ? record.message.trim()
      : ''
  if (topLevelMessage) return topLevelMessage

  const stringError =
    typeof errorValue === 'string'
      ? errorValue.trim()
      : ''
  return stringError || null
}

function decodeJsonValue(
  bytes: Uint8Array | null,
): unknown {
  if (!bytes) return null
  const fields = decodeMessage(bytes)
  if (fieldNumber(fields, F.JSON_VALUE_NULL) != null) return null
  const stringValue = fieldString(fields, F.JSON_VALUE_STRING)
  if (stringValue != null) return stringValue
  const numberValue = fieldDouble(fields, F.JSON_VALUE_NUMBER)
  if (numberValue != null) return numberValue
  const boolValue = fieldBool(fields, F.JSON_VALUE_BOOL)
  if (boolValue != null) return boolValue

  const structBytes = fieldBytes(fields, F.JSON_VALUE_STRUCT)
  if (structBytes) {
    const structFields = decodeMessage(structBytes)
    const entries = structFields.get(F.JSON_STRUCT_FIELDS) ?? []
    const out: Record<string, unknown> = {}
    for (const entry of entries) {
      if (!(entry.value instanceof Uint8Array)) continue
      const decoded = decodeMessage(entry.value)
      const key = fieldString(decoded, F.JSON_STRUCT_ENTRY_KEY)
      if (!key) continue
      out[key] = decodeJsonValue(fieldBytes(decoded, F.JSON_STRUCT_ENTRY_VALUE))
    }
    return out
  }

  const listBytes = fieldBytes(fields, F.JSON_VALUE_LIST)
  if (listBytes) {
    const listFields = decodeMessage(listBytes)
    return (listFields.get(F.JSON_LIST_VALUES) ?? [])
      .map(value => value.value instanceof Uint8Array ? decodeJsonValue(value.value) : null)
  }

  return null
}

function extractToolCall(data: Uint8Array): CursorToolCall | null {
  const fields = decodeMessage(data)
  const id = fieldString(fields, F.TOOL_CALL_STREAM_ID)
  const name = fieldString(fields, F.TOOL_CALL_STREAM_NAME)
  const args = fieldString(fields, F.TOOL_CALL_STREAM_ARGS) ?? ''
  const isComplete = fieldBool(fields, F.TOOL_CALL_STREAM_IS_COMPLETE) ?? false

  if (!id || (!name && !args)) return null
  return {
    id,
    name: name ?? '',
    argumentsDelta: args,
    isLast: isComplete,
  }
}

function extractUsage(data: Uint8Array): CursorExtracted['usage'] {
  const fields = decodeMessage(data)
  return {
    promptTokens: fieldNumber(fields, F.USAGE_PROMPT_TOKENS),
    completionTokens: fieldNumber(fields, F.USAGE_COMPLETION_TOKENS),
    totalTokens: fieldNumber(fields, F.USAGE_TOTAL_TOKENS),
  }
}

function extractExtendedUsage(data: Uint8Array): CursorExtracted['usage'] {
  const fields = decodeMessage(data)
  return {
    inputTokens: fieldNumber(fields, F.EXTENDED_USAGE_INPUT_TOKENS),
    outputTokens: fieldNumber(fields, F.EXTENDED_USAGE_OUTPUT_TOKENS),
    cacheReadTokens: fieldNumber(fields, F.EXTENDED_USAGE_CACHE_READ_TOKENS),
    cacheWriteTokens: fieldNumber(fields, F.EXTENDED_USAGE_CACHE_WRITE_TOKENS),
  }
}

function extractResponseInfoError(data: Uint8Array): string | null {
  const fields = decodeMessage(data)
  return fieldString(fields, F.RESPONSE_INFO_ERROR_MESSAGE) ?? null
}

export function extractFromResponsePayload(payload: Uint8Array): CursorExtracted {
  if (payload.length === 0) {
    return { text: null, thinking: null, toolCall: null, error: null, decodeError: null }
  }

  if (payload[0] === 0x7b) {
    try {
      const text = _decoder.decode(payload)
      const parsed = JSON.parse(text) as unknown

      return {
        text: null,
        thinking: null,
        toolCall: null,
        error: extractCursorJsonErrorText(parsed),
        decodeError: null,
      }
    } catch (error) {
      return {
        text: null,
        thinking: null,
        toolCall: null,
        error: null,
        decodeError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  try {
    const fields = decodeMessage(payload)

    const errorBytes = fieldBytes(fields, F.RESPONSE_ERROR)
    if (errorBytes) {
      const nested = decodeMessage(errorBytes)
      return {
        text: null,
        thinking: null,
        toolCall: null,
        error: fieldString(nested, F.ERROR_MESSAGE) ?? fieldString(nested, F.ERROR_CODE) ?? 'API error',
        decodeError: null,
      }
    }

    const toolCallBytes = fieldBytes(fields, F.RESPONSE_TOOL_CALL_PART)
    if (toolCallBytes) {
      const toolCall = extractToolCall(toolCallBytes)
      return { text: null, thinking: null, toolCall, error: null, decodeError: null }
    }

    const textBytes = fieldBytes(fields, F.RESPONSE_TEXT_PART)
    if (textBytes) {
      const nested = decodeMessage(textBytes)
      return {
        text: fieldString(nested, F.TEXT_STREAM_TEXT) ?? null,
        thinking: null,
        toolCall: null,
        error: null,
        decodeError: null,
      }
    }

    const thinkingBytes = fieldBytes(fields, F.RESPONSE_THINKING_PART)
    if (thinkingBytes) {
      const nested = decodeMessage(thinkingBytes)
      return {
        text: null,
        thinking: fieldString(nested, F.THINKING_STREAM_TEXT) ?? null,
        toolCall: null,
        error: null,
        decodeError: null,
      }
    }

    const usageBytes = fieldBytes(fields, F.RESPONSE_USAGE)
    if (usageBytes) {
      return {
        text: null,
        thinking: null,
        toolCall: null,
        error: null,
        decodeError: null,
        usage: extractUsage(usageBytes),
      }
    }

    const extendedUsageBytes = fieldBytes(fields, F.RESPONSE_EXTENDED_USAGE)
    if (extendedUsageBytes) {
      return {
        text: null,
        thinking: null,
        toolCall: null,
        error: null,
        decodeError: null,
        usage: extractExtendedUsage(extendedUsageBytes),
      }
    }

    const responseInfoBytes = fieldBytes(fields, F.RESPONSE_INFO)
    if (responseInfoBytes) {
      const error = extractResponseInfoError(responseInfoBytes)
      return {
        text: null,
        thinking: null,
        toolCall: null,
        error,
        decodeError: null,
      }
    }

    return { text: null, thinking: null, toolCall: null, error: null, decodeError: null }
  } catch (error) {
    return {
      text: null,
      thinking: null,
      toolCall: null,
      error: null,
      decodeError: error instanceof Error ? error.message : String(error),
    }
  }
}

export function formatCursorToolName(name: string): string {
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

export function unformatCursorToolName(formatted: string): string {
  if (formatted.startsWith('mcp_custom_')) {
    return formatted.slice('mcp_custom_'.length)
  }
  if (formatted.startsWith('mcp_')) {
    const tail = formatted.slice(4)
    const idx = tail.indexOf('_')
    return idx >= 0 ? tail.slice(idx + 1) : tail
  }
  return formatted
}

function _randomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
