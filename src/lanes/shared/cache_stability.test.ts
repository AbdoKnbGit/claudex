/**
 * Cache-stability invariant tests.
 *
 * Core promise of `system_slots.ts`: the stable slot is byte-identical
 * across turns when only env / git / memory change. If this breaks,
 * every cache in the product silently stops hitting and cost goes up.
 *
 * Run:  bun run src/lanes/shared/cache_stability.test.ts
 */

import type { SystemPromptParts } from '../types.js'
import {
  renderStableSlot,
  renderVolatileSlot,
  stableFrom,
  cacheKeyOf,
} from './system_slots.js'

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

function assertEq<T>(a: T, b: T, hint: string): void {
  if (a !== b) throw new Error(`${hint}: expected equal\n  a=${String(a).slice(0, 200)}\n  b=${String(b).slice(0, 200)}`)
}

function assertNe<T>(a: T, b: T, hint: string): void {
  if (a === b) throw new Error(`${hint}: expected NOT equal`)
}

function turn1Parts(): SystemPromptParts {
  return {
    memory: '# Project notes\nRepo uses bun + typescript',
    environment: 'os: darwin 14.2.1\ncwd: /Users/me/work/x\ndate: 2026-04-16T12:00:00Z',
    gitStatus: 'branch: main · clean',
    toolsAddendum: '',
    mcpIntro: '',
    skillsContext: '',
    customInstructions: 'Prefer small, focused commits.',
  }
}

function turn2Parts(): SystemPromptParts {
  // Only volatile bits change — memory note gets a follow-up line, env
  // clock advances, git status shows an uncommitted file, cwd differs.
  return {
    memory: '# Project notes\nRepo uses bun + typescript\n## Update\nAdded lanes/shared',
    environment: 'os: darwin 14.2.1\ncwd: /Users/me/work/x/sub\ndate: 2026-04-16T12:05:33Z',
    gitStatus: 'branch: main · 1 modified',
    toolsAddendum: '',
    mcpIntro: '',
    skillsContext: '',
    customInstructions: 'Prefer small, focused commits.',
  }
}

function main(): void {
  console.log('cache_stability invariants:')

  // 1. renderStableSlot ignores volatile fields
  test('stable slot byte-identical when only volatile changes', () => {
    const a = renderStableSlot(turn1Parts())
    const b = renderStableSlot(turn2Parts())
    assertEq(String(a), String(b), 'stable slot drifted between turns')
  })

  // 2. renderVolatileSlot picks up every volatile field change
  test('volatile slot NOT identical when env/git/memory change', () => {
    const a = renderVolatileSlot(turn1Parts())
    const b = renderVolatileSlot(turn2Parts())
    assertNe(String(a), String(b), 'volatile slot failed to reflect turn-to-turn deltas')
  })

  // 3. stableFrom() preserves stability when lane preamble is fixed
  test('stableFrom(preamble, parts) stable across turns', () => {
    const preamble = 'You are an interactive AI coding agent.'
    const a = stableFrom(preamble, turn1Parts())
    const b = stableFrom(preamble, turn2Parts())
    assertEq(String(a), String(b), 'stable preamble composition drifted')
  })

  // 4. Stable slot includes customInstructions etc.
  test('stable slot includes customInstructions', () => {
    const a = String(renderStableSlot(turn1Parts()))
    if (!a.includes('Prefer small, focused commits')) {
      throw new Error('customInstructions missing from stable slot')
    }
  })

  // 5. Stable slot excludes volatile fields
  test('stable slot excludes memory', () => {
    const a = String(renderStableSlot(turn1Parts()))
    if (a.includes('Project notes')) {
      throw new Error('memory leaked into stable slot — cache key will drift')
    }
  })
  test('stable slot excludes environment', () => {
    const a = String(renderStableSlot(turn1Parts()))
    if (a.includes('darwin') || a.includes('2026-04-16')) {
      throw new Error('environment leaked into stable slot')
    }
  })
  test('stable slot excludes gitStatus', () => {
    const a = String(renderStableSlot(turn1Parts()))
    if (a.includes('branch:')) {
      throw new Error('gitStatus leaked into stable slot')
    }
  })

  // 6. cacheKeyOf(stable) is stable across identical-stable turns
  test('cacheKeyOf identical across turns when only volatile changes', () => {
    const k1 = cacheKeyOf(renderStableSlot(turn1Parts()))
    const k2 = cacheKeyOf(renderStableSlot(turn2Parts()))
    assertEq(k1, k2, 'cache key should be identical')
  })

  // 7. cacheKeyOf changes when stable changes
  test('cacheKeyOf changes when customInstructions change', () => {
    const p1 = turn1Parts()
    const p2 = { ...turn1Parts(), customInstructions: 'Different instructions' }
    const k1 = cacheKeyOf(renderStableSlot(p1))
    const k2 = cacheKeyOf(renderStableSlot(p2))
    assertNe(k1, k2, 'cache key should shift when stable content shifts')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
