Save the user's input into Tau Git Memory now.

Supported tags are `pinned`, `fallback`, and `normal`. If no tag is provided, use `normal`.

Input:

```text
$ARGUMENTS
```

Run the capture command:

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/git-memory.mjs" remember-text --stdin <<'TAU_GIT_MEMORY_EOF'
$ARGUMENTS
TAU_GIT_MEMORY_EOF
```

Report the saved `fullKey`, `tags`, `branch`, and `commit`. If the command returns `ok: false`, show the usage error.
