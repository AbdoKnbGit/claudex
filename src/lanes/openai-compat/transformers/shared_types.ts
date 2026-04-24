/**
 * Wire-format types shared between the lane's loop.ts and its per-
 * provider transformers. Keeping them in a separate module breaks a
 * potential circular dep between loop.ts and the transformers.
 */

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null | Array<{ type: string; text?: string; image_url?: unknown }>
  reasoning_content?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIChatMessage[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
      strict?: boolean
    }
  }>
  tool_choice?: 'auto' | 'required' | 'none' | 'any' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  reasoning_effort?: 'low' | 'medium' | 'high'
  reasoning?: { effort?: string }
  thinking?: { type: 'enabled' } | { type: 'disabled' }
  extra_body?: Record<string, unknown>
  transforms?: string[]
  models?: string[]
  route?: string
  prompt_cache_key?: string
}
