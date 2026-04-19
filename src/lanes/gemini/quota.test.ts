/**
 * Gemini quota classifier unit tests.
 *
 * Validates the Google-error-body parser + classifier against real-shape
 * response payloads captured from gemini-cli behavior docs and from
 * antigravity forums (scrubbed). The classifier is load-bearing for the
 * 403 stale-project re-onboard fix and for rotation.
 *
 * Run:  bun run src/lanes/gemini/quota.test.ts
 */

import {
  classifyGeminiError,
  parseGoogleErrorDetails,
  isReonboardCase,
  isRotationCase,
} from './quota.js'

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
  console.log('quota classifier:')

  // ── 403 stale-project → auth-stale (the original bug) ────────────
  test('403 cloudaicompanion → auth-stale + reonboard case', () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: 'User does not have permission to access cloudaicompanion project.',
        status: 'PERMISSION_DENIED',
      },
    })
    const cls = classifyGeminiError(403, body)
    assert(cls.kind === 'auth-stale', `wanted auth-stale, got ${cls.kind}`)
    assert(isReonboardCase(cls), 'should be a reonboard case')
  })

  test('403 "project might not exist" → auth-stale', () => {
    const body = '{"error":{"code":403,"message":"The project might not exist."}}'
    const cls = classifyGeminiError(403, body)
    assert(cls.kind === 'auth-stale', `wanted auth-stale, got ${cls.kind}`)
  })

  // ── 403 with insufficient credits → terminal-quota ──────────────
  test('403 INSUFFICIENT_G1_CREDITS_BALANCE → terminal-quota', () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: 'Credits exhausted',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'INSUFFICIENT_G1_CREDITS_BALANCE',
            domain: 'cloudcode-pa.googleapis.com',
          },
        ],
      },
    })
    const cls = classifyGeminiError(403, body)
    assert(cls.kind === 'terminal-quota', `wanted terminal-quota, got ${cls.kind}`)
    assert(isRotationCase(cls), 'should be a rotation case')
    assert(cls.details.insufficientCredits === true, 'should mark insufficientCredits')
  })

  // ── 429 rate-limit → retryable-quota + rotation ─────────────────
  test('429 with RetryInfo → retryable-quota with retryAfterMs', () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'Rate limit exceeded',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '42s',
          },
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              { subject: 'project/foo', description: 'RPM exceeded' },
            ],
          },
        ],
      },
    })
    const cls = classifyGeminiError(429, body)
    assert(cls.kind === 'retryable-quota', `wanted retryable-quota, got ${cls.kind}`)
    assert(cls.retryAfterMs === 42_000, `retryAfterMs wrong: ${cls.retryAfterMs}`)
    assert(isRotationCase(cls), 'should be a rotation case')
    assert(cls.details.quotaFailures && cls.details.quotaFailures.length === 1, 'quotaFailures missing')
  })

  // ── 400 with token-limit body → prompt-too-long ─────────────────
  test('400 with "prompt is too long" body → prompt-too-long', () => {
    const body = '{"error":{"code":400,"message":"The prompt is too long. Try reducing context."}}'
    const cls = classifyGeminiError(400, body)
    assert(cls.kind === 'prompt-too-long', `wanted prompt-too-long, got ${cls.kind}`)
  })

  test('400 with "token limit" body → prompt-too-long', () => {
    const body = 'context exceeds the token limit of 1048576'
    const cls = classifyGeminiError(400, body)
    assert(cls.kind === 'prompt-too-long', `wanted prompt-too-long, got ${cls.kind}`)
  })

  // ── 400 generic → non-retryable ─────────────────────────────────
  test('400 malformed request → non-retryable', () => {
    const body = '{"error":{"code":400,"message":"Invalid request: missing field"}}'
    const cls = classifyGeminiError(400, body)
    assert(cls.kind === 'non-retryable', `wanted non-retryable, got ${cls.kind}`)
  })

  // ── 500/503 → transient ─────────────────────────────────────────
  test('500 → transient', () => {
    const cls = classifyGeminiError(500, '{"error":{"code":500,"message":"Internal"}}')
    assert(cls.kind === 'transient', `wanted transient, got ${cls.kind}`)
  })

  test('503 → transient', () => {
    const cls = classifyGeminiError(503, 'Service Unavailable')
    assert(cls.kind === 'transient', `wanted transient, got ${cls.kind}`)
  })

  // ── 503 "No capacity" UNAVAILABLE → retryable-quota (rotates accounts) ──
  test('503 "No capacity" UNAVAILABLE → retryable-quota', () => {
    const body = JSON.stringify({
      error: {
        code: 503,
        message: 'No capacity available for model gemini-3.1-pro-high on the server',
        status: 'UNAVAILABLE',
      },
    })
    const cls = classifyGeminiError(503, body)
    assert(cls.kind === 'retryable-quota', `wanted retryable-quota, got ${cls.kind}`)
    assert(isRotationCase(cls), 'should rotate accounts on retry')
  })

  test('503 RESOURCE_EXHAUSTED → retryable-quota', () => {
    const body = JSON.stringify({
      error: {
        code: 503,
        message: 'Quota exceeded',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'RESOURCE_EXHAUSTED',
        }],
      },
    })
    const cls = classifyGeminiError(503, body)
    assert(cls.kind === 'retryable-quota', `wanted retryable-quota, got ${cls.kind}`)
  })

  // ── Validation-required flow ────────────────────────────────────
  test('403 with Help.validationLink → validation-required', () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: 'Please validate your account',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.Help',
            links: [
              {
                description: 'Validate your account',
                url: 'https://antigravity.google.com/validate',
              },
            ],
          },
        ],
      },
    })
    const cls = classifyGeminiError(403, body)
    assert(cls.kind === 'validation-required', `wanted validation-required, got ${cls.kind}`)
    assert(cls.details.validationLink?.startsWith('https://'), 'validationLink missing')
  })

  // ── 401 → auth-stale ────────────────────────────────────────────
  test('401 → auth-stale', () => {
    const cls = classifyGeminiError(401, '{"error":{"code":401,"message":"Unauthorized"}}')
    assert(cls.kind === 'auth-stale', `wanted auth-stale, got ${cls.kind}`)
  })

  // ── Body parser robustness ──────────────────────────────────────
  test('parseGoogleErrorDetails empty body → {}', () => {
    const d = parseGoogleErrorDetails('')
    assert(Object.keys(d).length === 0, 'should be empty')
  })
  test('parseGoogleErrorDetails malformed JSON → {}', () => {
    const d = parseGoogleErrorDetails('not json at all')
    assert(Object.keys(d).length === 0, 'should be empty')
  })
  test('parseGoogleErrorDetails retryDelay "1.500s" → 1500ms', () => {
    const body = JSON.stringify({
      error: {
        details: [{
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '1.500s',
        }],
      },
    })
    const d = parseGoogleErrorDetails(body)
    assert(d.retryDelaySeconds === 1.5, `got ${d.retryDelaySeconds}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
