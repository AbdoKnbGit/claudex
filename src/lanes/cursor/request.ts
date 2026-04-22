/**
 * Build a Cursor ConnectRPC chat request body from Anthropic-IR inputs.
 *
 * Tool-output representation follows 9router's stable pattern from
 * `reference/9router-master/open-sse/translator/request/openai-to-cursor.js`:
 * tool outputs are emitted as `<tool_result>…</tool_result>` XML blocks
 * inside user messages, NOT via the protobuf tool_results field. The
 * comment in the reference spells out why — partial-schema mismatches in
 * the protobuf tool_results path have been observed to loop the model.
 *
 * Mapping summary:
 *   - System prompt → prepended as its own "[System Instructions]" user turn.
 *   - User text blocks  → joined verbatim.
 *   - User tool_result  → <tool_result> XML (with cached tool-name lookup).
 *   - Assistant text    → joined verbatim.
 *   - Assistant tool_use→ dropped (the paired user-side XML result narrates
 *                         the call context for the model implicitly).
 *   - Images            → dropped (claudex's tool stack doesn't emit them
 *                         on provider messages).
 */

import type {
  ProviderMessage,
  ProviderTool,
  ProviderContentBlock,
} from '../../services/api/providers/base_provider.js'
import {
  generateCursorBody,
  type NormalizedCursorMessage,
  type EncodeMcpToolInput,
} from './protobuf.js'
import {
  buildCursorSupportedToolEnums,
  buildCursorToolDefinitions,
  getCursorRegistrationByImplId,
  getCursorRegistrationByNativeName,
} from './tools.js'

export interface BuildCursorBodyParams {
  model: string
  system: string
  messages: ProviderMessage[]
  tools: ProviderTool[]
  reasoningEffort?: 'medium' | 'high' | null
  conversationId?: string | null
}

export function buildCursorBody(params: BuildCursorBodyParams): Uint8Array {
  const { model, system, messages, tools, reasoningEffort, conversationId } = params
  const encodedTools = _encodeTools(tools)
  const supportedToolEnums = buildCursorSupportedToolEnums(tools)
  const converted = _convertMessages(
    messages,
    [
      _rewriteCursorSystemToolReferences(system, tools),
      _buildCursorToolHint(tools, encodedTools),
    ].filter(Boolean).join('\n\n'),
  )
  return generateCursorBody(
    converted,
    model,
    encodedTools,
    supportedToolEnums,
    reasoningEffort ?? null,
    { conversationId },
  )
}

function _encodeTools(tools: ProviderTool[]): EncodeMcpToolInput[] {
  return buildCursorToolDefinitions(tools).map(t => ({
    name: t.name,
    description: (t.description && t.description.trim()) || `Tool: ${t.name}`,
    parameters: (t.input_schema ?? {}) as Record<string, unknown>,
  }))
}

function _buildCursorToolHint(
  originalTools: ProviderTool[],
  encodedTools: EncodeMcpToolInput[],
): string {
  if (encodedTools.length === 0) return ''
  const toolNames = encodedTools.map(t => t.name).filter(Boolean)
  const shownToolNames = toolNames.slice(0, 80)
  const nativeNames = encodedTools
    .map(t => t.name)
    .filter(name => CURSOR_NATIVE_TOOL_HINT_NAMES.has(name))
  return [
    '[Cursor Tool Surface]',
    'You are running inside Claudex through the native Cursor provider. The tools advertised in this request are active and callable; do not claim that workspace, shell, MCP, skill, task, or agent tools are unavailable when their names are listed.',
    `Available tool names include: ${shownToolNames.join(', ')}${toolNames.length > shownToolNames.length ? `, and ${toolNames.length - shownToolNames.length} more` : ''}.`,
    ...(nativeNames.length > 0
      ? [`Use Cursor-native tool names when calling these tools: ${nativeNames.join(', ')}.`]
      : []),
    ...(_buildCursorAliasGuide(originalTools)
      ? [_buildCursorAliasGuide(originalTools)]
      : []),
    'Claudex tools without a Cursor-native alias keep their advertised names, including Skill, TaskCreate, TaskUpdate, TaskList, TaskGet, EnterWorktree, ExitWorktree, and mcp__server__tool MCP names.',
    _buildCursorToolSelectionGuide(originalTools, encodedTools),
  ].join('\n')
}

const CURSOR_NATIVE_TOOL_HINT_NAMES = new Set([
  'read_file',
  'write_file',
  'replace',
  'glob',
  'glob_file_search',
  'grep_search',
  'run_shell_command',
  'run_terminal_cmd',
  'google_web_search',
  'web_search',
  'web_fetch',
  'ask_user',
  'ask_question',
  'enter_plan_mode',
  'create_plan',
  'exit_plan_mode',
  'list_mcp_resources',
  'read_mcp_resource',
  'task',
  'task_v2',
])

function _buildCursorToolSelectionGuide(
  originalTools: ProviderTool[],
  encodedTools: EncodeMcpToolInput[],
): string {
  const originalNames = new Set(originalTools.map(tool => tool.name))
  const encodedNames = new Set(encodedTools.map(tool => tool.name))
  const lines: string[] = []

  const addCategory = (label: string, entries: string[]): void => {
    if (entries.length > 0) lines.push(`- ${label}: ${entries.join(', ')}`)
  }

  const add = (entries: Array<string | null>): string[] =>
    entries.filter((entry): entry is string => typeof entry === 'string')

  const hasOriginal = (name: string): boolean => originalNames.has(name)
  const hasEncoded = (name: string): boolean => encodedNames.has(name)

  addCategory('Files', add([
    hasEncoded('read_file') ? 'read_file (read files)' : null,
    hasEncoded('write_file') ? 'write_file (create or overwrite files)' : null,
    hasEncoded('replace') ? 'replace (edit files in place)' : null,
    hasEncoded('glob_file_search') ? 'glob_file_search (find files by glob)' : null,
    hasEncoded('glob') ? 'glob (find files by glob)' : null,
    hasEncoded('grep_search') ? 'grep_search (search file contents)' : null,
    hasEncoded('run_terminal_cmd') ? 'run_terminal_cmd (run shell commands)' : null,
    hasEncoded('run_shell_command') ? 'run_shell_command (run shell commands)' : null,
  ]))

  addCategory('Planning', add([
    hasEncoded('create_plan') ? 'create_plan (enter planning mode before coding)' : null,
    hasOriginal('ExitPlanMode') ? 'ExitPlanMode (present a plan and exit plan mode)' : null,
    hasOriginal('TaskCreate') ? 'TaskCreate (create a tracked task)' : null,
    hasOriginal('TaskGet') ? 'TaskGet (read a tracked task)' : null,
    hasOriginal('TaskList') ? 'TaskList (list tracked tasks)' : null,
    hasOriginal('TaskUpdate') ? 'TaskUpdate (update a tracked task)' : null,
  ]))

  addCategory('Agents', add([
    hasEncoded('task') ? 'task (spawn a subagent for delegated work)' : null,
    hasEncoded('task_v2') ? 'task_v2 (spawn a subagent for delegated work)' : null,
    hasOriginal('Skill') ? 'Skill (run a Claudex skill / slash-command skill)' : null,
    hasOriginal('EnterWorktree') ? 'EnterWorktree (enter an isolated git worktree)' : null,
    hasOriginal('ExitWorktree') ? 'ExitWorktree (leave the current worktree)' : null,
  ]))

  addCategory('Interaction', add([
    hasEncoded('ask_question') ? 'ask_question (ask the user a structured question)' : null,
    hasEncoded('web_search') ? 'web_search (search the web)' : null,
    hasEncoded('google_web_search') ? 'google_web_search (search the web)' : null,
    hasEncoded('web_fetch') ? 'web_fetch (fetch a specific URL)' : null,
  ]))

  addCategory('MCP', add([
    hasEncoded('list_mcp_resources') ? 'list_mcp_resources (list MCP resources)' : null,
    hasEncoded('read_mcp_resource') ? 'read_mcp_resource (read an MCP resource)' : null,
  ]))

  const mcpServerTools = originalTools
    .map(tool => tool.name)
    .filter(name => name.startsWith('mcp__'))
  if (mcpServerTools.length > 0) {
    lines.push(`- MCP server tools: ${mcpServerTools.length} tool(s) named mcp__* are available; use the exact tool name shown when you need a specific MCP server tool.`)
  }

  if (lines.length === 0) return ''

  return [
    '[Cursor Tool Guide]',
    'Use the most specific tool available instead of claiming the capability is unavailable.',
    ...lines,
  ].join('\n')
}

function _buildToolNameMap(messages: ProviderMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        map.set(block.id, _cursorDisplayedToolName(block.name))
      }
    }
  }
  return map
}

function _convertMessages(
  messages: ProviderMessage[],
  systemText: string,
): NormalizedCursorMessage[] {
  const out: NormalizedCursorMessage[] = []
  const toolNames = _buildToolNameMap(messages)

  if (systemText) {
    out.push({ role: 'user', content: `[System Instructions]\n${systemText}` })
  }

  for (const msg of messages) {
    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user'

    if (role === 'user') {
      const parts: string[] = []
      if (typeof msg.content === 'string') {
        if (msg.content) parts.push(msg.content)
      } else {
        for (const block of msg.content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            parts.push(block.text)
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            const name = toolNames.get(block.tool_use_id) || 'tool'
            parts.push(_buildToolResultBlock(
              name,
              block.tool_use_id,
              _stringifyToolResult(block.content),
            ))
          }
        }
      }
      const content = parts.join('\n')
      if (content) out.push({ role: 'user', content })
      continue
    }

    const texts: string[] = []
    if (typeof msg.content === 'string') {
      if (msg.content) texts.push(msg.content)
    } else {
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          texts.push(block.text)
        }
      }
    }
    const content = texts.join('\n').trim()
    if (content) out.push({ role: 'assistant', content })
  }

  return out
}

function _buildToolResultBlock(name: string, id: string, result: string): string {
  const cleanResult = _sanitize(result)
  return [
    '<tool_result>',
    `<tool_name>${_escapeXml(name)}</tool_name>`,
    `<tool_call_id>${_escapeXml(id)}</tool_call_id>`,
    `<result>${_escapeXml(cleanResult)}</result>`,
    '</tool_result>',
  ].join('\n')
}

function _stringifyToolResult(
  content: string | ProviderContentBlock[] | undefined,
): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (typeof block === 'object' && block) {
      parts.push(JSON.stringify(block))
    }
  }
  return parts.join('\n')
}

function _sanitize(text: string): string {
  // Strip non-printable control chars — the Cursor backend errors on them.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

function _escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function _buildCursorAliasGuide(originalTools: ProviderTool[]): string {
  const aliases = originalTools
    .map(tool => {
      const native = _cursorDisplayedToolName(tool.name)
      return native !== tool.name ? `${tool.name} -> ${native}` : null
    })
    .filter((alias): alias is string => typeof alias === 'string')

  if (aliases.length === 0) return ''
  return (
    'If other Claudex instructions mention shared tool ids, treat them as aliases for the callable Cursor names in this session: '
    + aliases.join(', ')
    + '.'
  )
}

function _rewriteCursorSystemToolReferences(
  systemText: string,
  tools: ProviderTool[],
): string {
  if (!systemText.trim()) return systemText

  let rewritten = systemText
  const replacements = tools
    .map(tool => {
      const native = _cursorDisplayedToolName(tool.name)
      return native !== tool.name ? [tool.name, native] as const : null
    })
    .filter((pair): pair is readonly [string, string] => Array.isArray(pair))
    .sort((a, b) => b[0].length - a[0].length)

  for (const [sharedName, nativeName] of replacements) {
    rewritten = rewritten.replaceAll(`\`${sharedName}\``, `\`${nativeName}\``)
    rewritten = rewritten.replace(
      new RegExp(`\\b${_escapeRegex(sharedName)}\\b`, 'g'),
      nativeName,
    )
  }

  return rewritten
}

function _cursorDisplayedToolName(name: string): string {
  const reg =
    getCursorRegistrationByImplId(name) ??
    getCursorRegistrationByNativeName(name)
  return reg?.nativeName ?? name
}

function _escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
