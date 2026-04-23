/**
 * Cursor protobuf request checks.
 *
 * Run via: bun run src/lanes/cursor/protobuf.test.ts
 */

import {
  decodeMessage,
  encodeRequest,
  extractFromResponsePayload,
  parseConnectFrame,
} from './protobuf.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function decodeBody(body: Uint8Array): string {
  return new TextDecoder().decode(body)
}

test('Cursor request preserves a provided conversation id', () => {
  const request = encodeRequest(
    [{ role: 'user', content: 'hello' }],
    'auto',
    [],
    [],
    null,
    { conversationId: 'cursor-conversation-fixed' },
  )
  const text = decodeBody(request)
  assert(text.includes('cursor-conversation-fixed'), 'missing provided conversation id')
})

test('Cursor request keeps Auto as the native auto model id', () => {
  const request = encodeRequest(
    [{ role: 'user', content: 'hello' }],
    'auto',
    [],
    [],
    null,
  )
  const text = decodeBody(request)
  assert(text.includes('auto'), 'missing auto model id')
  assert(!text.includes('default'), 'legacy default model id leaked into request')
})

test('Cursor request encodes assistant tool calls and tool results natively', () => {
  const request = encodeRequest(
    [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'toolu_1',
            toolName: 'run_terminal_cmd',
            args: { command: 'echo ok' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'toolu_1',
            toolName: 'run_terminal_cmd',
            result: 'ok',
          },
        ],
      },
    ],
    'auto',
    [],
    [],
    null,
  )
  const text = decodeBody(request)
  assert(text.includes('toolu_1'), 'missing native tool call id')
  assert(text.includes('run_terminal_cmd'), 'missing native tool name')
  assert(text.includes('echo ok'), 'missing native tool args')
  assert(text.includes('ok'), 'missing native tool result')
})

test('Cursor request marks requested models as built-in Cursor models', () => {
  const request = encodeRequest(
    [{ role: 'user', content: 'hello' }],
    'auto',
    [],
    [],
    null,
  )
  const fields = decodeMessage(request)
  const requestedModel = fields.get(7)?.[0]?.value
  assert(requestedModel instanceof Uint8Array, 'missing requested_model payload')
  const requestedModelFields = decodeMessage(requestedModel)
  assert(
    requestedModelFields.get(4)?.[0]?.value === 1,
    'missing built_in_model flag on requested_model',
  )
})

test('Cursor parser preserves trailer-frame JSON errors', () => {
  const payload = new TextEncoder().encode(
    '{"error":{"message":"Named models unavailable"}}',
  )
  const frame = new Uint8Array(5 + payload.length)
  frame[0] = 0x02
  frame[1] = (payload.length >>> 24) & 0xff
  frame[2] = (payload.length >>> 16) & 0xff
  frame[3] = (payload.length >>> 8) & 0xff
  frame[4] = payload.length & 0xff
  frame.set(payload, 5)

  const parsed = parseConnectFrame(frame)
  assert(parsed != null, 'failed to parse trailer frame')
  const extracted = extractFromResponsePayload(parsed.payload)
  assert(
    extracted.error === 'Named models unavailable',
    `wrong trailer error: ${JSON.stringify(extracted)}`,
  )
})

test('Cursor parser prefers detailed debug text from JSON errors', () => {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      error: {
        message: 'Error',
        details: [{
          debug: {
            details: {
              title: 'Internal server error.',
              detail: 'If the problem persists, email hi@cursor.com.',
            },
          },
        }],
      },
    }),
  )

  const extracted = extractFromResponsePayload(payload)
  assert(
    extracted.error === 'Internal server error.\nIf the problem persists, email hi@cursor.com.',
    `wrong detailed JSON error: ${JSON.stringify(extracted)}`,
  )
})

test('Cursor parser prefers top-level title/detail text from JSON errors', () => {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      error: 'ERROR_UNAUTHORIZED',
      details: {
        title: 'Unauthorized request.',
        detail: 'User is unauthorized',
      },
    }),
  )

  const extracted = extractFromResponsePayload(payload)
  assert(
    extracted.error === 'Unauthorized request.\nUser is unauthorized',
    `wrong top-level JSON error: ${JSON.stringify(extracted)}`,
  )
})

test('Cursor parser ignores empty JSON trailer envelopes', () => {
  const extracted = extractFromResponsePayload(new TextEncoder().encode('{}'))
  assert(
    extracted.error === null,
    `empty JSON trailer should be ignored: ${JSON.stringify(extracted)}`,
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
