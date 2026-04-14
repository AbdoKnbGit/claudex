/**
 * Gemini Lane — Native Tool Registry
 *
 * Maps Gemini CLI's native tool names (what the model was post-trained on)
 * to ClaudeX's shared tool implementations.
 *
 * The model sees these exact names and schemas. They come from:
 *   google-gemini/gemini-cli packages/core/src/tools/definitions/
 *
 * Each registration has:
 *   - nativeName: what Gemini sees (e.g., 'read_file')
 *   - implId: shared implementation key (e.g., 'Read')
 *   - nativeSchema: JSON Schema the model was trained against
 *   - adaptInput: converts Gemini's params → shared impl params
 *   - adaptOutput: converts shared impl output → Gemini's expected format
 */

import type { LaneToolRegistration } from '../types.js'

// ─── Native Tool Definitions ─────────────────────────────────────
//
// These are the EXACT tool names and schemas from gemini-cli.
// Do not rename them. Do not add Anthropic-style tool names.
// The model was post-trained on these specific strings.

export const GEMINI_TOOL_REGISTRY: LaneToolRegistration[] = [
  // ── read_file ──────────────────────────────────────────────────
  {
    nativeName: 'read_file',
    implId: 'Read',
    nativeDescription:
      'Reads the content of a file from the local filesystem. ' +
      'Use start_line and end_line for targeted, surgical reads ' +
      'to minimize token usage on large files.',
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute or relative path to the file to read.',
        },
        start_line: {
          type: 'number',
          description: '1-based starting line number. Optional.',
        },
        end_line: {
          type: 'number',
          description: '1-based ending line number (inclusive). Optional.',
        },
      },
      required: ['file_path'],
    },
    adaptInput(native) {
      const result: Record<string, unknown> = {
        file_path: native.file_path,
      }
      // Gemini uses 1-based start_line/end_line
      // Shared Read uses 0-based offset + limit
      if (native.start_line != null) {
        result.offset = (native.start_line as number) - 1
        if (native.end_line != null) {
          result.limit = (native.end_line as number) - (native.start_line as number) + 1
        }
      }
      return result
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── write_file ─────────────────────────────────────────────────
  {
    nativeName: 'write_file',
    implId: 'Write',
    nativeDescription:
      'Writes content to a file on the local filesystem. ' +
      'Creates parent directories automatically if they don\'t exist.',
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'The complete content to write to the file.',
        },
      },
      required: ['file_path', 'content'],
    },
    adaptInput(native) {
      return { file_path: native.file_path, content: native.content }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── replace (Edit) ─────────────────────────────────────────────
  {
    nativeName: 'replace',
    implId: 'Edit',
    nativeDescription:
      'Replaces exact text in a file. Requires old_string to match ' +
      'exactly including whitespace and indentation. Include 3+ lines ' +
      'of surrounding context for unique matching.',
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to modify.',
        },
        old_string: {
          type: 'string',
          description: 'The exact literal text to replace. Must include enough context for unique matching.',
        },
        new_string: {
          type: 'string',
          description: 'The exact replacement text.',
        },
        allow_multiple: {
          type: 'boolean',
          description: 'If true, replace all occurrences. Defaults to false.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    adaptInput(native) {
      return {
        file_path: native.file_path,
        old_string: native.old_string,
        new_string: native.new_string,
        replace_all: native.allow_multiple ?? false,
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── run_shell_command (Bash) ────────────────────────────────────
  {
    nativeName: 'run_shell_command',
    implId: 'Bash',
    nativeDescription:
      'Executes a shell command. Uses bash on Unix, PowerShell on Windows.',
    nativeSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
        description: {
          type: 'string',
          description: 'A brief description of what this command does.',
        },
        dir_path: {
          type: 'string',
          description: 'Directory to run the command in. Defaults to CWD.',
        },
        is_background: {
          type: 'boolean',
          description: 'Run the command in the background.',
        },
      },
      required: ['command'],
    },
    adaptInput(native) {
      const result: Record<string, unknown> = {
        command: native.command,
      }
      if (native.description) result.description = native.description
      if (native.is_background) result.run_in_background = native.is_background
      // dir_path: the shared Bash impl uses cwd from context, but
      // if Gemini specifies dir_path we prepend a cd
      if (native.dir_path) {
        result.command = `cd ${JSON.stringify(native.dir_path)} && ${native.command}`
      }
      return result
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── glob ───────────────────────────────────────────────────────
  {
    nativeName: 'glob',
    implId: 'Glob',
    nativeDescription:
      'Finds files matching a glob pattern. Returns absolute paths ' +
      'sorted by modification time (newest first).',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., "**/*.ts", "src/**").',
        },
        dir_path: {
          type: 'string',
          description: 'Directory to search in. Defaults to project root.',
        },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      return {
        pattern: native.pattern,
        ...(native.dir_path && { path: native.dir_path }),
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── grep_search ────────────────────────────────────────────────
  {
    nativeName: 'grep_search',
    implId: 'Grep',
    nativeDescription:
      'Searches for a regex pattern in file contents. Fast, powered by ' +
      'ripgrep. Preferred over run_shell_command for code search.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for.',
        },
        dir_path: {
          type: 'string',
          description: 'Directory to search in. Defaults to CWD.',
        },
        include_pattern: {
          type: 'string',
          description: 'Glob pattern for files to include (e.g., "*.ts").',
        },
        names_only: {
          type: 'boolean',
          description: 'Return only file paths, not matching lines.',
        },
        total_max_matches: {
          type: 'integer',
          description: 'Maximum total matches. Defaults to 100.',
        },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      return {
        pattern: native.pattern,
        ...(native.dir_path && { path: native.dir_path }),
        ...(native.include_pattern && { glob: native.include_pattern }),
        ...(native.names_only && { output_mode: 'files_with_matches' }),
        ...(native.total_max_matches && { head_limit: native.total_max_matches }),
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── google_web_search ──────────────────────────────────────────
  {
    nativeName: 'google_web_search',
    implId: 'WebSearch',
    nativeDescription:
      'Performs a Google web search and returns a synthesized answer ' +
      'with citations.',
    nativeSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
      },
      required: ['query'],
    },
    adaptInput(native) {
      return { query: native.query }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── web_fetch ──────────────────────────────────────────────────
  {
    nativeName: 'web_fetch',
    implId: 'WebFetch',
    nativeDescription:
      'Fetches and processes content from one or more URLs. Supports ' +
      'up to 20 URLs. GitHub blob URLs are auto-converted to raw.',
    nativeSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'URL(s) and instructions on how to process the content.',
        },
      },
      required: ['prompt'],
    },
    adaptInput(native) {
      // Shared WebFetch expects { url, prompt } — extract URL from prompt
      const urlMatch = (native.prompt as string).match(/https?:\/\/[^\s]+/)
      return {
        url: urlMatch ? urlMatch[0] : native.prompt,
        prompt: native.prompt,
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── list_directory ─────────────────────────────────────────────
  // Gemini-specific tool — no direct ClaudeX equivalent. Maps to Bash ls.
  {
    nativeName: 'list_directory',
    implId: 'Bash',
    nativeDescription: 'Lists files and subdirectories in a directory.',
    nativeSchema: {
      type: 'object',
      properties: {
        dir_path: {
          type: 'string',
          description: 'Directory path to list.',
        },
      },
      required: ['dir_path'],
    },
    adaptInput(native) {
      return { command: `ls -la ${JSON.stringify(native.dir_path)}` }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── ask_user ───────────────────────────────────────────────────
  {
    nativeName: 'ask_user',
    implId: 'AskUserQuestion',
    nativeDescription:
      'Asks the user one or more questions to gather preferences or ' +
      'clarify requirements. Prefer multiple-choice with descriptions.',
    nativeSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question text.' },
              header: { type: 'string', description: 'Short label.' },
              type: {
                type: 'string',
                enum: ['choice', 'text', 'yesno'],
              },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label', 'description'],
                },
              },
            },
            required: ['question', 'header', 'type'],
          },
          minItems: 1,
          maxItems: 4,
        },
      },
      required: ['questions'],
    },
    adaptInput(native) {
      // Shared AskUserQuestion expects a single question string
      const questions = native.questions as Array<{ question: string }>
      return { question: questions.map(q => q.question).join('\n') }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── enter_plan_mode ────────────────────────────────────────────
  {
    nativeName: 'enter_plan_mode',
    implId: 'EnterPlanMode',
    nativeDescription:
      'Switch to Plan Mode for safe research and design using read-only tools.',
    nativeSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Reason for entering plan mode.',
        },
      },
    },
    adaptInput(native) {
      return { reason: native.reason }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── exit_plan_mode ─────────────────────────────────────────────
  {
    nativeName: 'exit_plan_mode',
    implId: 'ExitPlanMode',
    nativeDescription:
      'Exits Plan Mode and transitions to implementation after user approval.',
    nativeSchema: {
      type: 'object',
      properties: {
        plan_filename: {
          type: 'string',
          description: 'Filename of the finalized plan.',
        },
      },
      required: ['plan_filename'],
    },
    adaptInput(native) {
      return { plan_filename: native.plan_filename }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── save_memory ────────────────────────────────────────────────
  // Gemini-specific. Maps to a file write to the memory directory.
  {
    nativeName: 'save_memory',
    implId: 'Bash',
    nativeDescription:
      'Saves a fact or preference that persists across sessions.',
    nativeSchema: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description: 'The fact to remember.',
        },
        scope: {
          type: 'string',
          enum: ['global', 'project'],
          description: 'global = all workspaces, project = current workspace only.',
        },
      },
      required: ['fact'],
    },
    adaptInput(native) {
      // Map to an echo-append to the appropriate memory file
      const scope = (native.scope as string) || 'project'
      const target = scope === 'global' ? '~/.gemini/memory.md' : '.gemini/memory.md'
      return {
        command: `mkdir -p "$(dirname ${target})" && echo ${JSON.stringify(native.fact)} >> ${target}`,
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : 'Memory saved.'
    },
  },
]

// ─── Lookup Helpers ──────────────────────────────────────────────

const _byNativeName = new Map<string, LaneToolRegistration>()
const _byImplId = new Map<string, LaneToolRegistration[]>()

function _ensureIndexed(): void {
  if (_byNativeName.size > 0) return
  for (const reg of GEMINI_TOOL_REGISTRY) {
    _byNativeName.set(reg.nativeName, reg)
    const list = _byImplId.get(reg.implId) ?? []
    list.push(reg)
    _byImplId.set(reg.implId, list)
  }
}

/** Look up a registration by native tool name (what the model calls). */
export function getRegistrationByNativeName(name: string): LaneToolRegistration | undefined {
  _ensureIndexed()
  return _byNativeName.get(name)
}

/** Look up registrations by shared implementation ID. */
export function getRegistrationsByImplId(implId: string): LaneToolRegistration[] {
  _ensureIndexed()
  return _byImplId.get(implId) ?? []
}

/**
 * Build Gemini-format function declarations from the registry.
 * This is what gets sent in the API request's `tools` field.
 */
export function buildGeminiFunctionDeclarations(): Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
}> {
  return GEMINI_TOOL_REGISTRY.map(reg => ({
    name: reg.nativeName,
    description: reg.nativeDescription,
    parameters: reg.nativeSchema,
  }))
}

/**
 * Convert a native Gemini tool call into a shared-layer executeTool() call.
 * Returns { implId, input } ready for context.executeTool().
 */
export function resolveToolCall(
  nativeName: string,
  nativeArgs: Record<string, unknown>,
): { implId: string; input: Record<string, unknown> } | null {
  const reg = getRegistrationByNativeName(nativeName)
  if (!reg) return null
  return {
    implId: reg.implId,
    input: reg.adaptInput(nativeArgs),
  }
}

/**
 * Format a tool result back into Gemini's expected shape.
 */
export function formatToolResult(
  nativeName: string,
  output: string | unknown,
): string {
  const reg = getRegistrationByNativeName(nativeName)
  if (!reg) return typeof output === 'string' ? output : JSON.stringify(output)
  return reg.adaptOutput(output)
}
