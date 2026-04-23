import type { ProviderMessage } from './base_provider.js'
import { sanitizeProviderMessagesForNonCursorTransport } from './sanitizeProviderMessages.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function main(): void {
  console.log('sanitize provider messages:')

  test('keeps safe tool ids unchanged', () => {
    const messages: ProviderMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_safe_1', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_safe_1', content: 'ok' }],
      },
    ]

    const next = sanitizeProviderMessagesForNonCursorTransport(messages)
    assert(next === messages, 'safe ids should preserve the original array')
  })

  test('strips Cursor metadata suffix from tool ids', () => {
    const messages: ProviderMessage[] = [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_2\nmc_abc123',
          name: 'Bash',
          input: { command: 'pwd' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_2\nmc_abc123',
          content: 'C:/repo',
        }],
      },
    ]

    const next = sanitizeProviderMessagesForNonCursorTransport(messages)
    const toolUse = (next[0]!.content as Exclude<ProviderMessage['content'], string>)[0] as { id: string }
    const toolResult = (next[1]!.content as Exclude<ProviderMessage['content'], string>)[0] as { tool_use_id: string }

    assert(toolUse.id === 'toolu_2', 'expected Cursor metadata to be stripped from tool_use id')
    assert(toolResult.tool_use_id === 'toolu_2', 'expected Cursor metadata to be stripped from tool_result id')
  })

  test('rehashes overlong ids down to provider-safe length consistently', () => {
    const longId = `toolu_${'x'.repeat(80)}\nmc_cursor_meta`
    const messages: ProviderMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: longId, name: 'Edit', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: longId, content: 'done' }],
      },
    ]

    const next = sanitizeProviderMessagesForNonCursorTransport(messages)
    const toolUse = (next[0]!.content as Exclude<ProviderMessage['content'], string>)[0] as { id: string }
    const toolResult = (next[1]!.content as Exclude<ProviderMessage['content'], string>)[0] as { tool_use_id: string }

    assert(toolUse.id.length <= 64, 'sanitized tool_use id must fit provider limit')
    assert(toolUse.id === toolResult.tool_use_id, 'tool_use and tool_result ids must stay matched')
    assert(toolUse.id.startsWith('toolu_'), 'sanitized tool id should keep a toolu_ prefix')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
