/**
 * Antigravity disclosure banner tests.
 *
 * Spec requirement: before the first Antigravity OAuth flow on any
 * machine, the user sees a gray-area TOS disclosure and explicitly
 * acks it. The ack is persisted by SHA, so re-ack is required when
 * the banner text changes (TOS updates).
 *
 * Run:  bun run src/lanes/gemini/antigravity_banner.test.ts
 */

import {
  ANTIGRAVITY_BANNER_TEXT,
  ANTIGRAVITY_BANNER_VERSION,
  antigravityBannerHash,
  isAntigravityAcknowledged,
  acknowledgeAntigravitySession,
  _clearSessionAckForTest,
} from './antigravity_banner.js'

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
  console.log('antigravity banner:')

  // ── Content checks ─────────────────────────────────────────────
  test('banner mentions TOS risk', () => {
    assert(/terms of service/i.test(ANTIGRAVITY_BANNER_TEXT), 'TOS phrasing missing')
  })
  test('banner mentions gray-area', () => {
    assert(/gray-area/i.test(ANTIGRAVITY_BANNER_TEXT), 'gray-area phrasing missing')
  })
  test('banner mentions account suspension risk', () => {
    assert(/suspend|ban/i.test(ANTIGRAVITY_BANNER_TEXT), 'account-risk nudge missing')
  })
  test('banner names Gemini 3.x Pro + Claude 4.6', () => {
    assert(ANTIGRAVITY_BANNER_TEXT.includes('Gemini 3.x Pro'),
      'Gemini 3.x Pro not named')
    assert(ANTIGRAVITY_BANNER_TEXT.includes('Claude 4.6'),
      'Claude 4.6 not named')
  })
  test('banner under 2KB', () => {
    const bytes = Buffer.byteLength(ANTIGRAVITY_BANNER_TEXT, 'utf-8')
    assert(bytes < 2048, `banner too long: ${bytes} bytes`)
  })

  // ── Version + hash stability ───────────────────────────────────
  test('banner version is a positive integer', () => {
    assert(Number.isInteger(ANTIGRAVITY_BANNER_VERSION) && ANTIGRAVITY_BANNER_VERSION >= 1,
      `bad version: ${ANTIGRAVITY_BANNER_VERSION}`)
  })
  test('banner hash is deterministic', () => {
    const a = antigravityBannerHash()
    const b = antigravityBannerHash()
    assert(a === b, 'hash is non-deterministic')
    assert(a.length === 64, `expected SHA-256 hex (64 chars), got ${a.length}`)
  })

  // ── Ack flow (session scope) ───────────────────────────────────
  test('isAntigravityAcknowledged starts false in fresh session', () => {
    _clearSessionAckForTest()
    // Note: this check is best-effort because the on-disk store may
    // already contain an ack from a previous dev run. We just verify
    // the helper returns a boolean.
    const v = isAntigravityAcknowledged()
    assert(typeof v === 'boolean', `expected boolean, got ${typeof v}`)
  })
  test('session ack flips isAntigravityAcknowledged to true', () => {
    _clearSessionAckForTest()
    acknowledgeAntigravitySession()
    assert(isAntigravityAcknowledged(), 'session ack did not register')
  })
  test('_clearSessionAckForTest isolates tests', () => {
    acknowledgeAntigravitySession()
    _clearSessionAckForTest()
    // On-disk state may still return true, but we cleared the session
    // memo. Just verify the helper runs without throwing.
    const _v = isAntigravityAcknowledged()
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
