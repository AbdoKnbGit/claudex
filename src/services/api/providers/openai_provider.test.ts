/**
 * OpenAI provider model catalog invariants.
 *
 * Run: bun run src/services/api/providers/openai_provider.test.ts
 */

import { OpenAIProvider } from './openai_provider.js'

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
  console.log('openai provider:')

  const originalFetch = globalThis.fetch
  try {
    await test('merges curated Codex models into successful live model list', async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({
          data: [
            { id: 'gpt-4.1' },
            { id: 'o3' },
          ],
        }), { status: 200 })) as typeof fetch

      const provider = new OpenAIProvider({ apiKey: 'test-key' })
      const models = await provider.listModels()
      const gpt55 = models.find(model => model.id === 'gpt-5.5')

      assert(gpt55, 'expected gpt-5.5 in OpenAI /models catalog')
      assert(gpt55?.name === 'GPT-5.5', 'expected curated display name')
      assert(gpt55?.contextWindow === 272000, 'expected codex-main context window')
      assert(gpt55?.tags?.includes('recommended'), 'expected recommended tag')
      assert(models.some(model => model.id === 'gpt-4.1'), 'expected live API models to remain visible')
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
