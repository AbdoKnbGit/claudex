/**
 * OpenAI-Compatible Lane — Tool Registry
 *
 * Clean, standard tool names that work well with any model trained on
 * OpenAI's function-calling format. DeepSeek, Groq, NIM, Ollama,
 * OpenRouter, Mistral, xAI, etc. all speak this format.
 *
 * Tool names are deliberately generic and descriptive — these models
 * don't have a specific CLI they were trained against, so clear names
 * that match common coding-assistant patterns work best.
 */

import type { LaneToolRegistration } from '../types.js'

export const OPENAI_COMPAT_TOOL_REGISTRY: LaneToolRegistration[] = [
  {
    nativeName: 'execute_command',
    implId: 'Bash',
    nativeDescription: 'Execute a shell command and return its output.',
    nativeSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        description: { type: 'string', description: 'Brief description of what the command does.' },
      },
      required: ['command'],
    },
    adaptInput(native) {
      return { command: native.command, ...(native.description && { description: native.description }) }
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  {
    nativeName: 'read_file',
    implId: 'Read',
    nativeDescription: 'Read the contents of a file.',
    nativeSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        start_line: { type: 'number', description: 'Start line (1-based). Optional.' },
        end_line: { type: 'number', description: 'End line (1-based, inclusive). Optional.' },
      },
      required: ['path'],
    },
    adaptInput(native) {
      const result: Record<string, unknown> = { file_path: native.path }
      if (native.start_line != null) {
        result.offset = (native.start_line as number) - 1
        if (native.end_line != null) {
          result.limit = (native.end_line as number) - (native.start_line as number) + 1
        }
      }
      return result
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  {
    nativeName: 'write_file',
    implId: 'Write',
    nativeDescription: 'Write content to a file. Creates the file if it does not exist.',
    nativeSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        content: { type: 'string', description: 'The complete file content to write.' },
      },
      required: ['path', 'content'],
    },
    adaptInput(native) {
      return { file_path: native.path, content: native.content }
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  {
    nativeName: 'edit_file',
    implId: 'Edit',
    nativeDescription: 'Replace text in a file. The old_text must match exactly.',
    nativeSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        old_text: { type: 'string', description: 'The exact text to find and replace.' },
        new_text: { type: 'string', description: 'The replacement text.' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    adaptInput(native) {
      return { file_path: native.path, old_string: native.old_text, new_string: native.new_text }
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  {
    nativeName: 'find_files',
    implId: 'Glob',
    nativeDescription: 'Find files matching a glob pattern.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts").' },
        directory: { type: 'string', description: 'Directory to search in.' },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      return { pattern: native.pattern, ...(native.directory && { path: native.directory }) }
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  {
    nativeName: 'search_text',
    implId: 'Grep',
    nativeDescription: 'Search for a regex pattern in file contents.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for.' },
        directory: { type: 'string', description: 'Directory to search in.' },
        file_pattern: { type: 'string', description: 'Glob to filter files (e.g., "*.py").' },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      return {
        pattern: native.pattern,
        ...(native.directory && { path: native.directory }),
        ...(native.file_pattern && { glob: native.file_pattern }),
      }
    },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
  {
    nativeName: 'web_search',
    implId: 'WebSearch',
    nativeDescription: 'Search the web.',
    nativeSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
    adaptInput(native) { return { query: native.query } },
    adaptOutput(output) { return typeof output === 'string' ? output : JSON.stringify(output) },
  },
]

// ─── Exports ─────────────────────────────────────────────────────

export function buildOpenAICompatFunctions(): Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
}> {
  return OPENAI_COMPAT_TOOL_REGISTRY.map(r => ({
    name: r.nativeName, description: r.nativeDescription, parameters: r.nativeSchema,
  }))
}

const _byName = new Map<string, LaneToolRegistration>()
function idx(): void {
  if (_byName.size > 0) return
  for (const r of OPENAI_COMPAT_TOOL_REGISTRY) _byName.set(r.nativeName, r)
}

export function resolveToolCall(
  name: string, args: Record<string, unknown>,
): { implId: string; input: Record<string, unknown> } | null {
  idx()
  const r = _byName.get(name)
  if (!r) return null
  return { implId: r.implId, input: r.adaptInput(args) }
}

export function formatToolResult(name: string, output: string | unknown): string {
  idx()
  const r = _byName.get(name)
  if (!r) return typeof output === 'string' ? output : JSON.stringify(output)
  return r.adaptOutput(output)
}
