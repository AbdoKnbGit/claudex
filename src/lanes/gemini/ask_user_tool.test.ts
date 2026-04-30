/**
 * Regression tests for Gemini ask_user -> AskUserQuestion argument shaping.
 *
 * Run: bun run src/lanes/gemini/ask_user_tool.test.ts
 */

import { resolveToolCall } from './tools.js'

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

function main(): void {
  console.log('gemini ask_user tool:')

  test('wraps Gemini shorthand question into AskUserQuestion questions array', () => {
    const resolved = resolveToolCall('ask_user', {
      question: 'Which of the following is a programming language?',
    })
    assert(resolved?.implId === 'AskUserQuestion', 'wrong implementation tool')
    const questions = resolved.input.questions as Array<Record<string, unknown>>
    assert(Array.isArray(questions), 'questions should be an array')
    assert(questions.length === 1, 'expected one question')
    assert(questions[0]?.question === 'Which of the following is a programming language?', 'question text lost')
    assert(typeof questions[0]?.header === 'string' && questions[0].header !== '', 'header missing')
    assert(Array.isArray(questions[0]?.options), 'options should be an array')
    assert((questions[0]?.options as unknown[]).length >= 2, 'fallback options missing')
    assert(questions[0]?.multiSelect === false, 'multiSelect should default false')
  })

  test('preserves native question arrays and option labels', () => {
    const resolved = resolveToolCall('ask_user', {
      questions: [{
        question: 'Pick a runtime?',
        header: 'Runtime',
        type: 'choice',
        options: [
          { label: 'Bun', description: 'Use Bun.' },
          { label: 'Node', description: 'Use Node.js.' },
        ],
        multiSelect: true,
      }],
    })
    const question = (resolved?.input.questions as Array<Record<string, any>>)[0]
    assert(question?.header === 'Runtime', 'header should be preserved')
    assert(question?.multiSelect === true, 'multiSelect should be preserved')
    assert(question?.options?.[0]?.label === 'Bun', 'first option label lost')
    assert(question?.options?.[1]?.label === 'Node', 'second option label lost')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
