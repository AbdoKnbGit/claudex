/**
 * Codex Lane — Native Tool Registry
 *
 * Maps OpenAI Codex CLI's native tool names to shared implementations.
 * The critical difference: Codex uses `apply_patch` (unified diff) instead
 * of Edit (old_string/new_string). This is what GPT-5 and Codex models
 * were specifically post-trained on.
 *
 * Tool names from: openai/codex codex-rs/core
 */

import type { LaneToolRegistration } from '../types.js'

export const CODEX_TOOL_REGISTRY: LaneToolRegistration[] = [
  // ── shell ──────────────────────────────────────────────────────
  {
    nativeName: 'shell',
    implId: 'Bash',
    nativeDescription:
      'Execute a shell command. Use for running programs, installing ' +
      'packages, running tests, git operations, and any system tasks.',
    nativeSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
      },
      required: ['command'],
    },
    adaptInput(native) {
      return { command: native.command }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── apply_patch ────────────────────────────────────────────────
  // THE key differentiator for the Codex lane. GPT-5/Codex was
  // specifically trained against this tool, not against Edit.
  {
    nativeName: 'apply_patch',
    implId: 'Edit',
    nativeDescription:
      'Apply a unified diff patch to one or more files. The patch must ' +
      'be in standard unified diff format with correct context lines. ' +
      'Use this for all file modifications — do not use shell commands ' +
      'like sed or awk for editing.',
    nativeSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description: 'The unified diff patch to apply. Must include file headers (--- a/path, +++ b/path) and hunks with correct context.',
        },
      },
      required: ['patch'],
    },
    adaptInput(native) {
      // Parse unified diff into Edit's old_string/new_string format.
      // This bridges Codex's apply_patch to the shared Edit impl.
      return parsePatchToEdit(native.patch as string)
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── read_file ──────────────────────────────────────────────────
  {
    nativeName: 'read_file',
    implId: 'Read',
    nativeDescription: 'Read the contents of a file.',
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to read.',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (0-based).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read.',
        },
      },
      required: ['file_path'],
    },
    adaptInput(native) {
      return {
        file_path: native.file_path,
        ...(native.offset != null && { offset: native.offset }),
        ...(native.limit != null && { limit: native.limit }),
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── write_file ─────────────────────────────────────────────────
  {
    nativeName: 'write_file',
    implId: 'Write',
    nativeDescription: 'Create a new file or overwrite an existing file with the given content.',
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'The complete file content.',
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

  // ── list_directory ─────────────────────────────────────────────
  {
    nativeName: 'list_directory',
    implId: 'Bash',
    nativeDescription: 'List the contents of a directory.',
    nativeSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list.',
        },
      },
      required: ['path'],
    },
    adaptInput(native) {
      return { command: `ls -la ${JSON.stringify(native.path)}` }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── search_files ───────────────────────────────────────────────
  {
    nativeName: 'search_files',
    implId: 'Glob',
    nativeDescription: 'Find files matching a glob pattern.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., "**/*.ts").',
        },
        path: {
          type: 'string',
          description: 'Directory to search in.',
        },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      return {
        pattern: native.pattern,
        ...(native.path && { path: native.path }),
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── search_code ────────────────────────────────────────────────
  {
    nativeName: 'search_code',
    implId: 'Grep',
    nativeDescription: 'Search for a pattern in file contents using regex.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for.',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in.',
        },
        include: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g., "*.ts").',
        },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      return {
        pattern: native.pattern,
        ...(native.path && { path: native.path }),
        ...(native.include && { glob: native.include }),
      }
    },
    adaptOutput(output) {
      return typeof output === 'string' ? output : JSON.stringify(output)
    },
  },

  // ── web_search ─────────────────────────────────────────────────
  {
    nativeName: 'web_search',
    implId: 'WebSearch',
    nativeDescription: 'Search the web for information.',
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
]

// ─── apply_patch Parser ──────────────────────────────────────────
//
// Parses a unified diff into the shape the shared Edit impl expects.
// Handles single-file patches. Multi-file patches get split and the
// first hunk is applied (the loop handles the rest on subsequent turns).

function parsePatchToEdit(patch: string): Record<string, unknown> {
  const lines = patch.split('\n')
  let filePath = ''
  let oldLines: string[] = []
  let newLines: string[] = []
  let inHunk = false

  for (const line of lines) {
    if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
      filePath = line.replace(/^\+\+\+ [ab]\//, '').trim()
    } else if (line.startsWith('@@')) {
      inHunk = true
      oldLines = []
      newLines = []
    } else if (inHunk) {
      if (line.startsWith('-')) {
        oldLines.push(line.slice(1))
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1))
      } else if (line.startsWith(' ')) {
        // Context line — part of both old and new
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      }
    }
  }

  return {
    file_path: filePath,
    old_string: oldLines.join('\n'),
    new_string: newLines.join('\n'),
  }
}

// ─── Exports ─────────────────────────────────────────────────────

export function buildCodexFunctionDeclarations(): Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
}> {
  return CODEX_TOOL_REGISTRY.map(reg => ({
    name: reg.nativeName,
    description: reg.nativeDescription,
    parameters: reg.nativeSchema,
  }))
}

const _byNativeName = new Map<string, LaneToolRegistration>()
function ensureIndexed(): void {
  if (_byNativeName.size > 0) return
  for (const reg of CODEX_TOOL_REGISTRY) {
    _byNativeName.set(reg.nativeName, reg)
  }
}

export function resolveToolCall(
  name: string,
  args: Record<string, unknown>,
): { implId: string; input: Record<string, unknown> } | null {
  ensureIndexed()
  const reg = _byNativeName.get(name)
  if (!reg) return null
  return { implId: reg.implId, input: reg.adaptInput(args) }
}

export function formatToolResult(name: string, output: string | unknown): string {
  ensureIndexed()
  const reg = _byNativeName.get(name)
  if (!reg) return typeof output === 'string' ? output : JSON.stringify(output)
  return reg.adaptOutput(output)
}
