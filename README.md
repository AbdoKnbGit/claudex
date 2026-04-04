# Claudex

A multi-provider AI coding CLI. Use OpenAI, Gemini, Groq, DeepSeek, Ollama, NVIDIA NIM, OpenRouter — or keep Anthropic as default — all from a single tool with zero workflow changes.

---

## Features

- **Multi-provider support** — switch between Anthropic, OpenAI, Google Gemini, Groq, DeepSeek, Ollama, NVIDIA NIM, and OpenRouter with one command or env var
- **Drop-in compatible** — same commands, same MCP tools, same keybindings you already know
- **Provider tiers** — automatically maps opus/sonnet/haiku slots to the best available model at each provider
- **Persistent provider selection** — use `/provider` to set your active provider once; it persists across sessions
- **OAuth + API key auth** — supports API key auth for all providers, OAuth for OpenAI and Google
- **OpenAI-compatible shim** — Groq, DeepSeek, NVIDIA NIM, and OpenRouter all use the same adapter layer
- **Gemini native adapter** — first-class Google Gemini support with native SSE streaming
- **Ollama local models** — run fully offline with any model you have pulled locally
- **Model overrides via env vars** — pin exact model IDs per provider without touching config files
- **All built-in tools work** — file editing, bash execution, web search, MCP servers, skills, and hooks run unchanged regardless of provider

---

## Requirements

- **Node.js** `>=20.0.0`
- **Bun** `>=1.1.0` (for building from source only)

---

## Install

### From npm (recommended)

```bash
npm install -g claudex
```

### From source

```bash
git clone https://github.com/AbdoKnbGit/claudex.git
cd claudex
bun install
bun run build
npm install -g .
```

---

## Getting Started

### 1. Set your API key

Set the key for whichever provider you want to use:

```bash
# Anthropic (default)
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
export OPENAI_API_KEY=sk-...

# Google Gemini
export GEMINI_API_KEY=AIza...

# Groq (free tier available)
export GROQ_API_KEY=gsk_...

# DeepSeek
export DEEPSEEK_API_KEY=sk-...

# OpenRouter
export OPENROUTER_API_KEY=sk-or-...

# NVIDIA NIM
export NIM_API_KEY=nvapi-...

# Ollama — no key needed, just have Ollama running locally
```

### 2. Launch

```bash
claudex
```

### 3. Switch provider (in-session)

```
/provider
```

Pick from the interactive list. Your selection persists across restarts.

### 4. Switch provider via env var (one-shot)

```bash
CLAUDE_CODE_USE_OPENAI=1 claudex
CLAUDE_CODE_USE_GEMINI=1 claudex
CLAUDE_CODE_USE_GROQ=1 claudex
CLAUDE_CODE_USE_DEEPSEEK=1 claudex
CLAUDE_CODE_USE_OLLAMA=1 claudex
CLAUDE_CODE_USE_OPENROUTER=1 claudex
CLAUDE_CODE_USE_NIM=1 claudex
```

---

## Provider Tiers

Each provider maps `opus`, `sonnet`, and `haiku` to its best available models at three tiers: `free`, `pro`, and `plus`.

| Provider     | Haiku (fast)                  | Sonnet (balanced)             | Opus (best)                   |
|--------------|-------------------------------|-------------------------------|-------------------------------|
| Anthropic    | claude-haiku-4.5              | claude-sonnet-4.6             | claude-opus-4.6               |
| OpenAI       | gpt-5.4-mini                  | gpt-5.4                       | gpt-5.4                       |
| Gemini       | gemini-3.1-flash-lite         | gemini-3.1-pro-preview        | gemini-3.1-pro-preview        |
| Groq         | llama-3.3-70b-versatile       | deepseek-r1-distill-llama-70b | deepseek-r1-distill-llama-70b |
| DeepSeek     | deepseek-chat                 | deepseek-chat                 | deepseek-reasoner             |
| OpenRouter   | openai/gpt-5.4-mini           | openai/gpt-5.4                | anthropic/claude-opus-4-6     |
| NVIDIA NIM   | nvidia/llama-3.1-8b-instruct  | moonshotai/kimi-k2.5          | moonshotai/kimi-k2-thinking   |
| Ollama       | *(your local model)*          | *(your local model)*          | *(your local model)*          |

Set a custom tier with:
```bash
export PROVIDER_TIER=free   # or pro, plus
export OPENAI_TIER=plus     # provider-specific override
```

Override individual model slots:
```bash
export OPENAI_MODEL_OPUS=gpt-5.4-pro
export GEMINI_MODEL_HAIKU=gemini-3-flash-preview
```

---

## Best Practices

**Choose the right provider for the task:**
- Use Anthropic for the most reliable agentic coding sessions
- Use Groq for ultra-fast iteration on simple tasks (free tier, no key cost)
- Use DeepSeek or Ollama when you need full local/offline control
- Use OpenRouter when you want to compare models or need fallback routing

**Keep API keys in your shell profile, not in project files:**
```bash
# Add to ~/.bashrc or ~/.zshrc
export OPENAI_API_KEY=sk-...
```

**Use `/provider` for persistent switching** instead of env vars when you want one provider for all sessions.

**Model pinning for reproducibility:** if your workflow depends on a specific model version, pin it via env var (`OPENAI_MODEL_OPUS`, `GEMINI_MODEL_SONNET`, etc.) so updates to default model IDs don't change your behavior.

**Ollama setup:** make sure Ollama is running (`ollama serve`) and you have at least one model pulled (`ollama pull llama3.3`) before launching with `CLAUDE_CODE_USE_OLLAMA=1`.

---

## License

MIT
