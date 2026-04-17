/**
 * Regression tests for the three belt-and-suspenders protections
 * that prevent Flash-class models from emitting empty-args tool calls:
 *
 *   1. toolConfig.functionCallingConfig.mode === 'VALIDATED' on every
 *      tool-enabled request (server-side schema enforcement).
 *   2. TOOL_USAGE_RULES preamble prepended to systemInstruction when
 *      tools are present.
 *   3. STRICT PARAMETERS summary appended to every tool description.
 *
 * Run:  bun run src/lanes/gemini/validated_mode.test.ts
 */

import {
  appendStrictParamsHint,
  buildStrictParamsSummary,
  GEMINI_TOOL_USAGE_RULES,
} from '../shared/mcp_bridge.js'

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
  console.log('gemini validated-mode + hint regression:')

  // ── buildStrictParamsSummary ────────────────────────────────────
  test('summary labels required fields REQUIRED', () => {
    const s = buildStrictParamsSummary({
      type: 'object',
      properties: { command: { type: 'string' }, dir_path: { type: 'string' } },
      required: ['command'],
    })
    assert(s.includes('command: string REQUIRED'),
      `want 'command: string REQUIRED' in summary: ${s}`)
    assert(!s.includes('dir_path: string REQUIRED'),
      `dir_path should not be marked REQUIRED: ${s}`)
  })

  test('summary renders enum values compactly', () => {
    const s = buildStrictParamsSummary({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b', 'c'] } },
      required: [],
    })
    assert(s.includes('mode: string enum(a|b|c)'),
      `enum not rendered: ${s}`)
  })

  test('summary renders nested object children', () => {
    const s = buildStrictParamsSummary({
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
      required: [],
    })
    assert(s.includes('filter: {q: string REQUIRED}'),
      `nested not rendered: ${s}`)
  })

  // ── appendStrictParamsHint ──────────────────────────────────────
  test('appends STRICT PARAMETERS: line to description', () => {
    const d = appendStrictParamsHint('Runs a shell command.', {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    })
    assert(d.includes('Runs a shell command.'), 'base description kept')
    assert(d.includes('STRICT PARAMETERS:'), 'hint added')
    assert(d.includes('command: string REQUIRED'), 'required field in hint')
  })

  test('hint is idempotent (does not stack)', () => {
    const once = appendStrictParamsHint('Run it', {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    })
    const twice = appendStrictParamsHint(once, {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    })
    assert(once === twice, 'calling twice must be a no-op on the second call')
  })

  test('hint works when description is empty', () => {
    const d = appendStrictParamsHint('', {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: ['x'],
    })
    assert(d.startsWith('STRICT PARAMETERS:'),
      `empty-desc path should lead with STRICT PARAMETERS, got: ${d.slice(0, 60)}`)
  })

  // ── TOOL_USAGE_RULES ────────────────────────────────────────────
  test('TOOL_USAGE_RULES contains the three critical nudges', () => {
    const r = GEMINI_TOOL_USAGE_RULES
    assert(r.includes('<TOOL_USAGE_RULES>'), 'XML wrapper present')
    assert(/Supply EVERY parameter listed in "required"/.test(r),
      'required-field nudge missing')
    assert(/never send empty objects/i.test(r),
      'empty-object nudge missing')
    assert(/Do not invent extra parameters/i.test(r),
      'no-invention nudge missing')
  })

  test('TOOL_USAGE_RULES under 700 bytes (cost budget)', () => {
    // The preamble lands on every Gemini turn; keep it tight. 700 is the
    // ceiling where the anti-empty-args payoff clearly outweighs token cost
    // on Flash-class models. Tighten further only if Flash behaves with
    // a smaller nudge — don't compromise clarity for a handful of bytes.
    const b = Buffer.byteLength(GEMINI_TOOL_USAGE_RULES, 'utf-8')
    assert(b < 700, `preamble too long (${b} bytes) — eats cache budget`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
