/**
 * Records the parameter schema of every tool that goes out to a non-Anthropic
 * provider so that, on the way back, we can repair model output that arrived
 * shaped wrong (e.g. a JSON-encoded string for a parameter the schema declares
 * as `array` or `object`).
 *
 * Inspired by the antigravity / CLIProxyAPI approach: the model sometimes
 * stringifies structured args. Without the original schema, the inbound
 * adapter has no way to know whether to JSON.parse a string. The cache is
 * populated at outbound time (in each anthropic_to_<provider> adapter) and
 * consulted at inbound time (in each <provider>_to_anthropic adapter).
 *
 * Last-write-wins: the same tool name within the same session/process
 * overwrites prior entries so updated schemas take precedence.
 */

export interface SchemaInfo {
  type: string
  items?: SchemaInfo
  properties?: Record<string, SchemaInfo>
}

const cache = new Map<string, Map<string, SchemaInfo>>()

function normalizeType(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const nonNull = value.filter(t => t !== 'null')
    const first = nonNull[0] ?? value[0]
    if (typeof first === 'string') return first
  }
  return 'unknown'
}

function extract(schema: unknown): SchemaInfo {
  if (!schema || typeof schema !== 'object') return { type: 'unknown' }
  const record = schema as Record<string, unknown>
  const type = normalizeType(record.type)
  const info: SchemaInfo = { type }

  if (type === 'array' && record.items) {
    info.items = extract(record.items)
  } else if (type === 'object' && record.properties && typeof record.properties === 'object') {
    info.properties = {}
    for (const [key, value] of Object.entries(record.properties as Record<string, unknown>)) {
      info.properties[key] = extract(value)
    }
  }

  return info
}

/**
 * Records the parameter shape for a tool, keyed by name. Pass the JSON Schema
 * object that has `properties`. Stores nothing for tools without properties
 * but still records the name so repeated calls don't surprise the caller.
 */
export function recordToolSchema(toolName: string, schema: unknown): void {
  if (!toolName) return
  const properties =
    schema && typeof schema === 'object'
      ? (schema as Record<string, unknown>).properties
      : undefined

  const params = new Map<string, SchemaInfo>()
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, paramSchema] of Object.entries(properties as Record<string, unknown>)) {
      params.set(name, extract(paramSchema))
    }
  }
  cache.set(toolName, params)
}

/** Returns the recorded type for a single parameter (e.g. "array", "object"). */
export function getParamType(toolName: string, paramName: string): string | undefined {
  return cache.get(toolName)?.get(paramName)?.type
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 2) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  return (first === '{' && last === '}') || (first === '[' && last === ']')
}

/**
 * Walks a tool-call args object and JSON-parses string values whose schema
 * declares them as `array` or `object`. Leaves everything else untouched.
 * Returns the original reference when no coercion was needed.
 */
export function coerceToolCallArgs(toolName: string, args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const params = cache.get(toolName)
  if (!params || params.size === 0) return args

  const record = args as Record<string, unknown>
  let mutated = false
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    const expected = params.get(key)?.type
    if (
      typeof value === 'string' &&
      (expected === 'array' || expected === 'object') &&
      looksLikeJson(value)
    ) {
      try {
        next[key] = JSON.parse(value)
        mutated = true
        continue
      } catch {
        // fall through and keep the original string
      }
    }
    next[key] = value
  }

  return mutated ? next : args
}

/** Test-only / shutdown helper. */
export function clearToolSchemaCache(): void {
  cache.clear()
}
