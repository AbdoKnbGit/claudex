# `src/services/api/adapters/` — DEPRECATED (Phase 7 of native-lane redesign)

Every file in this directory is scheduled for deletion. They were the
Anthropic-IR round-trip shim that routed third-party providers through
Claude's wire format. The native lanes under `src/lanes/<name>/` now
speak each provider's wire format directly — these adapters are no
longer reached on any request that runs through a healthy native lane.

## Current status

| File | Still used? | Deletion target |
|---|---|---|
| `anthropic_to_gemini.ts` | `sanitizeSchemaForGemini` imported by legacy path | Phase 7, after 1wk no-regression on native lane default-on |
| `gemini_to_anthropic.ts` | Types (`GeminiStreamChunk`, `GeminiGenerateContentResponse`) still re-exported; legacy `gemini_provider.ts` uses them | Phase 7, after legacy providers/gemini_provider.ts is deleted |
| `anthropic_to_openai.ts` | Legacy `openai_provider.ts` | Phase 7 |
| `openai_to_anthropic.ts` | Legacy `openai_provider.ts` | Phase 7 |
| `openai_responses.ts` | Legacy Codex path via `openai_provider.ts` | Phase 7 |
| `tool_schema_cache.ts` | In-flight from the pre-redesign session — review contents before deleting | Phase 7 |
| `gemini_thought_cache.ts` | Actively reads from disk across turns — verify no Gemini lane callers before deletion | Phase 7, gated on long-session fixture confirming no regression |

## Deletion gate (per plan)

Delete only when:

1. `CLAUDEX_NATIVE_LANES` has been default-ON in production for at least
   one week AND
2. No user has reported regressions in the #lanes / issue tracker AND
3. The invariant + fixture test suites are green on CI AND
4. A `grep -rn "adapters/" src/` returns zero matches after the
   corresponding legacy `src/services/api/providers/*_provider.ts`
   files are also deleted.

## Migration guide for internal callers

If you find yourself reaching for one of these adapters in new code:

- Wire format conversion → use the native lane's `convertHistoryToX`
  (internal to the lane, not exported). Add a shared helper to
  `src/lanes/shared/` if two lanes need it.
- Schema sanitization → `sanitizeSchemaForLane(schema, profile)` from
  `src/lanes/shared/mcp_bridge.ts`. The `'gemini'` profile carries the
  full legacy `sanitizeSchemaForGemini` behavior.
- Tool schema cache → the native lane's tool registry is the source
  of truth; lane-owned registries already include everything the cache
  was holding.

The only legitimate reason to touch these files now is to remove them.
