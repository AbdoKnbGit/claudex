Search Tau Git Memory now for:

```text
$ARGUMENTS
```

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/git-memory.mjs" search --stdin --limit 7 <<'TAU_GIT_MEMORY_EOF'
$ARGUMENTS
TAU_GIT_MEMORY_EOF
```

If a result is clearly relevant and the user needs exact detail, fetch it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/git-memory.mjs" get "<path>"
```

Then answer from the recalled memory content. Mention when no relevant memory exists.
