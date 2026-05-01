/**
 * Copilot cache-affinity infrastructure tests.
 *
 * Run: bun run src/lanes/openai-compat/copilot_cache.test.ts
 */

import { OpenAICompatLane } from './loop.js'
import type { AnthropicStreamEvent, ProviderMessage } from '../../services/api/providers/base_provider.js'

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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

type CapturedRequest = {
  url: string
  headers: Record<string, string>
  body: Record<string, any>
}

async function captureCopilotRequest(
  sessionId?: string,
  messages: ProviderMessage[] = [{ role: 'user', content: 'hello' }],
): Promise<{
  request: CapturedRequest
  events: AnthropicStreamEvent[]
}> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('copilot', 'copilot-token', 'https://api.githubcopilot.com')

  const oldFetch = globalThis.fetch
  let request: CapturedRequest | null = null

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    }
    const sse = [
      {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        model: 'gpt-5.2',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        model: 'gpt-5.2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: {
            cached_tokens: 70,
            cache_write_tokens: 20,
          },
        },
      },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'

    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = lane.streamAsProvider({
      model: 'gpt-5.2',
      messages,
      system: 'stable system prompt',
      tools: [],
      max_tokens: 128,
      signal: new AbortController().signal,
      sessionId,
      providerHint: 'copilot',
    })

    for await (const ev of stream) events.push(ev)
    assert(request !== null, 'fetch was not called')
    return { request, events }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('copilot')
  }
}

async function captureOpenRouterRequestWithSessionId(cacheRetention?: string): Promise<{
  request: CapturedRequest
  events: AnthropicStreamEvent[]
}> {
  const oldClaudexRetention = process.env.CLAUDEX_OPENROUTER_CACHE_RETENTION
  const oldOpenRouterRetention = process.env.OPENROUTER_CACHE_RETENTION
  if (cacheRetention === undefined) {
    delete process.env.CLAUDEX_OPENROUTER_CACHE_RETENTION
    delete process.env.OPENROUTER_CACHE_RETENTION
  } else {
    process.env.CLAUDEX_OPENROUTER_CACHE_RETENTION = cacheRetention
    delete process.env.OPENROUTER_CACHE_RETENTION
  }

  const lane = new OpenAICompatLane()
  lane.registerProvider('openrouter', 'openrouter-token', 'https://openrouter.ai/api/v1')

  const oldFetch = globalThis.fetch
  let request: CapturedRequest | null = null

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    }
    const sse = [
      {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        model: 'meta-llama/llama-3.3-70b-instruct',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        model: 'meta-llama/llama-3.3-70b-instruct',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          total_tokens: 107,
          prompt_tokens_details: {
            cached_tokens: 80,
            cache_write_tokens: 30,
          },
        },
      },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = lane.streamAsProvider({
      model: 'meta-llama/llama-3.3-70b-instruct',
      messages: [{ role: 'user', content: 'hello' }],
      system: 'stable system prompt',
      tools: [],
      max_tokens: 128,
      signal: new AbortController().signal,
      sessionId: 'session-fixed',
      providerHint: 'openrouter',
    })

    for await (const ev of stream) events.push(ev)
    assert(request !== null, 'fetch was not called')
    return { request, events }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('openrouter')
    restoreEnv('CLAUDEX_OPENROUTER_CACHE_RETENTION', oldClaudexRetention)
    restoreEnv('OPENROUTER_CACHE_RETENTION', oldOpenRouterRetention)
  }
}

async function main(): Promise<void> {
  console.log('openai-compat cache affinity:')

  await test('sends prompt_cache_key and affinity headers from session id', async () => {
    const { request } = await captureCopilotRequest('session-fixed')
    assert(request.url === 'https://api.githubcopilot.com/chat/completions', `url=${request.url}`)
    assert(request.body.prompt_cache_key === 'session-fixed', `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.headers.session_id === 'session-fixed', `session_id=${request.headers.session_id}`)
    assert(request.headers['x-client-request-id'] === 'session-fixed',
      `x-client-request-id=${request.headers['x-client-request-id']}`)
    assert(request.headers['x-session-affinity'] === 'session-fixed',
      `x-session-affinity=${request.headers['x-session-affinity']}`)
  })

  await test('does not send cache key when session id is absent', async () => {
    const { request } = await captureCopilotRequest()
    assert(request.body.prompt_cache_key === undefined, `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.headers.session_id === undefined, `session_id=${request.headers.session_id}`)
  })

  await test('splits cache read and cache write usage buckets', async () => {
    const { events } = await captureCopilotRequest('session-fixed')
    const finalDelta = events.findLast(ev => ev.type === 'message_delta')
    assert(finalDelta?.usage?.input_tokens === 30, `input_tokens=${finalDelta?.usage?.input_tokens}`)
    assert(finalDelta?.usage?.cache_read_input_tokens === 50,
      `cache_read_input_tokens=${finalDelta?.usage?.cache_read_input_tokens}`)
    assert(finalDelta?.usage?.cache_creation_input_tokens === 20,
      `cache_creation_input_tokens=${finalDelta?.usage?.cache_creation_input_tokens}`)
  })

  await test('repairs unresolved tool calls before sending Copilot request', async () => {
    const { request } = await captureCopilotRequest('session-fixed', [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_compat_call_answered', name: 'Read', input: {} },
          { type: 'tool_use', id: 'toolu_compat_call_missing', name: 'Grep', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_compat_call_answered', content: 'ok' },
        ],
      },
      { role: 'user', content: 'continue' },
    ])

    const assistant = request.body.messages.find((message: any) => message.role === 'assistant')
    const toolMessages = request.body.messages.filter((message: any) => message.role === 'tool')
    assert(assistant?.tool_calls?.length === 1,
      `tool_calls=${JSON.stringify(assistant?.tool_calls)}`)
    assert(assistant.tool_calls[0].id === 'toolu_compat_call_answered',
      `tool_call_id=${assistant.tool_calls[0].id}`)
    assert(toolMessages.length === 1, `tool_messages=${JSON.stringify(toolMessages)}`)
    assert(toolMessages[0].tool_call_id === 'toolu_compat_call_answered',
      `tool_call_id=${toolMessages[0].tool_call_id}`)
  })

  await test('sends OpenRouter cache key without Copilot affinity headers', async () => {
    const { request } = await captureOpenRouterRequestWithSessionId()
    assert(request.body.prompt_cache_key === 'session-fixed', `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.body.prompt_cache_retention === undefined,
      `prompt_cache_retention=${request.body.prompt_cache_retention}`)
    assert(request.headers.session_id === undefined, `session_id=${request.headers.session_id}`)
    assert(request.headers['x-client-request-id'] === undefined,
      `x-client-request-id=${request.headers['x-client-request-id']}`)
    assert(request.headers['x-session-affinity'] === undefined,
      `x-session-affinity=${request.headers['x-session-affinity']}`)
  })

  await test('normalizes OpenRouter cache read and write usage', async () => {
    const { events } = await captureOpenRouterRequestWithSessionId()
    const usageDelta = events.find((ev: any) =>
      ev.type === 'message_delta' && ev.usage?.output_tokens === 7
    ) as any
    assert(usageDelta !== undefined, `events=${JSON.stringify(events)}`)
    assert(usageDelta.usage.input_tokens === 20, `input_tokens=${usageDelta.usage.input_tokens}`)
    assert(usageDelta.usage.cache_read_input_tokens === 50,
      `cache_read_input_tokens=${usageDelta.usage.cache_read_input_tokens}`)
    assert(usageDelta.usage.cache_creation_input_tokens === 30,
      `cache_creation_input_tokens=${usageDelta.usage.cache_creation_input_tokens}`)
  })

  await test('can opt OpenRouter into long cache retention', async () => {
    const { request } = await captureOpenRouterRequestWithSessionId('long')
    assert(request.body.prompt_cache_key === 'session-fixed', `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.body.prompt_cache_retention === '24h',
      `prompt_cache_retention=${request.body.prompt_cache_retention}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
