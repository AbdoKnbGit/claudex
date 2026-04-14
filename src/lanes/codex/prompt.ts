/**
 * Codex Lane — Native System Prompt
 *
 * Builds the system prompt in Codex CLI's native structure.
 * Key differences from Anthropic/Gemini:
 *   - apply_patch as the primary edit tool (not Edit, not replace)
 *   - Plan-then-execute workflow
 *   - Concise, direct instructions (Codex prompt is shorter than others)
 */

import type { SystemPromptParts } from '../types.js'

export function assembleCodexSystemPrompt(
  model: string,
  parts: SystemPromptParts,
): { stable: string; volatile: string; full: string } {

  const stableSections: string[] = [
    `You are an expert software engineer. You are pair-programming with the user to solve coding tasks.

You have access to tools for reading files, writing files, searching code, and executing shell commands. Use these tools to understand the codebase and make changes.`,

    `## How to edit files

Use the apply_patch tool to make changes to files. The patch must be in unified diff format:
- Include file path headers (--- a/path and +++ b/path)
- Include @@ hunk headers with correct line numbers
- Include 3 lines of context around each change
- Prefix removed lines with -
- Prefix added lines with +
- Prefix context lines with a space

For new files, use write_file instead of apply_patch.`,

    `## Approach

1. Read relevant code first — understand before changing
2. Make targeted, minimal changes
3. Verify your changes work (run tests, check for errors)
4. Don't add unnecessary complexity or features beyond what was asked`,

    `## Rules

- Do NOT add comments, docstrings, or type annotations to unchanged code
- Do NOT refactor code that isn't part of the task
- Do NOT create abstractions for one-time operations
- Do NOT guess file paths — use search_files and search_code to find them
- If unsure, ask the user`,
  ]

  if (parts.customInstructions) {
    stableSections.push(`## Additional Instructions\n\n${parts.customInstructions}`)
  }
  if (parts.toolsAddendum) {
    stableSections.push(`## Tool Notes\n\n${parts.toolsAddendum}`)
  }
  if (parts.mcpIntro) {
    stableSections.push(`## MCP Tools\n\n${parts.mcpIntro}`)
  }
  if (parts.skillsContext) {
    stableSections.push(`## Skills\n\n${parts.skillsContext}`)
  }

  const stable = stableSections.join('\n\n')

  const volatileSections: string[] = []
  if (parts.memory) {
    volatileSections.push(`## Context\n\n${parts.memory}`)
  }
  if (parts.environment || parts.gitStatus) {
    const envParts: string[] = []
    if (parts.environment) envParts.push(parts.environment)
    if (parts.gitStatus) envParts.push(`Git status:\n${parts.gitStatus}`)
    volatileSections.push(`## Environment\n\n${envParts.join('\n\n')}`)
  }

  const volatile = volatileSections.join('\n\n')
  const full = volatile ? `${stable}\n\n${volatile}` : stable
  return { stable, volatile, full }
}
