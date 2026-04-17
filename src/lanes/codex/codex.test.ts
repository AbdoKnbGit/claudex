/**
 * Codex lane invariants.
 *
 * Run:  bun run src/lanes/codex/codex.test.ts
 */

import { codexLane } from './loop.js'
import { CODEX_TOOL_REGISTRY, getCodexRegistrationByNativeName } from './tools.js'
import { assembleCodexSystemPrompt } from './prompt.js'
import { CodexApiError } from './api.js'

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
  console.log('codex lane:')

  // ── model support ───────────────────────────────────────────────
  test('supports gpt-5-codex', () => {
    assert(codexLane.supportsModel('gpt-5-codex'), 'expected support')
  })
  test('supports o3-mini', () => {
    assert(codexLane.supportsModel('o3-mini'), 'expected support')
  })
  test('supports codex-turbo', () => {
    assert(codexLane.supportsModel('codex-turbo'), 'expected support')
  })
  test('does NOT support claude-*', () => {
    assert(!codexLane.supportsModel('claude-sonnet-4-6'), 'Claude must stay in Claude lane')
  })
  test('does NOT support gemini-*', () => {
    assert(!codexLane.supportsModel('gemini-2.5-pro'), 'Gemini must stay in Gemini lane')
  })
  test('does NOT support qwen-*', () => {
    assert(!codexLane.supportsModel('qwen3-coder-plus'), 'Qwen must go to Qwen lane')
  })

  // ── smallFastModel ──────────────────────────────────────────────
  test('smallFastModel returns gpt-4o-mini', () => {
    assert(codexLane.smallFastModel?.() === 'gpt-4o-mini', 'expected gpt-4o-mini')
  })

  // ── tool registry ───────────────────────────────────────────────
  test('tool registry has apply_patch', () => {
    const r = getCodexRegistrationByNativeName('apply_patch')
    assert(r != null, 'apply_patch missing from Codex tool registry')
  })

  // ── system prompt split ─────────────────────────────────────────
  test('stable slot byte-identical across turns when volatile changes', () => {
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
  test('apply_patch mentioned in stable preamble', () => {
    const p = assembleCodexSystemPrompt('gpt-5-codex', {
      memory: '', environment: '', gitStatus: '',
      toolsAddendum: '', mcpIntro: '', skillsContext: '', customInstructions: '',
    })
    assert(String(p.stable).includes('apply_patch'),
      'codex system prompt should call out apply_patch as the edit primitive')
  })

  // ── PromptTooLongError surfacing ────────────────────────────────
  test('CodexApiError detects context_length_exceeded as prompt-too-long', () => {
    const err = new CodexApiError(400, JSON.stringify({
      error: { code: 'context_length_exceeded', message: 'maximum context length 128000' },
    }))
    assert(err.isPromptTooLong, 'context_length_exceeded should be classified as PTL')
    assert(err.message.startsWith('Prompt is too long'),
      `message should lead with PTL prefix; got: ${err.message.slice(0, 60)}`)
  })
  test('CodexApiError non-PTL error has normal prefix', () => {
    const err = new CodexApiError(500, 'internal server error')
    assert(!err.isPromptTooLong, 'should not classify 500 as PTL')
    assert(err.message.startsWith('OpenAI Responses API error'),
      `got: ${err.message.slice(0, 60)}`)
  })
  test('CodexApiError 429 is retryable, 400 is not', () => {
    assert(new CodexApiError(429, '').isRetryable, '429 should be retryable')
    assert(!new CodexApiError(400, '').isRetryable, '400 should NOT be retryable')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
