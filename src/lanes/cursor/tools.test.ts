/**
 * Cursor native tool surface checks.
 *
 * Run via: bun run src/lanes/cursor/tools.test.ts
 */

import {
  CURSOR_CLIENT_SIDE_TOOL_V2,
  buildCursorSupportedToolEnums,
  buildCursorToolDefinitions,
  resolveCursorToolCall,
} from './tools.js'

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

test('Cursor exposes file and shell tools with native names', () => {
  const defs = buildCursorToolDefinitions([
    { name: 'Read', input_schema: { type: 'object' } },
    { name: 'Write', input_schema: { type: 'object' } },
    { name: 'Edit', input_schema: { type: 'object' } },
    { name: 'Bash', input_schema: { type: 'object' } },
    { name: 'Grep', input_schema: { type: 'object' } },
    { name: 'Glob', input_schema: { type: 'object' } },
  ])
  const names = defs.map(t => t.name)
  for (const expected of [
    'read_file',
    'write_file',
    'replace',
    'run_terminal_cmd',
    'grep_search',
    'glob_file_search',
  ]) {
    assert(names.includes(expected), `missing ${expected}`)
  }
})

test('Cursor exposes agent, planning, and MCP resource tools in native names', () => {
  const defs = buildCursorToolDefinitions([
    {
      name: 'Agent',
      description: 'Spawn a subagent',
      input_schema: {
        type: 'object',
        properties: { description: { type: 'string' }, prompt: { type: 'string' } },
        required: ['description', 'prompt'],
      },
    },
    { name: 'EnterPlanMode', input_schema: { type: 'object', properties: {} } },
    {
      name: 'AskUserQuestion',
      input_schema: { type: 'object', properties: { questions: { type: 'array' } } },
    },
    { name: 'ListMcpResourcesTool', input_schema: { type: 'object', properties: {} } },
    {
      name: 'ReadMcpResourceTool',
      input_schema: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string' } } },
    },
  ])
  const names = defs.map(t => t.name)
  for (const expected of [
    'task',
    'create_plan',
    'ask_question',
    'list_mcp_resources',
    'read_mcp_resource',
  ]) {
    assert(names.includes(expected), `missing ${expected}`)
  }
})

test('Cursor read_file input adapts to shared Read schema', () => {
  const resolved = resolveCursorToolCall('read_file', {
    file_path: '/tmp/a.txt',
    start_line: 3,
    end_line: 5,
  })
  assert(resolved?.implId === 'Read', 'wrong impl')
  assert(resolved.input.file_path === '/tmp/a.txt', 'wrong path')
  assert(resolved.input.offset === 2, 'wrong offset')
  assert(resolved.input.limit === 3, 'wrong limit')
})

test('Cursor run_shell_command input adapts to shared Bash schema', () => {
  const resolved = resolveCursorToolCall('run_shell_command', {
    command: 'bun test',
    description: 'Run tests',
    is_background: true,
  })
  assert(resolved?.implId === 'Bash', 'wrong impl')
  assert(resolved.input.command === 'bun test', 'wrong command')
  assert(resolved.input.description === 'Run tests', 'wrong description')
  assert(resolved.input.run_in_background === true, 'wrong background flag')
})

test('Cursor list_dir emits Bash syntax for the Bash implementation', () => {
  const resolved = resolveCursorToolCall('list_dir', {
    dir_path: 'C:\\Users\\ok\\Desktop\\claudex',
  })
  assert(resolved?.implId === 'Bash', 'wrong impl')
  assert(String(resolved.input.command).startsWith('ls -la -- '), 'list_dir must use ls for Bash')
  assert(!/Get-ChildItem/i.test(String(resolved.input.command)), 'list_dir must not emit PowerShell')
})

test('Cursor keeps MCP tools in their independent names', () => {
  const defs = buildCursorToolDefinitions([
    {
      name: 'mcp__context7__query-docs',
      description: 'Query docs',
      input_schema: { type: 'object' },
    },
  ])
  assert(defs[0]?.name === 'mcp__context7__query-docs', 'MCP name changed')
})

test('Cursor advertises native ClientSideToolV2 enums for available tools', () => {
  const enums = buildCursorSupportedToolEnums([
    { name: 'Read', input_schema: { type: 'object' } },
    { name: 'Bash', input_schema: { type: 'object' } },
    { name: 'Grep', input_schema: { type: 'object' } },
    { name: 'Glob', input_schema: { type: 'object' } },
    { name: 'WebSearch', input_schema: { type: 'object' } },
    { name: 'Agent', input_schema: { type: 'object' } },
    { name: 'EnterPlanMode', input_schema: { type: 'object' } },
    { name: 'AskUserQuestion', input_schema: { type: 'object' } },
    { name: 'ListMcpResourcesTool', input_schema: { type: 'object' } },
    { name: 'ReadMcpResourceTool', input_schema: { type: 'object' } },
    { name: 'mcp__context7__query-docs', input_schema: { type: 'object' } },
  ])
  for (const expected of [
    CURSOR_CLIENT_SIDE_TOOL_V2.READ_FILE,
    CURSOR_CLIENT_SIDE_TOOL_V2.RUN_TERMINAL_COMMAND_V2,
    CURSOR_CLIENT_SIDE_TOOL_V2.RIPGREP_SEARCH,
    CURSOR_CLIENT_SIDE_TOOL_V2.GLOB_FILE_SEARCH,
    CURSOR_CLIENT_SIDE_TOOL_V2.WEB_SEARCH,
    CURSOR_CLIENT_SIDE_TOOL_V2.TASK,
    CURSOR_CLIENT_SIDE_TOOL_V2.TASK_V2,
    CURSOR_CLIENT_SIDE_TOOL_V2.CREATE_PLAN,
    CURSOR_CLIENT_SIDE_TOOL_V2.ASK_QUESTION,
    CURSOR_CLIENT_SIDE_TOOL_V2.LIST_MCP_RESOURCES,
    CURSOR_CLIENT_SIDE_TOOL_V2.READ_MCP_RESOURCE,
    CURSOR_CLIENT_SIDE_TOOL_V2.MCP,
    CURSOR_CLIENT_SIDE_TOOL_V2.CALL_MCP_TOOL,
  ]) {
    assert(enums.includes(expected), `missing enum ${expected}`)
  }
})

test('Cursor native aliases adapt back to shared tool implementations', () => {
  const shell = resolveCursorToolCall('run_terminal_cmd', {
    command: 'pwd',
    cwd: '/tmp/project',
    is_background: false,
  })
  assert(shell?.implId === 'Bash', 'wrong shell impl')
  assert(shell.input.command === 'cd "/tmp/project" && pwd', 'wrong shell cwd adaptation')

  const web = resolveCursorToolCall('web_search', { search_term: 'cursor cli tools' })
  assert(web?.implId === 'WebSearch', 'wrong web impl')
  assert(web.input.query === 'cursor cli tools', 'wrong web query')

  const task = resolveCursorToolCall('task', {
    description: 'Explore',
    prompt: 'Inspect the repository and summarize the auth flow.',
  })
  assert(task?.implId === 'Agent', 'wrong task impl')
  assert(task.input.prompt === 'Inspect the repository and summarize the auth flow.', 'wrong task input')
})

test('Cursor tolerates Shell as a terminal alias', () => {
  const shell = resolveCursorToolCall('Shell', {
    command: 'echo ok',
    cwd: '/tmp/project',
    description: 'Verify shell alias',
  })
  assert(shell?.implId === 'Bash', 'wrong Shell impl')
  assert(shell.input.command === 'cd "/tmp/project" && echo ok', 'wrong Shell cwd adaptation')
  assert(shell.input.description === 'Verify shell alias', 'wrong Shell description')
})

test('Cursor adapts shared Glob and Grep names from printed-tool syntax', () => {
  const glob = resolveCursorToolCall('Glob', {
    target_directory: '/tmp/project',
    glob_pattern: '**/*',
  })
  assert(glob?.implId === 'Glob', 'wrong glob impl')
  assert(glob.input.path === '/tmp/project', 'wrong glob path')
  assert(glob.input.pattern === '**/*', 'wrong glob pattern')

  const grep = resolveCursorToolCall('Grep', {
    path: '/tmp/project',
    pattern: '.',
    head_limit: 3,
  })
  assert(grep?.implId === 'Grep', 'wrong grep impl')
  assert(grep.input.path === '/tmp/project', 'wrong grep path')
  assert(grep.input.head_limit === 3, 'wrong grep limit')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
