/**
 * Per-provider transformer regression tests.
 *
 * Every transformer in the registry must:
 *   - Declare an id that matches its registry key.
 *   - Expose a defaultBaseUrl that looks like an HTTPS(S)/http URL.
 *   - Implement all 8 required methods (compile-time via the interface,
 *     behavioral here).
 *   - Produce a sensible schemaDropList (contains the universal '$schema').
 *   - Produce a non-empty contextExceededMarkers list.
 *   - Return a valid edit-format + cache-control mode.
 *
 * Plus a few targeted checks that guard against the specific quirks
 * each transformer is supposed to fix:
 *   - DeepSeek clamps max_tokens at 8192.
 *   - Groq normalizes reasoning → reasoning_content on the delta.
 *   - Mistral rewrites tool_choice: "required" → "any".
 *   - NIM deletes stream_options.
 *   - Ollama deletes stream_options.
 *   - OpenRouter emits HTTP-Referer + X-Title headers.
 *
 * Run:  bun run src/lanes/openai-compat/transformers.test.ts
 */

import { TRANSFORMERS, getTransformer } from './transformers/index.js'
import type { Transformer, TransformContext } from './transformers/base.js'
import type { OpenAIChatRequest } from './transformers/shared_types.js'
import { selectEditToolSet, OPENAI_COMPAT_TOOL_REGISTRY } from './tools.js'
import { resolveEditFormat, resolveCapabilities } from './capabilities.js'

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

function mkCtx(model: string, isReasoning = false): TransformContext {
  return { model, isReasoning, reasoningEffort: isReasoning ? 'medium' : null }
}

function mkBody(model: string, overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 4096,
    ...overrides,
  }
}

function main(): void {
  console.log('openai-compat transformers:')

  // ── Registry invariants ─────────────────────────────────────────
  const ids: Array<Transformer['id']> = [
    'deepseek', 'groq', 'mistral', 'nim', 'ollama', 'openrouter', 'generic',
  ]
  for (const id of ids) {
    test(`registry has ${id}`, () => {
      const t = TRANSFORMERS[id]
      assert(t != null, `missing ${id}`)
      assert(t.id === id, `id mismatch: got ${t.id}`)
      assert(/^https?:\/\//.test(t.defaultBaseUrl),
        `invalid defaultBaseUrl: ${t.defaultBaseUrl}`)
    })
  }

  for (const id of ids) {
    test(`${id} schemaDropList contains $schema`, () => {
      const drop = TRANSFORMERS[id].schemaDropList()
      assert(drop.has('$schema'), `${id} drop list missing $schema`)
    })
    test(`${id} contextExceededMarkers non-empty`, () => {
      const m = TRANSFORMERS[id].contextExceededMarkers()
      assert(Array.isArray(m) && m.length > 0, `${id} missing PTL markers`)
    })
  }

  // ── DeepSeek max_tokens clamp ───────────────────────────────────
  test('deepseek clamps max_tokens at 8192', () => {
    assert(TRANSFORMERS.deepseek.clampMaxTokens(16000) === 8192, 'no clamp')
    assert(TRANSFORMERS.deepseek.clampMaxTokens(4096) === 4096, 'unnecessary clamp')
  })
  test('deepseek sets thinking: enabled when reasoning requested', () => {
    const body = mkBody('deepseek-reasoner')
    TRANSFORMERS.deepseek.transformRequest(body, mkCtx('deepseek-reasoner', true))
    assert(body.thinking?.type === 'enabled', `thinking not set; body.thinking=${JSON.stringify(body.thinking)}`)
  })

  // ── Groq quirks ─────────────────────────────────────────────────
  test('groq normalizes reasoning → reasoning_content', () => {
    const delta: Record<string, unknown> = { reasoning: 'thinking hard' }
    TRANSFORMERS.groq.normalizeStreamDelta?.(delta as any, null)
    assert(delta['reasoning_content'] === 'thinking hard',
      `expected reasoning_content to be filled, got ${JSON.stringify(delta)}`)
  })
  test('groq adds reasoning_effort when reasoning requested', () => {
    const body = mkBody('llama-3.3-70b-reasoning')
    TRANSFORMERS.groq.transformRequest(body, mkCtx('llama-3.3-70b-reasoning', true))
    assert(body.reasoning_effort === 'medium', `reasoning_effort=${body.reasoning_effort}`)
  })
  test('groq drops additionalProperties from schema', () => {
    const drop = TRANSFORMERS.groq.schemaDropList()
    assert(drop.has('additionalProperties'), 'groq should drop additionalProperties')
  })

  // ── Mistral quirks ──────────────────────────────────────────────
  test('mistral rewrites tool_choice required → any', () => {
    const body = mkBody('mistral-large', { tool_choice: 'required' })
    TRANSFORMERS.mistral.transformRequest(body, mkCtx('mistral-large'))
    assert(body.tool_choice === 'any', `tool_choice=${body.tool_choice}`)
  })
  test('mistral strips `name` from non-tool messages', () => {
    const body = mkBody('mistral-large')
    body.messages = [{ role: 'user', content: 'hi', name: 'alice' } as any]
    TRANSFORMERS.mistral.transformRequest(body, mkCtx('mistral-large'))
    assert(!('name' in body.messages[0]!), `name field not stripped: ${JSON.stringify(body.messages[0])}`)
  })
  test('mistral does NOT support strict mode', () => {
    assert(!TRANSFORMERS.mistral.supportsStrictMode(),
      'mistral wrongly advertises strict mode')
  })

  // ── NIM / Ollama: stream_options ────────────────────────────────
  test('nim deletes stream_options', () => {
    const body = mkBody('nvidia/llama-3.1-nemotron')
    TRANSFORMERS.nim.transformRequest(body, mkCtx('nvidia/llama-3.1-nemotron'))
    assert(body.stream_options === undefined, 'stream_options not deleted')
  })
  test('ollama deletes stream_options', () => {
    const body = mkBody('llama3')
    TRANSFORMERS.ollama.transformRequest(body, mkCtx('llama3'))
    assert(body.stream_options === undefined, 'stream_options not deleted')
  })

  // ── OpenRouter headers ──────────────────────────────────────────
  test('openrouter builds HTTP-Referer + X-Title headers', () => {
    const h = TRANSFORMERS.openrouter.buildHeaders?.('sk-or-v1-xxx') ?? {}
    assert('HTTP-Referer' in h, 'HTTP-Referer header missing')
    assert('X-Title' in h, 'X-Title header missing')
  })
  test('openrouter cache-control mode is last-only for Claude models', () => {
    assert(
      TRANSFORMERS.openrouter.cacheControlMode('anthropic/claude-sonnet-4-6') === 'last-only',
      'wanted last-only for Claude routing',
    )
  })
  test('openrouter cache-control mode is none for non-Anthropic models', () => {
    assert(
      TRANSFORMERS.openrouter.cacheControlMode('meta-llama/llama-3.3-70b-instruct') === 'none',
      'wanted none for Llama routing',
    )
  })

  // ── Edit-format resolver + tool-set selection ───────────────────
  test('DeepSeek-Coder resolves to edit_block', () => {
    const caps = resolveCapabilities('deepseek', 'deepseek-coder-v3')
    assert(caps.editFormat === 'edit_block', `got ${caps.editFormat}`)
  })
  test('Llama-3.3 resolves to edit_block', () => {
    const caps = resolveCapabilities('groq', 'llama-3.3-70b-versatile')
    assert(caps.editFormat === 'edit_block', `got ${caps.editFormat}`)
  })
  test('Gemma resolves to str_replace', () => {
    const caps = resolveCapabilities('ollama', 'gemma-7b')
    assert(caps.editFormat === 'str_replace', `got ${caps.editFormat}`)
  })
  test('resolveEditFormat falls back to provider default', () => {
    // A random model with no per-model override → whatever provider says.
    const f = resolveEditFormat('mistral', 'unknown-model-xyz', 'str_replace')
    assert(f === 'str_replace', `got ${f}`)
  })
  test('selectEditToolSet exposes str_replace when preferred', () => {
    const tools = selectEditToolSet('str_replace')
    const names = tools.map(t => t.nativeName)
    assert(names.includes('str_replace'), 'str_replace missing')
    assert(!names.includes('edit_block'), 'edit_block should be filtered out')
    assert(!names.includes('edit_file'), 'edit_file should be filtered out')
  })
  test('selectEditToolSet exposes edit_block when preferred', () => {
    const tools = selectEditToolSet('edit_block')
    const names = tools.map(t => t.nativeName)
    assert(names.includes('edit_block'), 'edit_block missing')
    assert(!names.includes('str_replace'), 'str_replace should be filtered out')
  })
  test('selectEditToolSet apply_patch falls back to str_replace', () => {
    // The compat lane can't expose apply_patch (Freeform tool type is
    // Codex-only); apply_patch requests fall back to str_replace.
    const tools = selectEditToolSet('apply_patch')
    const names = tools.map(t => t.nativeName)
    assert(names.includes('str_replace'), 'str_replace should be the fallback')
  })

  // ── Reasoning detection ─────────────────────────────────────────
  test('deepseek-r1 is reasoning-capable', () => {
    const caps = resolveCapabilities('deepseek', 'deepseek-r1')
    assert(caps.supportsReasoning, 'should support reasoning')
  })
  test('plain llama-3.1 is NOT reasoning-capable', () => {
    const caps = resolveCapabilities('groq', 'llama-3.1-8b-instant')
    assert(!caps.supportsReasoning, 'should NOT support reasoning')
  })

  // ── getTransformer fallback ─────────────────────────────────────
  test('getTransformer falls back to generic for unknown provider', () => {
    const t = getTransformer('unknown-provider-xyz' as any)
    assert(t.id === 'generic', `fallback returned ${t.id}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
