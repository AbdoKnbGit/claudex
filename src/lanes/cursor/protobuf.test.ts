/**
 * Cursor protobuf request checks.
 *
 * Run via: bun run src/lanes/cursor/protobuf.test.ts
 */

import {
  CURSOR_CLIENT_SIDE_TOOL_V2,
  buildCursorSupportedToolEnums,
} from './tools.js'
import { encodeRequest } from './protobuf.js'

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

function hasBytes(haystack: Uint8Array, needle: number[]): boolean {
  outer:
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

test('Cursor supported_tools uses repeated varint enum fields', () => {
  const supportedTools = buildCursorSupportedToolEnums([
    { name: 'Read', input_schema: { type: 'object' } },
    { name: 'Bash', input_schema: { type: 'object' } },
  ])
  const request = encodeRequest(
    [{ role: 'user', content: 'hello' }],
    'default',
    [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object' },
      },
    ],
    supportedTools,
    null,
  )

  // Field 29 with wire type 0 is tag 0xe8 0x01. The previous bug used
  // wire type 2, tag 0xea 0x01, with a single packed placeholder value.
  assert(
    hasBytes(request, [0xe8, 0x01, CURSOR_CLIENT_SIDE_TOOL_V2.READ_FILE]),
    'missing READ_FILE varint field',
  )
  assert(
    hasBytes(request, [0xe8, 0x01, CURSOR_CLIENT_SIDE_TOOL_V2.RUN_TERMINAL_COMMAND_V2]),
    'missing RUN_TERMINAL_COMMAND_V2 varint field',
  )
  assert(!hasBytes(request, [0xea, 0x01, 0x01, 0x01]), 'found old length-delimited placeholder')
})

test('Cursor request preserves a provided conversation id', () => {
  const request = encodeRequest(
    [{ role: 'user', content: 'hello' }],
    'default',
    [],
    [],
    null,
    { conversationId: 'cursor-conversation-fixed' },
  )
  const text = new TextDecoder().decode(request)
  assert(text.includes('cursor-conversation-fixed'), 'missing provided conversation id')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
