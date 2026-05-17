# Git Memory Remember

Save one durable memory into Tau Git Memory.

Choose a lowercase dot path with 2 to 6 segments, for example:

- `preferences.coding.style`
- `project.architecture.memory`
- `feedback.implementation.rules`

Run exactly one Bash tool call and pass the content through stdin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/git-memory.mjs" remember --path "<path>" --tag normal --stdin <<'TAU_GIT_MEMORY_EOF'
<memory content>
TAU_GIT_MEMORY_EOF
```

Use `--tag pinned` for core rules that must be injected every user prompt. Use `--tag fallback` for default rules that should inject only when keyword search finds no normal match.

Use `--append` only when the user wants to add an update to an existing memory instead of replacing it.

Report the saved `fullKey`, `tags`, `branch`, and `commit`.
