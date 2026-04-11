# Claudex

**The multi-provider AI coding CLI.** Use Claude Code's full agentic tool loop, MCP servers, hooks, skills, and interactive TUI with every major LLM provider.

Claudex is not a proxy or wrapper. It is a complete reimplementation of the Claude Code runtime with a provider-agnostic core: every provider goes through native adapters that translate the Anthropic tool-use protocol into each provider's native API format, with full streaming, rate-limit handling, and retry logic built in.

**Supported Providers:** Anthropic, OpenAI, Google Gemini, Groq, DeepSeek, Ollama, NVIDIA NIM, OpenRouter

---

## Quick Install

```bash
npm install -g @abdoknbgit/claudex
```

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
```

---

## Commands

### `/provider` - Switch between LLM providers

Opens an interactive picker to switch between all 8 supported providers. Your selection is saved and persists across sessions. Each provider uses its native API format for best performance.

### `/models` - Browse and pick any model

Opens a live model browser that fetches the full model catalog from the selected provider's API. Search, filter, and set any model as your active model.

- `/models` — open interactive provider + model picker
- `/models <query>` — search the active provider's models
- `/models <provider>:<query>` — search a specific provider (e.g. `/models groq:llama`)
- `/model <model-id>` — set a specific model directly (e.g. `/model deepseek-reasoner`)

**Example model counts per provider:**

| Provider     | Models Available |
|--------------|-----------------|
| OpenAI       | 80+             |
| Google Gemini| 30+             |
| OpenRouter   | 300+            |
| Groq         | 15+             |
| DeepSeek     | 5+              |
| NVIDIA NIM   | 100+            |
| Ollama       | varies (local)  |

### `/thinking` - Toggle thinking/reasoning mode

Controls whether the model reasons step-by-step before answering. Works safely across all providers:

- `/thinking` — toggle on/off
- `/thinking on` — enable thinking
- `/thinking off` — disable thinking
- `/thinking status` — show current state and model support

**Decision matrix (zero crashes guaranteed):**

| State | Model Support | Behavior |
|-------|--------------|----------|
| thinking=on | model supports thinking | Thinking enabled |
| thinking=on | model lacks thinking | Request sent normally (param silently omitted) |
| thinking=off | any model | No thinking param sent |

**Models with thinking support:** Claude 4+ (Anthropic), DeepSeek Reasoner, Kimi K2 Thinking (NIM), DeepSeek R1 distill models (Groq)

### `/login` - Authenticate with a provider

Configures API keys or starts an OAuth browser flow for providers that support it (OpenAI, Gemini). For API-key-only providers, prompts for the key and stores it securely.

### `/effort` - Set reasoning effort level

Controls how much effort the model puts into its response: `low`, `medium`, `high`, `max`, or `auto`.

### `/compact` - Compact conversation context

Summarizes the conversation to reduce token usage when approaching context limits.

### Other commands

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/model <id>` | Set a specific model directly |
| `/fast` | Toggle fast mode |
| `/config` | View/edit settings |
| `/commit` | Generate a git commit from staged changes |
| `/review-pr` | Review the current PR |
| `/diff` | Show git diff |
| `/mcp` | Manage MCP servers |
| `/hooks` | Manage hooks |
| `/memory` | Manage persistent memory |
| `/context` | Add files/directories to context |
| `/vim` | Toggle vim mode |

---

## Features

### Multi-Provider Engine
- **8 providers** with native adapters (not a proxy)
- **OAuth + API key auth** for all providers
- **Persistent provider selection** across sessions
- **Automatic tool schema sanitization** per provider (Gemini, OpenAI, Groq)
- **Aggressive payload optimization** for rate-limited providers (Groq)
- **Human-friendly error messages** for billing, quota, and auth errors

### Full Agent Tooling
- **File editing** — Read, Edit, Write, Glob, Grep with permission controls
- **Bash execution** — sandboxed shell commands with timeout and abort
- **MCP servers** — full Model Context Protocol support for external tools
- **Hooks** — PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification
- **Skills** — /commit, /review-pr, /simplify, /loop, and more
- **Task management** — structured task tracking within sessions
- **Web tools** — WebSearch, WebFetch for live data retrieval

### Developer Experience
- **Interactive TUI** — Ink-based React terminal UI with streaming output
- **Thinking mode** — toggle reasoning with `/thinking` across all providers
- **Vim mode** — modal editing in the prompt
- **Keyboard shortcuts** — configurable keybindings
- **Debug mode** — `claudex --debug` for full request/response tracing
- **VS Code extension** — companion extension with Control Center, provider switching, project-aware launch

### Resilience
- **Retry with backoff** — up to 10 retries with exponential backoff + jitter for 429/5xx errors
- **Retry-After respect** — honors provider rate-limit headers
- **Context overflow recovery** — auto-reduces max_tokens when hitting context limits
- **Streaming fallback** — NIM and Ollama fall back to non-streaming when needed
- **Cross-platform** — Windows (git-bash), macOS, Linux

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

## License

MIT
