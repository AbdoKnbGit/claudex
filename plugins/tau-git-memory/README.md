# Tau Git Memory

Prototype Tau plugin for local, Git-backed memory.

It stores memories as Markdown files in a small Git repository and keeps the memory branch aligned with the current project Git branch. It does not use Docker, a vector database, embeddings, or a background service.

## Test Locally

Use it for one Tau session:

```bash
tau --plugin-dir C:/Users/ok/Desktop/claudex/plugins/tau-git-memory
```

Or register the local marketplace:

```bash
tau plugin marketplace add C:/Users/ok/Desktop/claudex/plugins
tau plugin install tau-git-memory@claude-code-git-memory
```

## Storage

Default store:

```text
~/.tau/git-memory/<project-slug>
```

Override it when testing:

```bash
TAU_GIT_MEMORY_STORE=/tmp/tau-memory-test tau --plugin-dir C:/Users/ok/Desktop/claudex/plugins/tau-git-memory
```

## Commands

- `/tau-git-memory:status`
- `/tau-git-memory:remember [--tag pinned|fallback|normal] <path> <memory>`
- `/tau-git-memory:recall <query>`
- `/tau-git-memory:tree`

Memory paths are dot-separated, for example `preferences.coding.style` or `project.architecture.memory`.
If no tag is provided, the memory is saved as `normal`.

Useful examples:

```text
/tau-git-memory:remember --tag pinned preferences.coding.style Keep edits focused and follow existing project patterns.
/tau-git-memory:remember --tag fallback project.default.rules When unsure, inspect files before changing behavior.
/tau-git-memory:remember project.setup.commands Use npm test before committing.
```

## Context Injection

The plugin uses Tau hooks:

- `SessionStart` reads an existing store, injects the tag-zone rules, a compact list of available memory paths, and cached compact `pinned` snippets.
- `UserPromptSubmit` keyword-searches `normal` memories on the current memory branch.
- If keyword search finds matches above the score floor, it injects keyword matches.
- If keyword search finds no normal match, it injects `fallback` memories.
- Pinned and fallback memories are not searched for keyword injection because they belong to separate zones.

Hooks fast-return when the project has no initialized memory store. Manual commands such as `/tau-git-memory:remember` and `/tau-git-memory:status` still initialize the store.

If the current memory branch exists but has no memories, read hooks and recall commands fall back to `main` by default, restore the original branch after reading, and label the fallback source in injected context.

It does not inject the whole memory store every turn. Snippets are compacted to control context cost and prefer sentence or word boundaries before hard character cuts. It also does not use an embedding cache or vector database. The source of truth is the Git-backed Markdown files on disk; each hook reads the current branch and searches those files.

## Tuning

- `TAU_GIT_MEMORY_MIN_SCORE` sets the keyword relevance floor. Default: `2`.
- `TAU_GIT_MEMORY_FALLBACK_BRANCH` sets the read fallback branch when the current memory branch is empty. Default: `main`.
- `TAU_GIT_MEMORY_KEYWORD_LIMIT`, `TAU_GIT_MEMORY_FALLBACK_LIMIT`, `TAU_GIT_MEMORY_PINNED_LIMIT`, and `TAU_GIT_MEMORY_SNIPPET_CHARS` tune context size.
