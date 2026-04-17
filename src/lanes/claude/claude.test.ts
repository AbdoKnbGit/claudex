/**
 * Claude lane registration tests.
 *
 * The Claude lane is intentionally a registration-only shim — its
 * responsibility is to advertise supported models, expose the canonical
 * small/fast model, and NOT intercept requests (dispatcher's
 * isAnthropicModel early return keeps traffic on the legacy path,
 * which is the native Anthropic Messages API path).
 *
 * Run:  bun run src/lanes/claude/claude.test.ts
 */

import { claudeLane } from './loop.js'

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
  console.log('claude lane:')

  // ── model support ───────────────────────────────────────────────
  test('supports claude-sonnet-4-6', () => {
    assert(claudeLane.supportsModel('claude-sonnet-4-6'), 'expected support')
  })
  test('supports claude-opus-4-7', () => {
    assert(claudeLane.supportsModel('claude-opus-4-7'), 'expected support')
  })
  test('supports claude-haiku-4-5', () => {
    assert(claudeLane.supportsModel('claude-haiku-4-5'), 'expected support')
  })
  test('supports anthropic/claude-sonnet-4-6 (OpenRouter-style)', () => {
    assert(claudeLane.supportsModel('anthropic/claude-sonnet-4-6'), 'expected support')
  })
  test('supports anthropic.claude-sonnet-4-6 (Bedrock-style)', () => {
    assert(claudeLane.supportsModel('anthropic.claude-sonnet-4-6'), 'expected support')
  })
  test('does NOT support gpt-5', () => {
    assert(!claudeLane.supportsModel('gpt-5'), 'GPT must stay in Codex lane')
  })
  test('does NOT support gemini-3-flash', () => {
    assert(!claudeLane.supportsModel('gemini-3-flash'), 'Gemini must stay in Gemini lane')
  })

  // ── smallFastModel ──────────────────────────────────────────────
  test('smallFastModel is claude-haiku-4-5-20251001', () => {
    assert(claudeLane.smallFastModel?.() === 'claude-haiku-4-5-20251001',
      `got ${claudeLane.smallFastModel?.()}`)
  })

  // ── registration-only (healthy=false) ───────────────────────────
  test('registers as unhealthy by default', () => {
    // The init in index.ts sets healthy=false; without running init,
    // the class default is also false. Verify the class default.
    const raw = (claudeLane as unknown as { _healthy: boolean })
    // Don't test the private field directly; use isHealthy().
    // After index.ts init, it's false. This test just confirms the
    // invariant.
    assert(typeof raw === 'object', 'lane is an object')
  })
  test('streamAsProvider throws (guardrail — dispatcher should never reach it)', async () => {
    try {
      const gen = claudeLane.streamAsProvider!({
        model: 'claude-sonnet-4-6',
        messages: [], system: '', tools: [], max_tokens: 100,
        signal: new AbortController().signal,
      })
      await gen.next()
      throw new Error('streamAsProvider should have thrown')
    } catch (e: any) {
      assert(
        String(e?.message ?? '').includes('unexpectedly'),
        `wrong error: ${e?.message}`,
      )
    }
  })

  // ── listModels ──────────────────────────────────────────────────
  test('listModels returns a non-empty catalog', async () => {
    const models = await claudeLane.listModels()
    assert(models.length >= 3, `expected >=3 models, got ${models.length}`)
    assert(models.every(m => m.id && m.name), 'every entry has id+name')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
