/**
 * DeepSeek thinking-mode history replay tests.
 *
 * Run: bun run src/lanes/openai-compat/deepseek_history.test.ts
 */

import assert from 'node:assert/strict'
import type { ProviderMessage } from '../../services/api/providers/base_provider.js'
import { _convertHistoryToOpenAIForTest } from './loop.js'

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

console.log('deepseek history conversion:')

test('attaches pending thinking as reasoning_content on DeepSeek tool calls', () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'check the date' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'I need the current date.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me check that.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_date', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '2026-04-24' }] },
  ]

  const out = _convertHistoryToOpenAIForTest(messages, '', 'deepseek', 'deepseek-v4-pro')
  const toolCallMessage = out.find(m => m.role === 'assistant' && m.tool_calls)

  assert.equal(toolCallMessage?.reasoning_content, 'I need the current date.')
  assert.equal(toolCallMessage?.content, 'Let me check that.')
})

test('adds empty reasoning_content for old DeepSeek tool-call history without thinking', () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'read package json' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'package.json' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{}' }] },
  ]

  const out = _convertHistoryToOpenAIForTest(messages, '', 'deepseek', 'deepseek-v4-pro')
  const toolCallMessage = out.find(m => m.role === 'assistant' && m.tool_calls)

  assert.equal(toolCallMessage?.reasoning_content, '')
})

test('keeps non-DeepSeek history conversion unchanged', () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'read package json' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'package.json' } }] },
  ]

  const out = _convertHistoryToOpenAIForTest(messages, '', 'openrouter', 'anthropic/claude-sonnet-4.5')
  const toolCallMessage = out.find(m => m.role === 'assistant' && m.tool_calls)

  assert.equal('reasoning_content' in (toolCallMessage ?? {}), false)
})

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\n${passed} passed`)
