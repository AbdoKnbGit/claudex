# Git Memory Recall

You are retrieving facts from Tau Git Memory.

Use the plugin script, not ad hoc filesystem reads:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/git-memory.mjs" search "<query>" --limit 7
```

If the query names an exact memory path, skip search and fetch it directly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/git-memory.mjs" get "<path>"
```

If search returns paths but the snippets are not enough, batch follow-up `get` calls in one Bash invocation.

Rules:

- Read exact memory values before relying on them.
- Prefer the current branch's memories. The script automatically checks out the memory branch matching the project Git branch.
- Return only relevant recalled facts to the parent answer.
- If no relevant memory exists, say so plainly.
