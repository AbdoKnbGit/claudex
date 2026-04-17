/**
 * Health-score tracker unit tests.
 *
 * Run:  bun run src/lanes/shared/health_score.test.ts
 */

import { HealthScoreTracker } from './health_score.js'

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
  console.log('health_score:')

  test('pickBest returns best-score among eligible', () => {
    const t = new HealthScoreTracker()
    t.register('a'); t.register('b'); t.register('c')
    t.recordSuccess('a'); t.recordSuccess('a'); t.recordSuccess('a')
    t.recordFailure('b')
    // c is neutral; a is up; b is down → expect a
    const pick = t.pickBest(['a', 'b', 'c'])
    assert(pick === 'a', `wanted a, got ${pick}`)
  })

  test('cooldown excludes an account from pickBest', () => {
    const t = new HealthScoreTracker()
    t.register('a'); t.register('b')
    t.recordSuccess('a'); t.recordSuccess('a')
    t.recordRateLimit('a', 60_000)
    // a is cooling → b is best even though lower score
    const pick = t.pickBest(['a', 'b'])
    assert(pick === 'b', `wanted b, got ${pick}`)
  })

  test('all-cooling returns null from pickBest', () => {
    const t = new HealthScoreTracker()
    t.register('a'); t.register('b')
    t.recordRateLimit('a', 60_000)
    t.recordRateLimit('b', 60_000)
    const pick = t.pickBest(['a', 'b'])
    assert(pick == null, `wanted null, got ${pick}`)
  })

  test('earliestRecovery finds the soonest cooldown-exit', () => {
    const t = new HealthScoreTracker()
    t.register('a'); t.register('b')
    t.recordRateLimit('a', 5000)
    t.recordRateLimit('b', 1000)
    const rec = t.earliestRecovery(['a', 'b'])
    assert(rec?.id === 'b', `wanted b, got ${rec?.id}`)
  })

  test('hardFailureDisableAfter disables after N consecutive failures', () => {
    const t = new HealthScoreTracker({ hardFailureDisableAfter: 3 })
    t.register('a')
    t.recordFailure('a'); t.recordFailure('a'); t.recordFailure('a')
    const snap = t.snapshot('a')!
    assert(snap.disabled, 'should be disabled after 3 failures')
    const pick = t.pickBest(['a'])
    assert(pick == null, 'disabled account should not be picked')
  })

  test('recordSuccess resets hardFailure counter', () => {
    const t = new HealthScoreTracker({ hardFailureDisableAfter: 3 })
    t.register('a')
    t.recordFailure('a'); t.recordFailure('a')
    t.recordSuccess('a')
    t.recordFailure('a'); t.recordFailure('a')
    // 2+1+2 pattern — success resets the consecutive counter
    const snap = t.snapshot('a')!
    assert(!snap.disabled, 'should NOT be disabled — counter reset by success')
  })

  test('reenable lifts disable + cooldown', () => {
    const t = new HealthScoreTracker({ hardFailureDisableAfter: 2 })
    t.register('a')
    t.recordFailure('a'); t.recordFailure('a')
    t.recordRateLimit('a', 60_000)
    t.reenable('a')
    const snap = t.snapshot('a')!
    assert(!snap.disabled, 'should no longer be disabled')
    assert(snap.cooldownRemaining === 0, 'cooldown should be cleared')
  })

  test('unknown id in pickBest is considered neutral', () => {
    const t = new HealthScoreTracker()
    // Nothing registered — should still return something
    const pick = t.pickBest(['x'])
    assert(pick === 'x', `wanted x, got ${pick}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
