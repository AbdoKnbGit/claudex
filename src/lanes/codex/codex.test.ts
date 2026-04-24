/**
 * Codex lane invariants.
 *
 * Run:  bun run src/lanes/codex/codex.test.ts
 */

import { CodexApiError } from './api.js'
import { codexLane, resolveReasoning } from './loop.js'
import { assembleCodexSystemPrompt } from './prompt.js'
import { getCodexRegistrationByNativeName } from './tools.js'
import { setOpenAIReasoningLevel } from '../../utils/model/openaiReasoning.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
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

async function main(): Promise<void> {
  console.log('codex lane:')

  await test('lists GPT-5.5 with reasoning support', async () => {
    const models = await codexLane.listModels()
    const model = models.find(m => m.id === 'gpt-5.5')
    assert(model, 'expected gpt-5.5 in codex model list')
    assert(model?.contextWindow === 272000, 'expected codex-main context window')
    assert(model?.tags?.includes('reasoning'), 'expected reasoning tag')
  })
  await test('supports gpt-5-codex', () => {
    assert(codexLane.supportsModel('gpt-5-codex'), 'expected support')
  })
  await test('supports gpt-5.5', () => {
    assert(codexLane.supportsModel('gpt-5.5'), 'expected support')
  })
  await test('supports o3-mini', () => {
    assert(codexLane.supportsModel('o3-mini'), 'expected support')
  })
  await test('supports codex-turbo', () => {
    assert(codexLane.supportsModel('codex-turbo'), 'expected support')
  })
  await test('does NOT support claude-*', () => {
    assert(!codexLane.supportsModel('claude-sonnet-4-6'), 'Claude must stay in Claude lane')
  })
  await test('does NOT support gemini-*', () => {
    assert(!codexLane.supportsModel('gemini-2.5-pro'), 'Gemini must stay in Gemini lane')
  })
  await test('does NOT support qwen-*', () => {
    assert(!codexLane.supportsModel('qwen3-coder-plus'), 'Qwen must go to Qwen lane')
  })

  await test('smallFastModel returns gpt-5.4-mini', () => {
    assert(codexLane.smallFastModel?.() === 'gpt-5.4-mini', 'expected gpt-5.4-mini')
  })
  await test('explicit xhigh reasoning reaches Responses request config', () => {
    setOpenAIReasoningLevel('xhigh')
    const reasoning = resolveReasoning({ type: 'disabled' }, 'gpt-5.5')
    assert(reasoning?.effort === 'xhigh', `expected xhigh; got ${reasoning?.effort}`)
  })

  await test('tool registry has apply_patch', () => {
    const r = getCodexRegistrationByNativeName('apply_patch')
    assert(r != null, 'apply_patch missing from Codex tool registry')
  })

  await test('stable slot byte-identical across turns when volatile changes', () => {
    const base = { toolsAddendum: '', mcpIntro: '', skillsContext: '', customInstructions: 'c' }
    const t1 = assembleCodexSystemPrompt('gpt-5-codex', {
      ...base, memory: 'a', environment: 'e1', gitStatus: 'g1',
    })
    const t2 = assembleCodexSystemPrompt('gpt-5-codex', {
      ...base, memory: 'b', environment: 'e2', gitStatus: 'g2',
    })
    assert(String(t1.stable) === String(t2.stable), 'stable drifted between turns')
    assert(String(t1.volatile) !== String(t2.volatile), 'volatile should differ')
  })
  await test('apply_patch mentioned in stable preamble', () => {
    const p = assembleCodexSystemPrompt('gpt-5-codex', {
      memory: '', environment: '', gitStatus: '',
      toolsAddendum: '', mcpIntro: '', skillsContext: '', customInstructions: '',
    })
    assert(String(p.stable).includes('apply_patch'),
      'codex system prompt should call out apply_patch as the edit primitive')
  })

  await test('CodexApiError detects context_length_exceeded as prompt-too-long', () => {
    const err = new CodexApiError(400, JSON.stringify({
      error: { code: 'context_length_exceeded', message: 'maximum context length 128000' },
    }))
    assert(err.isPromptTooLong, 'context_length_exceeded should be classified as PTL')
    assert(err.message.startsWith('Prompt is too long'),
      `message should lead with PTL prefix; got: ${err.message.slice(0, 60)}`)
  })
  await test('CodexApiError non-PTL error has normal prefix', () => {
    const err = new CodexApiError(500, 'internal server error')
    assert(!err.isPromptTooLong, 'should not classify 500 as PTL')
    assert(err.message.startsWith('OpenAI Responses API error'),
      `got: ${err.message.slice(0, 60)}`)
  })
  await test('CodexApiError 429 is retryable, 400 is not', () => {
    assert(new CodexApiError(429, '').isRetryable, '429 should be retryable')
    assert(!new CodexApiError(400, '').isRetryable, '400 should NOT be retryable')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
