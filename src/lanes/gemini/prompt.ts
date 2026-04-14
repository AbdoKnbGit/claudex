/**
 * Gemini Lane — Native System Prompt Assembly
 *
 * Builds the system prompt in the structure Gemini was post-trained on.
 * The template matches gemini-cli's prompt layout (from packages/core/src/prompts/).
 *
 * Sections:
 *   1. Preamble — agent identity and mode
 *   2. Core Mandates — security and engineering standards
 *   3. Workflows — research → strategy → execution
 *   4. Tool Usage — how to use each tool effectively
 *   5. Operational Guidelines — tone, style, conventions
 *   6. Git Repository — git workflow if applicable
 *   7. Memory/Context — injected from ClaudeX shared layer
 *   8. Environment — volatile per-turn info (cwd, date, git status)
 *
 * Sections 1-6 are STABLE (cacheable). Sections 7-8 are VOLATILE.
 * The boundary is marked so the Gemini cache manager hashes only stable content.
 */

import type { SystemPromptParts } from '../types.js'

// ─── Model-Family Detection ──────────────────────────────────────

type GeminiFamily = 'gemini-3' | 'default-legacy'

function detectFamily(model: string): GeminiFamily {
  const m = model.toLowerCase()
  if (/gemini-3(\.|-|$)/.test(m) || /gemini-4/.test(m)) return 'gemini-3'
  return 'default-legacy'
}

// ─── Stable Prompt Sections ──────────────────────────────────────

function preamble(family: GeminiFamily): string {
  return `You are an interactive AI coding agent. You are pair-programming with the user to solve their coding task.
The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.

Each time the user sends a message, carefully assess what information you need. Use your tools to efficiently gather context, then provide a response.`
}

function coreMandates(): string {
  return `## Core Mandates

### Security
- NEVER expose credentials, API keys, tokens, or secrets in output or tool calls
- NEVER execute commands that could exfiltrate data or compromise the system
- If asked to do something potentially harmful, explain the risk and suggest a safe alternative

### Engineering Standards
- Write clean, idiomatic, well-structured code
- Follow existing project conventions and patterns
- Prefer editing existing files over creating new ones
- Test your changes when possible
- Do not add unnecessary complexity, comments, or abstractions`
}

function workflows(family: GeminiFamily): string {
  if (family === 'gemini-3') {
    return `## Workflow

For each task, follow this workflow:
1. **Research** — Read relevant files, search the codebase, understand context
2. **Strategy** — Plan your approach before writing code
3. **Execute** — Make changes, test them, verify correctness
4. **Report** — Summarize what you did and why

Use \`enter_plan_mode\` for complex tasks that need careful research before implementation.`
  }

  return `## Workflow

Follow this general approach for each task:
1. Gather context — read relevant files, search the codebase
2. Plan your approach — think before coding
3. Make changes — edit files, run commands
4. Verify — test your changes work correctly
5. Summarize — tell the user what you did`
}

function toolUsageGuidelines(): string {
  return `## Tool Usage

- **read_file**: Read files before editing them. Use start_line/end_line for large files.
- **replace**: Include 3+ lines of surrounding context in old_string for unique matching. Check the file content first.
- **run_shell_command**: Include a description of what the command does. Prefer dedicated tools (read_file, grep_search) over shell equivalents (cat, grep).
- **grep_search**: Use for searching code content. Preferred over run_shell_command with grep.
- **glob**: Use for finding files by pattern. Preferred over run_shell_command with find.
- **google_web_search**: Use when you need current documentation or information not in the codebase.
- **web_fetch**: Use to read web pages, documentation URLs, or GitHub files.

Do NOT use tools when you can answer from context. Do NOT read files you've already read in this conversation unless they may have changed.`
}

function operationalGuidelines(): string {
  return `## Guidelines

- Be concise. Don't repeat what the user already knows.
- When referencing code, include file paths.
- Don't add features, refactoring, or "improvements" beyond what was asked.
- A bug fix doesn't need surrounding code cleaned up.
- Don't add error handling for scenarios that can't happen.
- When making changes, verify they work before reporting completion.
- If you're unsure about something, ask the user rather than guessing.`
}

function gitRepoSection(): string {
  return `## Git Repository

This workspace is a git repository. When working with git:
- Read diffs and status before committing
- Write clear, descriptive commit messages
- Don't force push or use destructive git operations without asking
- Prefer creating new commits over amending existing ones`
}

// ─── Full Prompt Assembly ────────────────────────────────────────

/**
 * Assemble the complete Gemini system prompt.
 *
 * Returns { stable, volatile } — the stable portion is cacheable,
 * the volatile portion changes every turn.
 */
export function assembleGeminiSystemPrompt(
  model: string,
  parts: SystemPromptParts,
): { stable: string; volatile: string; full: string } {
  const family = detectFamily(model)

  // ── Stable sections (cacheable) ──
  const stableSections: string[] = [
    preamble(family),
    coreMandates(),
    workflows(family),
    toolUsageGuidelines(),
    operationalGuidelines(),
    gitRepoSection(),
  ]

  // Inject custom instructions into stable section if present
  if (parts.customInstructions) {
    stableSections.push(`## Additional Instructions\n\n${parts.customInstructions}`)
  }

  // Inject tools addendum
  if (parts.toolsAddendum) {
    stableSections.push(`## Tool Configuration\n\n${parts.toolsAddendum}`)
  }

  // Inject MCP intro
  if (parts.mcpIntro) {
    stableSections.push(`## MCP Tools\n\n${parts.mcpIntro}`)
  }

  // Inject skills context
  if (parts.skillsContext) {
    stableSections.push(`## Available Skills\n\n<available_skills>\n${parts.skillsContext}\n</available_skills>`)
  }

  const stable = stableSections.join('\n\n')

  // ── Volatile sections (per-turn) ──
  const volatileSections: string[] = []

  // Memory (from CLAUDE.md, GEMINI.md, AGENTS.md)
  if (parts.memory) {
    volatileSections.push(
      `## Context\n\n<loaded_context>\n${parts.memory}\n</loaded_context>`
    )
  }

  // Environment info
  if (parts.environment || parts.gitStatus) {
    const envParts: string[] = []
    if (parts.environment) envParts.push(parts.environment)
    if (parts.gitStatus) envParts.push(`Git status:\n${parts.gitStatus}`)
    volatileSections.push(`## Environment\n\n${envParts.join('\n\n')}`)
  }

  const volatile = volatileSections.join('\n\n')

  // Combine with boundary marker for cache manager
  const full = volatile
    ? `${stable}\n\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n\n${volatile}`
    : stable

  return { stable, volatile, full }
}

/**
 * Build systemInstruction for the Gemini API.
 * Returns the shape Gemini's REST API expects.
 */
export function buildGeminiSystemInstruction(
  model: string,
  parts: SystemPromptParts,
): { parts: Array<{ text: string }> } {
  const { full } = assembleGeminiSystemPrompt(model, parts)
  return { parts: [{ text: full }] }
}
