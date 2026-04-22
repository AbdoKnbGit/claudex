import type { ProviderTool } from '../../services/api/providers/base_provider.js'
import type { LaneToolRegistration } from '../types.js'
import { GEMINI_TOOL_REGISTRY } from '../gemini/tools.js'

export const CURSOR_CLIENT_SIDE_TOOL_V2 = {
  READ_SEMSEARCH_FILES: 1,
  RIPGREP_SEARCH: 3,
  READ_FILE: 5,
  LIST_DIR: 6,
  EDIT_FILE: 7,
  FILE_SEARCH: 8,
  SEMANTIC_SEARCH_FULL: 9,
  DELETE_FILE: 11,
  REAPPLY: 12,
  RUN_TERMINAL_COMMAND_V2: 15,
  FETCH_RULES: 16,
  WEB_SEARCH: 18,
  MCP: 19,
  SEARCH_SYMBOLS: 23,
  BACKGROUND_COMPOSER_FOLLOWUP: 24,
  KNOWLEDGE_BASE: 25,
  FETCH_PULL_REQUEST: 26,
  DEEP_SEARCH: 27,
  CREATE_DIAGRAM: 28,
  FIX_LINTS: 29,
  READ_LINTS: 30,
  GO_TO_DEFINITION: 31,
  TASK: 32,
  AWAIT_TASK: 33,
  TODO_READ: 34,
  TODO_WRITE: 35,
  EDIT_FILE_V2: 38,
  LIST_DIR_V2: 39,
  READ_FILE_V2: 40,
  RIPGREP_RAW_SEARCH: 41,
  GLOB_FILE_SEARCH: 42,
  CREATE_PLAN: 43,
  LIST_MCP_RESOURCES: 44,
  READ_MCP_RESOURCE: 45,
  READ_PROJECT: 46,
  UPDATE_PROJECT: 47,
  TASK_V2: 48,
  CALL_MCP_TOOL: 49,
  APPLY_AGENT_DIFF: 50,
  ASK_QUESTION: 51,
  SWITCH_MODE: 52,
  GENERATE_IMAGE: 53,
  COMPUTER_USE: 54,
  WRITE_SHELL_STDIN: 55,
} as const

const CURSOR_NATIVE_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'replace',
  'run_shell_command',
  'glob',
  'grep_search',
  'google_web_search',
  'web_fetch',
  'ask_user',
  'enter_plan_mode',
  'exit_plan_mode',
  'list_directory',
])

const CT = CURSOR_CLIENT_SIDE_TOOL_V2

const _stringifyToolOutput = (output: string | unknown): string =>
  typeof output === 'string' ? output : JSON.stringify(output)

const CURSOR_EXTRA_TOOL_REGISTRY: LaneToolRegistration[] = [
  {
    nativeName: 'run_terminal_cmd',
    implId: 'Bash',
    nativeDescription:
      'Execute a shell command in the workspace. Use this for running commands, tests, git, and development workflows.',
    nativeSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd: { type: 'string', description: 'Optional working directory override.' },
        description: { type: 'string', description: 'Brief description for the command.' },
        is_background: { type: 'boolean', description: 'Whether the command should keep running in the background.' },
      },
      required: ['command'],
    },
    adaptInput(native) {
      const command = native.command
      const cwd = native.cwd
      const input: Record<string, unknown> = { command }
      if (native.description) input.description = native.description
      if (native.is_background) input.run_in_background = native.is_background
      if (cwd) input.command = `cd ${JSON.stringify(cwd)} && ${command}`
      return input
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'glob_file_search',
    implId: 'Glob',
    nativeDescription: 'Find files matching a glob pattern.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match.' },
        path: { type: 'string', description: 'Optional path to search within.' },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      const pattern =
        native.pattern ??
        native.glob_pattern ??
        native.query
      const path =
        native.path ??
        native.target_directory ??
        native.dir_path
      const input: Record<string, unknown> = { pattern }
      if (path) input.path = path
      return input
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'web_search',
    implId: 'WebSearch',
    nativeDescription: 'Search the web for up-to-date information.',
    nativeSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
    adaptInput(native) {
      return { query: native.query ?? native.search_term }
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'ask_question',
    implId: 'AskUserQuestion',
    nativeDescription: 'Ask the user a structured clarification question.',
    nativeSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Structured questions to present to the user.',
        },
      },
      required: ['questions'],
    },
    adaptInput(native) {
      return {
        question: native.question ?? native.prompt,
        questions: native.questions,
      }
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'create_plan',
    implId: 'EnterPlanMode',
    nativeDescription: 'Enter planning mode before implementation.',
    nativeSchema: { type: 'object', properties: {} },
    adaptInput(native) {
      return native
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'list_mcp_resources',
    implId: 'ListMcpResourcesTool',
    nativeDescription: 'List MCP resources from configured servers.',
    nativeSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Optional MCP server name.' },
      },
    },
    adaptInput(native) {
      const input: Record<string, unknown> = { ...native }
      if (input.path == null && native.target_directory != null) {
        input.path = native.target_directory
      }
      if (input.pattern == null && native.query != null) {
        input.pattern = native.query
      }
      if (input.glob == null && native.glob_pattern != null) {
        input.glob = native.glob_pattern
      }
      return input
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'read_mcp_resource',
    implId: 'ReadMcpResourceTool',
    nativeDescription: 'Read a specific MCP resource by URI.',
    nativeSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name.' },
        uri: { type: 'string', description: 'Resource URI.' },
      },
      required: ['server', 'uri'],
    },
    adaptInput(native) {
      return native
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'task',
    implId: 'Agent',
    nativeDescription: 'Spawn a delegated subagent for a bounded task.',
    nativeSchema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['description', 'prompt'],
    },
    adaptInput(native) {
      return native
    },
    adaptOutput: _stringifyToolOutput,
  },
]

const CURSOR_COMPAT_ALIAS_REGISTRY: LaneToolRegistration[] = [
  {
    nativeName: 'list_dir',
    implId: 'Bash',
    nativeDescription: 'List directory contents.',
    nativeSchema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Optional directory path to list.' },
      },
    },
    adaptInput(native) {
      const dirPath = typeof native.dir_path === 'string' ? native.dir_path : undefined
      return {
        command: _cursorListDirCommand(dirPath),
        description: dirPath ? `List directory contents for ${dirPath}` : 'List directory contents',
      }
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'list_dir_v2',
    implId: 'Bash',
    nativeDescription: 'List directory contents.',
    nativeSchema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Optional directory path to list.' },
      },
    },
    adaptInput(native) {
      const dirPath = typeof native.dir_path === 'string' ? native.dir_path : undefined
      return {
        command: _cursorListDirCommand(dirPath),
        description: dirPath ? `List directory contents for ${dirPath}` : 'List directory contents',
      }
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'grep',
    implId: 'Grep',
    nativeDescription: 'Search file contents with a regular expression.',
    nativeSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['pattern'],
    },
    adaptInput(native) {
      return native
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'search_replace',
    implId: 'Edit',
    nativeDescription: 'Edit a file by replacing exact text.',
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    adaptInput(native) {
      return {
        file_path: native.file_path,
        old_string: native.old_string,
        new_string: native.new_string,
        replace_all: native.replace_all ?? native.allow_multiple ?? false,
      }
    },
    adaptOutput: _stringifyToolOutput,
  },
  {
    nativeName: 'write',
    implId: 'Write',
    nativeDescription: 'Write a file in one shot.',
    nativeSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
    adaptInput(native) {
      return {
        file_path: native.file_path,
        content: native.content,
      }
    },
    adaptOutput: _stringifyToolOutput,
  },
]

export const CURSOR_TOOL_REGISTRY: LaneToolRegistration[] = [
  ...CURSOR_EXTRA_TOOL_REGISTRY,
  ...GEMINI_TOOL_REGISTRY.filter(reg => CURSOR_NATIVE_TOOL_NAMES.has(reg.nativeName)),
  ...CURSOR_COMPAT_ALIAS_REGISTRY,
]

const CURSOR_PRESERVE_SHARED_SCHEMA_IMPL_IDS = new Set([
  'Agent',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
])

const CURSOR_MCP_TOOL_ENUMS = [
  CT.MCP,
  CT.CALL_MCP_TOOL,
] as const

const CURSOR_TOOL_ENUMS_BY_NAME: Record<string, readonly number[]> = {
  Read: [CT.READ_FILE, CT.READ_FILE_V2],
  read_file: [CT.READ_FILE, CT.READ_FILE_V2],
  FileReadTool: [CT.READ_FILE, CT.READ_FILE_V2],

  Glob: [CT.GLOB_FILE_SEARCH, CT.FILE_SEARCH],
  glob: [CT.GLOB_FILE_SEARCH, CT.FILE_SEARCH],
  file_search: [CT.FILE_SEARCH],
  glob_file_search: [CT.GLOB_FILE_SEARCH],

  Grep: [CT.RIPGREP_SEARCH, CT.RIPGREP_RAW_SEARCH],
  grep: [CT.RIPGREP_SEARCH, CT.RIPGREP_RAW_SEARCH],
  grep_search: [CT.RIPGREP_SEARCH, CT.RIPGREP_RAW_SEARCH],
  ripgrep_search: [CT.RIPGREP_SEARCH],
  ripgrep_raw_search: [CT.RIPGREP_RAW_SEARCH],

  Bash: [CT.RUN_TERMINAL_COMMAND_V2],
  PowerShell: [CT.RUN_TERMINAL_COMMAND_V2],
  list_dir: [CT.LIST_DIR, CT.LIST_DIR_V2],
  list_dir_v2: [CT.LIST_DIR_V2],
  run_shell_command: [CT.RUN_TERMINAL_COMMAND_V2],
  run_terminal_cmd: [CT.RUN_TERMINAL_COMMAND_V2],
  run_terminal_command_v2: [CT.RUN_TERMINAL_COMMAND_V2],

  WebSearch: [CT.WEB_SEARCH],
  google_web_search: [CT.WEB_SEARCH],
  web_search: [CT.WEB_SEARCH],

  Agent: [CT.TASK, CT.TASK_V2, CT.AWAIT_TASK],
  task: [CT.TASK, CT.TASK_V2, CT.AWAIT_TASK],
  task_v2: [CT.TASK_V2, CT.AWAIT_TASK],

  AskUserQuestion: [CT.ASK_QUESTION],
  ask_user: [CT.ASK_QUESTION],
  ask_question: [CT.ASK_QUESTION],

  EnterPlanMode: [CT.CREATE_PLAN, CT.SWITCH_MODE],
  enter_plan_mode: [CT.CREATE_PLAN, CT.SWITCH_MODE],
  create_plan: [CT.CREATE_PLAN, CT.SWITCH_MODE],
  ExitPlanMode: [CT.CREATE_PLAN, CT.SWITCH_MODE],
  exit_plan_mode: [CT.CREATE_PLAN, CT.SWITCH_MODE],

  ListMcpResourcesTool: [CT.LIST_MCP_RESOURCES],
  list_mcp_resources: [CT.LIST_MCP_RESOURCES],
  ReadMcpResourceTool: [CT.READ_MCP_RESOURCE],
  read_mcp_resource: [CT.READ_MCP_RESOURCE],
  LSP: [CT.SEARCH_SYMBOLS, CT.GO_TO_DEFINITION],
  TodoWrite: [CT.TODO_READ, CT.TODO_WRITE],
}

const CURSOR_TOOL_ALIAS_BY_NAME: Record<string, string> = {
  Read: 'read_file',
  Write: 'write',
  Edit: 'search_replace',
  Bash: 'run_terminal_cmd',
  Glob: 'glob_file_search',
  Grep: 'grep',
  WebSearch: 'web_search',
  Agent: 'task',
  AskUserQuestion: 'ask_question',
  EnterPlanMode: 'create_plan',
  ExitPlanMode: 'create_plan',
  ListMcpResourcesTool: 'list_mcp_resources',
  ReadMcpResourceTool: 'read_mcp_resource',
  read_file_v2: 'read_file',
  list_dir: 'list_directory',
  list_dir_v2: 'list_directory',
  file_search: 'glob',
  glob_file_search: 'glob',
  ripgrep_search: 'grep_search',
  ripgrep_raw_search: 'grep_search',
  task: 'Agent',
  task_v2: 'Agent',
  run_terminal_cmd: 'run_shell_command',
  run_terminal_command_v2: 'run_shell_command',
  web_search: 'google_web_search',
  ask_question: 'ask_user',
  create_plan: 'enter_plan_mode',
  switch_mode: 'enter_plan_mode',
}

const _byNativeName = new Map<string, LaneToolRegistration>()
const _byImplId = new Map<string, LaneToolRegistration>()

function _ensureIndexed(): void {
  if (_byNativeName.size > 0) return
  for (const reg of CURSOR_TOOL_REGISTRY) {
    _byNativeName.set(reg.nativeName, reg)
    if (!_byImplId.has(reg.implId)) {
      _byImplId.set(reg.implId, reg)
    }
  }
}

export function getCursorRegistrationByNativeName(
  name: string,
): LaneToolRegistration | undefined {
  _ensureIndexed()
  return _byNativeName.get(name)
}

export function getCursorRegistrationByImplId(
  implId: string,
): LaneToolRegistration | undefined {
  _ensureIndexed()
  return _byImplId.get(implId)
}

export function buildCursorToolDefinitions(tools: ProviderTool[]): ProviderTool[] {
  const out: ProviderTool[] = []
  const seen = new Set<string>()

  for (const tool of tools) {
    const reg =
      getCursorRegistrationByImplId(tool.name) ??
      getCursorRegistrationByNativeName(tool.name)

    if (reg) {
      if (seen.has(reg.nativeName)) continue
      seen.add(reg.nativeName)
      const preserveSharedShape = CURSOR_PRESERVE_SHARED_SCHEMA_IMPL_IDS.has(reg.implId)
      out.push({
        name: reg.nativeName,
        description: preserveSharedShape
          ? ((tool.description && tool.description.trim()) || reg.nativeDescription)
          : reg.nativeDescription,
        input_schema: preserveSharedShape
          ? ((tool.input_schema ?? {}) as Record<string, unknown>)
          : reg.nativeSchema,
      })
      continue
    }

    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    out.push(tool)
  }

  return out
}

export function buildCursorSupportedToolEnums(tools: ProviderTool[]): number[] {
  const enums = new Set<number>()

  if (tools.length > 0) {
    for (const toolEnum of CURSOR_MCP_TOOL_ENUMS) {
      enums.add(toolEnum)
    }
  }

  for (const tool of tools) {
    for (const toolEnum of _cursorToolEnumsForName(tool.name)) {
      enums.add(toolEnum)
    }

    const reg =
      getCursorRegistrationByImplId(tool.name) ??
      getCursorRegistrationByNativeName(tool.name)
    if (reg) {
      for (const toolEnum of _cursorToolEnumsForName(reg.nativeName)) {
        enums.add(toolEnum)
      }
    }

    if (tool.name.startsWith('mcp__')) {
      for (const toolEnum of CURSOR_MCP_TOOL_ENUMS) {
        enums.add(toolEnum)
      }
    }
  }

  return [...enums]
}

export function resolveCursorToolCall(
  nativeName: string,
  nativeInput: Record<string, unknown>,
): { implId: string; input: Record<string, unknown> } | null {
  const normalizedName = CURSOR_TOOL_ALIAS_BY_NAME[nativeName] ?? nativeName

  if (nativeName === 'task' || nativeName === 'task_v2') {
    return { implId: 'Agent', input: nativeInput }
  }

  if (normalizedName === 'read_file') {
    return {
      implId: 'Read',
      input: _adaptCursorReadInput(nativeInput),
    }
  }

  if (nativeName === 'file_search') {
    const query = typeof nativeInput.query === 'string' ? nativeInput.query : '*'
    return {
      implId: 'Glob',
      input: { pattern: query.includes('*') ? query : `**/*${query}*` },
    }
  }

  if (normalizedName === 'google_web_search') {
    return {
      implId: 'WebSearch',
      input: {
        query: nativeInput.query ?? nativeInput.search_term,
      },
    }
  }

  if (normalizedName === 'ask_user') {
    if (Array.isArray(nativeInput.questions)) {
      return {
        implId: 'AskUserQuestion',
        input: nativeInput,
      }
    }
    return {
      implId: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: nativeInput.question ?? nativeInput.prompt ?? 'Clarify the next step?',
            header: 'Question',
            type: 'text',
          },
        ],
      },
    }
  }

  if (normalizedName === 'enter_plan_mode') {
    return { implId: 'EnterPlanMode', input: {} }
  }

  if (normalizedName === 'run_shell_command') {
    const command = nativeInput.command
    const cwd = nativeInput.dir_path ?? nativeInput.cwd
    const input: Record<string, unknown> = { command }
    if (nativeInput.description) input.description = nativeInput.description
    if (nativeInput.is_background) input.run_in_background = nativeInput.is_background
    if (cwd) input.command = `cd ${JSON.stringify(cwd)} && ${command}`
    return { implId: 'Bash', input }
  }

  if (nativeName === 'list_mcp_resources') {
    return { implId: 'ListMcpResourcesTool', input: nativeInput }
  }

  if (nativeName === 'read_mcp_resource') {
    return { implId: 'ReadMcpResourceTool', input: nativeInput }
  }

  if (nativeName === 'call_mcp_tool') {
    const server = typeof nativeInput.server === 'string' ? nativeInput.server : ''
    const toolName = typeof nativeInput.tool_name === 'string' ? nativeInput.tool_name : ''
    if (server && toolName) {
      return {
        implId: `mcp__${server}__${toolName}`,
        input: (
          nativeInput.tool_args &&
          typeof nativeInput.tool_args === 'object' &&
          !Array.isArray(nativeInput.tool_args)
        )
          ? nativeInput.tool_args as Record<string, unknown>
          : nativeInput,
      }
    }
  }

  if (normalizedName === 'replace' || nativeName === 'edit_file' || nativeName === 'edit_file_v2') {
    return _adaptCursorEditInput(nativeInput)
  }

  const reg = getCursorRegistrationByNativeName(normalizedName)
  if (!reg) return null
  return {
    implId: reg.implId,
    input: reg.adaptInput(nativeInput),
  }
}

function _cursorToolEnumsForName(name: string): readonly number[] {
  return CURSOR_TOOL_ENUMS_BY_NAME[name] ?? []
}

function _adaptCursorReadInput(native: Record<string, unknown>): Record<string, unknown> {
  const filePath =
    native.file_path ??
    native.relative_workspace_path ??
    native.target_file
  const start =
    _asNumber(native.start_line) ??
    _asNumber(native.start_line_one_indexed) ??
    (_asNumber(native.offset) != null ? _asNumber(native.offset)! + 1 : undefined)
  const end =
    _asNumber(native.end_line) ??
    _asNumber(native.end_line_one_indexed_inclusive) ??
    (start != null && _asNumber(native.limit) != null ? start + _asNumber(native.limit)! - 1 : undefined)

  const result: Record<string, unknown> = { file_path: filePath }
  if (start != null) {
    result.offset = Math.max(0, start - 1)
    if (end != null) result.limit = Math.max(1, end - start + 1)
  }
  return result
}

function _adaptCursorEditInput(
  native: Record<string, unknown>,
): { implId: string; input: Record<string, unknown> } | null {
  const filePath =
    native.file_path ??
    native.relative_workspace_path ??
    native.target_file

  if (native.old_string != null || native.new_string != null) {
    return {
      implId: 'Edit',
      input: {
        file_path: filePath,
        old_string: native.old_string,
        new_string: native.new_string,
        replace_all: native.allow_multiple ?? false,
      },
    }
  }

  const content = native.content ?? native.contents ?? native.contents_after_edit
  if (content != null) {
    return {
      implId: 'Write',
      input: {
        file_path: filePath,
        content,
      },
    }
  }

  const reg = getCursorRegistrationByNativeName('replace')
  return reg
    ? { implId: reg.implId, input: reg.adaptInput(native) }
    : null
}

function _asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function _cursorListDirCommand(dirPath: string | undefined): string {
  if (process.platform === 'win32') {
    return dirPath
      ? `$p=${JSON.stringify(dirPath)}; Get-ChildItem -Force -LiteralPath $p`
      : 'Get-ChildItem -Force'
  }
  return dirPath ? `ls -la -- ${JSON.stringify(dirPath)}` : 'ls -la'
}
