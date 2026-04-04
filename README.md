# Claudex

**The multi-provider AI coding CLI.** A fully integrated agentic coding system that brings the power of Claude Code's tool loop, MCP servers, hooks, skills, and interactive TUI to every major LLM provider — Anthropic, OpenAI, Gemini, Groq, DeepSeek, Ollama, NVIDIA NIM, and OpenRouter.

Claudex is not a proxy or wrapper. It is a complete reimplementation of the Claude Code runtime with a provider-agnostic architecture: every provider goes through native adapters that translate the Anthropic tool-use protocol into each provider's native API format (OpenAI chat completions, Gemini generateContent, etc.), with full streaming, rate-limit handling, cache-control stripping, context-window management, and retry logic built in.

---

## Quick Install

```bash
npm install -g @abdoknbgit/claudex
```

That's it. The postinstall script downloads a platform-correct ripgrep binary automatically.

### From source

```bash
git clone https://github.com/AbdoKnbGit/claudex.git
cd claudex
bun install
bun run build
npm link
```

### Requirements

- **Node.js** >= 20.0.0
- **Git** (with git-bash on Windows)
- **Bun** >= 1.1.0 (building from source only)

---

## Launch

```bash
# Interactive mode (full TUI)
claudex

# One-shot print mode
claudex -p "explain this codebase"

# Continue last conversation
claudex -c

# With a specific provider
CLAUDE_CODE_USE_OPENAI=1 claudex
```

### First Run

Set the API key for the provider you want:

```bash
# Anthropic (default — works out of the box with Claude.ai login)
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
export OPENAI_API_KEY=sk-...

# Google Gemini
export GEMINI_API_KEY=AIza...

# Groq (free tier, no billing needed)
export GROQ_API_KEY=gsk_...

# DeepSeek
export DEEPSEEK_API_KEY=sk-...

# OpenRouter
export OPENROUTER_API_KEY=sk-or-...

# NVIDIA NIM
export NIM_API_KEY=nvapi-...

# Ollama — no key needed, just run `ollama serve`
```

Then switch providers at any time with the in-session command:

```
/provider
```

Your selection persists across sessions automatically.

---

## Architecture

```
User Prompt
    |
    v
+-------------------+
|   Agent Loop      |  Tool use, MCP, hooks, skills, permissions
|   (main.tsx)      |  — provider-agnostic, works identically
+-------------------+  for every backend
    |
    v
+-------------------+
|   Provider Shim   |  Duck-types the Anthropic SDK interface
|   (providerShim)  |  so the agent loop sees one API shape
+-------------------+
    |
    +---> OpenAI Adapter -----> OpenAI, Groq, DeepSeek, NIM, Ollama, OpenRouter
    |     (chat/completions)
    +---> Gemini Adapter -----> Google Gemini
    |     (generateContent)
    +---> Anthropic SDK ------> Anthropic, Bedrock, Vertex, Foundry
```

Each adapter handles:
- **Message format translation** — Anthropic content blocks to/from OpenAI messages or Gemini parts
- **Tool call mapping** — Anthropic tool_use/tool_result to OpenAI function_call/tool or Gemini functionCall
- **Cache control stripping** — removes Anthropic-specific `cache_control` fields before sending to third-party APIs
- **Streaming** — native SSE parsing for all providers with proper backpressure
- **Rate limit extraction** — reads X-RateLimit headers, respects Retry-After, exponential backoff with jitter
- **Context window awareness** — tier-based model selection maps opus/sonnet/haiku to the best model at each provider

---

## Features

### Multi-Provider Engine
- **8 providers** — Anthropic, OpenAI, Google Gemini, Groq, DeepSeek, Ollama, NVIDIA NIM, OpenRouter
- **Native adapters** — each provider uses its own API format, not a lowest-common-denominator passthrough
- **Provider tiers** — free/pro/plus model selection per provider with env-var overrides
- **OAuth + API key auth** — API keys for all providers, OAuth for OpenAI and Gemini
- **Persistent selection** — `/provider` command saves your choice across sessions

### Full Agent Tooling
- **File editing** — Read, Edit, Write, Glob, Grep with permission controls
- **Bash execution** — sandboxed shell commands with timeout and abort
- **MCP servers** — full Model Context Protocol support for external tools
- **Hooks** — PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification
- **Skills** — slash commands: /commit, /review-pr, /simplify, /loop, and more
- **Task management** — structured task tracking within sessions
- **Web tools** — WebSearch, WebFetch for live data retrieval

### Developer Experience
- **Interactive TUI** — Ink-based React terminal UI with streaming output
- **Vim mode** — modal editing in the prompt
- **Keyboard shortcuts** — configurable keybindings
- **Debug mode** — `claudex --debug` for full request/response tracing
- **VS Code extension** — companion extension with Control Center, provider switching, project-aware launch

### Resilience
- **Retry with backoff** — up to 10 retries with exponential backoff + jitter for 429/5xx errors
- **Retry-After respect** — honors provider rate-limit headers
- **Context overflow recovery** — auto-reduces max_tokens when hitting context limits
- **Streaming fallback** — NIM and Ollama fall back to non-streaming when needed
- **Cross-platform** — Windows (git-bash), macOS, Linux with no hardcoded paths

---

## Provider Model Table

Default model mappings at the **pro** tier:

| Provider     | Haiku (fast)                  | Sonnet (balanced)             | Opus (best)                   |
|--------------|-------------------------------|-------------------------------|-------------------------------|
| Anthropic    | claude-haiku-4.5              | claude-sonnet-4.6             | claude-opus-4.6               |
| OpenAI       | gpt-5.4-mini                  | gpt-5.4                       | gpt-5.4                       |
| Gemini       | gemini-3.1-flash-lite         | gemini-3.1-pro-preview        | gemini-3.1-pro-preview        |
| Groq         | llama-3.3-70b-versatile       | deepseek-r1-distill-llama-70b | deepseek-r1-distill-llama-70b |
| DeepSeek     | deepseek-chat                 | deepseek-chat                 | deepseek-reasoner             |
| OpenRouter   | openai/gpt-5.4-mini           | openai/gpt-5.4                | anthropic/claude-sonnet-4-5   |
| NVIDIA NIM   | nvidia/llama-3.1-8b-instruct  | moonshotai/kimi-k2.5          | moonshotai/kimi-k2-thinking   |
| Ollama       | llama3.2:latest               | llama3.1:latest               | llama3.3:latest               |

Override any slot:

```bash
export PROVIDER_TIER=plus          # global tier
export OPENAI_TIER=free            # provider-specific tier
export OPENAI_MODEL_OPUS=o3        # pin a specific model
export OLLAMA_MODEL_SONNET=codellama:latest
```

---

## VS Code Extension

The `claudex-vscode/` directory contains a companion VS Code extension:

- **Control Center** — webview panel showing provider state, project info, and launch actions
- **Provider switching** — change providers from the VS Code command palette
- **Project-aware launch** — starts claudex in the right directory with the right context
- **Status bar** — shows active provider and session state

Install from the extension directory:

```bash
cd claudex-vscode
npx @vscode/vsce package --no-dependencies
code --install-extension claudex-vscode-*.vsix
```

---

## Configuration

Claudex reads configuration from `~/.claude/settings.json` (global) and `.claude/settings.json` (project-level), following the same format as Claude Code.

Key settings:

```jsonc
{
  "model": "opus",           // Default model tier
  "effortLevel": "high",     // low | medium | high | max
  "activeProvider": "openai" // Persistent provider selection
}
```

Provider keys are stored in `~/.claude/.credentials.json` (managed by `/login`) or via environment variables.

---

## License

MIT
