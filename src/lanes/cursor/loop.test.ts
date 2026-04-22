/**
 * Cursor stream thinking/text split checks.
 *
 * Run via: bun run src/lanes/cursor/loop.test.ts
 */

import {
  consumeCursorPrintedToolText,
  createCursorPrintedToolTextState,
  createCursorThinkingSplitState,
  flushCursorPrintedToolText,
  flushCursorThinkingSplitState,
  parseCursorPrintedToolCalls,
  splitCursorThinkingDelta,
} from './loop.js'

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

test('Cursor thinking stream hands visible answer to text after </think>', () => {
  const state = createCursorThinkingSplitState()
  let thinking = ''
  let text = ''

  for (const chunk of [
    'The us',
    'er is simply saying "hi".\n',
    '</think>\nHi. What ',
    'do you want help with?',
  ]) {
    const split = splitCursorThinkingDelta(chunk, state)
    thinking += split.thinking ?? ''
    text += split.text ?? ''
  }

  const flushed = flushCursorThinkingSplitState(state)
  thinking += flushed.thinking ?? ''
  text += flushed.text ?? ''

  assert(
    thinking === 'The user is simply saying "hi".\n',
    `wrong thinking split: ${JSON.stringify(thinking)}`,
  )
  assert(
    text === 'Hi. What do you want help with?',
    `wrong text split: ${JSON.stringify(text)}`,
  )
})

test('Cursor split handles a closing </think> marker across frame boundaries', () => {
  const state = createCursorThinkingSplitState()
  let thinking = ''
  let text = ''

  for (const chunk of ['Reasoning...', '</th', 'ink>', '\nDone']) {
    const split = splitCursorThinkingDelta(chunk, state)
    thinking += split.thinking ?? ''
    text += split.text ?? ''
  }

  const flushed = flushCursorThinkingSplitState(state)
  thinking += flushed.thinking ?? ''
  text += flushed.text ?? ''

  assert(thinking === 'Reasoning...', `wrong thinking carry: ${JSON.stringify(thinking)}`)
  assert(text === 'Done', `wrong text carry: ${JSON.stringify(text)}`)
})

test('Cursor parses printed tool calls that arrive in post-think text tails', () => {
  const thinkingState = createCursorThinkingSplitState()
  const toolState = createCursorPrintedToolTextState()
  const out: Array<
    { type: 'text'; text: string } |
    { type: 'tool_calls'; calls: Array<{ name: string; input: Record<string, unknown> }> }
  > = []

  for (const chunk of [
    '<think>Reasoning',
    '...</think>\nListing files.\n\n<|tool?calls?begin',
    '|><|tool?call?begin|>\nGlob\n<|tool?sep|>target_directory\nC:/repo\n<|tool?sep|>glob_pattern\n**/*\n<|tool?call?end|><|tool?calls?end|>',
  ]) {
    const split = splitCursorThinkingDelta(chunk, thinkingState)
    if (split.text) out.push(...consumeCursorPrintedToolText(split.text, toolState))
  }

  const flushedThinking = flushCursorThinkingSplitState(thinkingState)
  if (flushedThinking.text) out.push(...consumeCursorPrintedToolText(flushedThinking.text, toolState))
  out.push(...flushCursorPrintedToolText(toolState))

  const leadingText = out
    .filter((chunk): chunk is { type: 'text'; text: string } => chunk.type === 'text')
    .map(chunk => chunk.text)
    .join('')
  const toolChunk = out.find(
    (chunk): chunk is { type: 'tool_calls'; calls: Array<{ name: string; input: Record<string, unknown> }> } =>
      chunk.type === 'tool_calls',
  )

  assert(leadingText === 'Listing files.\n\n', `wrong post-think leading text: ${JSON.stringify(leadingText)}`)
  assert(Boolean(toolChunk), 'missing post-think parsed tool call chunk')
  assert(toolChunk?.calls[0]?.name === 'Glob', 'wrong post-think parsed glob name')
})

test('Cursor parses printed Qwen-style tool call blocks', () => {
  const block =
    '<\uFF5Ctool\u2581calls\u2581begin\uFF5C>'
    + '<\uFF5Ctool\u2581call\u2581begin\uFF5C>\n'
    + 'Glob\n'
    + '<\uFF5Ctool\u2581sep\uFF5C>target_directory\n'
    + 'C:/repo\n'
    + '<\uFF5Ctool\u2581sep\uFF5C>glob_pattern\n'
    + '**/*\n'
    + '<\uFF5Ctool\u2581call\u2581end\uFF5C>'
    + '<\uFF5Ctool\u2581call\u2581begin\uFF5C>\n'
    + 'run_terminal_cmd\n'
    + '<\uFF5Ctool\u2581sep\uFF5C>command\n'
    + 'echo ok\n'
    + '<\uFF5Ctool\u2581call\u2581end\uFF5C>'
    + '<\uFF5Ctool\u2581calls\u2581end\uFF5C>'

  const parsed = parseCursorPrintedToolCalls(block)
  assert(parsed?.length === 2, 'wrong printed tool call count')
  assert(parsed?.[0]?.name === 'Glob', 'wrong first printed tool name')
  assert(parsed?.[0]?.input.target_directory === 'C:/repo', 'wrong first printed tool directory')
  assert(parsed?.[0]?.input.glob_pattern === '**/*', 'wrong first printed tool pattern')
  assert(parsed?.[1]?.name === 'run_terminal_cmd', 'wrong second printed tool name')
  assert(parsed?.[1]?.input.command === 'echo ok', 'wrong second printed tool command')
})

test('Cursor printed tool parser handles marker boundaries across chunks', () => {
  const state = createCursorPrintedToolTextState()
  const out = [
    ...consumeCursorPrintedToolText('Checking...\n<\uFF5Ctool\u2581calls\u2581be', state),
    ...consumeCursorPrintedToolText(
      'gin\uFF5C><\uFF5Ctool\u2581call\u2581begin\uFF5C>\nGrep\n<\uFF5Ctool\u2581sep\uFF5C>pattern\n.\n<\uFF5Ctool\u2581sep\uFF5C>head_limit\n3\n<\uFF5Ctool\u2581call\u2581end\uFF5C><\uFF5Ctool\u2581calls\u2581end\uFF5C>',
      state,
    ),
    ...flushCursorPrintedToolText(state),
  ]

  const leadingText = out
    .filter((chunk): chunk is { type: 'text'; text: string } => chunk.type === 'text')
    .map(chunk => chunk.text)
    .join('')
  const toolChunk = out.find(
    (chunk): chunk is { type: 'tool_calls'; calls: Array<{ name: string; input: Record<string, unknown> }> } =>
      chunk.type === 'tool_calls',
  )

  assert(leadingText === 'Checking...\n', `missing leading text: ${JSON.stringify(leadingText)}`)
  assert(Boolean(toolChunk), 'missing parsed tool call chunk')
  assert(toolChunk?.calls[0]?.name === 'Grep', 'wrong parsed grep name')
  assert(toolChunk?.calls[0]?.input.head_limit === 3, 'wrong parsed grep limit')
})

test('Cursor printed tool parser handles ASCII fallback markers from stream JSON', () => {
  const state = createCursorPrintedToolTextState()
  const out = [
    ...consumeCursorPrintedToolText('Checking...\n<|tool?calls?be', state),
    ...consumeCursorPrintedToolText(
      'gin|><|tool?call?begin|>\nGlob\n<|tool?sep|>target_directory\nC:/repo\n<|tool?sep|>glob_pattern\n**/*\n<|tool?call?end|><|tool?calls?end|>',
      state,
    ),
    ...flushCursorPrintedToolText(state),
  ]

  const leadingText = out
    .filter((chunk): chunk is { type: 'text'; text: string } => chunk.type === 'text')
    .map(chunk => chunk.text)
    .join('')
  const toolChunk = out.find(
    (chunk): chunk is { type: 'tool_calls'; calls: Array<{ name: string; input: Record<string, unknown> }> } =>
      chunk.type === 'tool_calls',
  )

  assert(leadingText === 'Checking...\n', `missing ASCII leading text: ${JSON.stringify(leadingText)}`)
  assert(Boolean(toolChunk), 'missing ASCII parsed tool call chunk')
  assert(toolChunk?.calls[0]?.name === 'Glob', 'wrong ASCII parsed glob name')
  assert(
    toolChunk?.calls[0]?.input.target_directory === 'C:/repo',
    'wrong ASCII parsed glob directory',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
