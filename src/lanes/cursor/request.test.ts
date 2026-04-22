/**
 * Cursor request adaptation checks.
 *
 * Run via: bun run src/lanes/cursor/request.test.ts
 */

import { buildCursorBody } from './request.js'

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

test('Cursor rewrites shared tool ids in the injected system instructions', () => {
  const body = buildCursorBody({
    model: 'default',
    system:
      'Use `Read`, `Bash`, `Agent`, and `EnterPlanMode` when appropriate.',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'Bash', input_schema: { type: 'object' } },
      { name: 'Agent', input_schema: { type: 'object' } },
      { name: 'EnterPlanMode', input_schema: { type: 'object' } },
    ],
    conversationId: 'conv-1',
  })

  const text = decodeBody(body)
  assert(text.includes('`read_file`'), 'missing read_file alias')
  assert(text.includes('`run_terminal_cmd`'), 'missing run_terminal_cmd alias')
  assert(text.includes('`task`'), 'missing task alias')
  assert(text.includes('`create_plan`'), 'missing create_plan alias')
  assert(!text.includes('`Read`'), 'shared Read alias leaked into system text')
  assert(!text.includes('`Bash`'), 'shared Bash alias leaked into system text')
})

test('Cursor rewrites tool_result XML names to the advertised native tool name', () => {
  const body = buildCursorBody({
    model: 'default',
    system: '',
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'pwd' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'C:/repo',
          },
        ],
      },
    ],
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    conversationId: 'conv-2',
  })

  const text = decodeBody(body)
  assert(
    text.includes('<tool_name>run_terminal_cmd</tool_name>'),
    'tool_result did not use Cursor-native tool name',
  )
  assert(!text.includes('<tool_name>Bash</tool_name>'), 'shared tool name leaked into tool_result XML')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
