/**
 * OpenAI-Compatible Lane — System Prompt
 *
 * Shorter, cleaner prompt for models that don't have a native CLI
 * to match. Works well with DeepSeek, Groq, NIM, Ollama, OpenRouter,
 * Mistral, and the long tail of OpenAI-format models.
 *
 * Local models (Ollama, LM Studio) get an even shorter variant to
 * avoid overwhelming small context windows.
 */

import type { SystemPromptParts } from '../types.js'

export function assembleOpenAICompatPrompt(
  model: string,
  parts: SystemPromptParts,
  isLocal: boolean,
): { stable: string; volatile: string; full: string } {

  const stableSections: string[] = isLocal
    ? [
        // Shorter prompt for local models with limited context
        `You are a coding assistant. Help the user with their programming tasks.

Use the provided tools to read files, edit code, search the codebase, and run commands. Be concise.

When a command fails, diagnose first (read the exit code and error) before retrying — don't guess at variants. For unfamiliar CLIs, check \`--help\` once instead of iterating on flags.`,
      ]
    : [
        `You are an expert software engineer helping the user with coding tasks.

You have tools for reading files, writing files, editing code, searching the codebase, running shell commands, and searching the web. Use them to understand the code and make changes.`,

        `## Approach

1. Read relevant code before making changes
2. Make targeted, minimal edits
3. Verify changes work (run tests if available)
4. Don't add unnecessary features or refactoring`,

        `## Rules

- Read a file before editing it
- Don't add comments or docstrings to unchanged code
- Don't create abstractions for one-time operations
- If unsure about something, ask the user
- When a tool call fails, diagnose the cause first — read the exit code and error text, verify what actually exists (binaries, paths, env) — before retrying. Do NOT iterate on cosmetic variations of the same call (different shell wrappers, slight flag tweaks); blind retries burn input tokens without progress. If two attempts fail for the same reason, stop and investigate.
- For unfamiliar CLIs, libraries, or APIs, check \`--help\` or the official docs once before invoking. Don't guess flags and iterate.`,
      ]

  if (parts.customInstructions) {
    stableSections.push(`## Instructions\n\n${parts.customInstructions}`)
  }
  if (parts.toolsAddendum) {
    stableSections.push(parts.toolsAddendum)
  }
  if (parts.mcpIntro) {
    stableSections.push(`## MCP Tools\n\n${parts.mcpIntro}`)
  }

  const stable = stableSections.join('\n\n')

  const volatileSections: string[] = []
  if (parts.memory) volatileSections.push(parts.memory)
  if (parts.environment) volatileSections.push(parts.environment)
  if (parts.gitStatus && !isLocal) volatileSections.push(`Git status:\n${parts.gitStatus}`)

  const volatile = volatileSections.join('\n\n')
  const full = volatile ? `${stable}\n\n${volatile}` : stable
  return { stable, volatile, full }
}
