/**
 * Memory merger — loads CLAUDE.md / GEMINI.md / AGENTS.md / QWEN.md
 * interchangeably and returns a single merged context block each lane
 * can inject into its native system prompt.
 *
 * Filename precedence (highest wins for same-key sections):
 *   1. <cwd>/CLAUDE.md         — project-local, highest priority
 *   2. <cwd>/.claude/CLAUDE.md — nested Claude convention
 *   3. <cwd>/AGENTS.md         — OpenCode / cross-CLI standard
 *   4. <cwd>/.opencode/AGENTS.md
 *   5. <cwd>/GEMINI.md + <cwd>/.gemini/GEMINI.md
 *   6. <cwd>/QWEN.md + <cwd>/.qwen/QWEN.md
 *   7. <HOME>/.claude/CLAUDE.md      — user-global
 *   8. <HOME>/.config/opencode/AGENTS.md
 *   9. <HOME>/.gemini/GEMINI.md
 *  10. <HOME>/.qwen/QWEN.md
 *
 * Rationale: project files override user-global files; Claude-flavored
 * files win over agents.md only because most users will put their
 * repo-specific instructions there first. All four are treated as
 * equivalent semantically — if a project carries more than one, they
 * get concatenated with explicit source markers so the model can tell
 * them apart.
 */

import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface MergedMemory {
  /** The merged context block, ready to inject into a lane's prompt. Empty if nothing found. */
  content: string
  /** Which files were read (absolute paths). For diagnostics / `/memory` command. */
  sources: string[]
  /** Total bytes read (for size-budget diagnostics). */
  totalBytes: number
}

export interface MemoryMergeOptions {
  cwd?: string
  /** Cap a single file's size to avoid blowing out the context window. */
  maxBytesPerFile?: number
  /** Absolute cap across all merged files. */
  maxTotalBytes?: number
  /** When true, include user-global (~/) files; defaults to true. */
  includeUserGlobal?: boolean
}

const DEFAULT_MAX_FILE = 64 * 1024    // 64 KB per file
const DEFAULT_MAX_TOTAL = 256 * 1024  // 256 KB total

/**
 * Load every supported memory file reachable from cwd + home, merged
 * into a single context block. Duplicate content (byte-identical) is
 * silently deduplicated.
 */
export function loadMergedMemory(opts: MemoryMergeOptions = {}): MergedMemory {
  const cwd = opts.cwd ?? process.cwd()
  const maxFile = opts.maxBytesPerFile ?? DEFAULT_MAX_FILE
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL
  const includeHome = opts.includeUserGlobal !== false

  const candidates: Array<{ path: string; label: string }> = []

  // Project-local, in priority order.
  candidates.push({ path: join(cwd, 'CLAUDE.md'), label: 'CLAUDE.md' })
  candidates.push({ path: join(cwd, '.claude', 'CLAUDE.md'), label: '.claude/CLAUDE.md' })
  candidates.push({ path: join(cwd, 'AGENTS.md'), label: 'AGENTS.md' })
  candidates.push({ path: join(cwd, '.opencode', 'AGENTS.md'), label: '.opencode/AGENTS.md' })
  candidates.push({ path: join(cwd, 'GEMINI.md'), label: 'GEMINI.md' })
  candidates.push({ path: join(cwd, '.gemini', 'GEMINI.md'), label: '.gemini/GEMINI.md' })
  candidates.push({ path: join(cwd, 'QWEN.md'), label: 'QWEN.md' })
  candidates.push({ path: join(cwd, '.qwen', 'QWEN.md'), label: '.qwen/QWEN.md' })
  candidates.push({ path: join(cwd, '.codex', 'AGENTS.md'), label: '.codex/AGENTS.md' })

  // User-global.
  if (includeHome) {
    const home = homedir()
    candidates.push({ path: join(home, '.claude', 'CLAUDE.md'), label: '~/.claude/CLAUDE.md' })
    candidates.push({ path: join(home, '.config', 'opencode', 'AGENTS.md'), label: '~/.config/opencode/AGENTS.md' })
    candidates.push({ path: join(home, '.gemini', 'GEMINI.md'), label: '~/.gemini/GEMINI.md' })
    candidates.push({ path: join(home, '.qwen', 'QWEN.md'), label: '~/.qwen/QWEN.md' })
    candidates.push({ path: join(home, '.codex', 'AGENTS.md'), label: '~/.codex/AGENTS.md' })
  }

  const seenHashes = new Set<string>()
  const sources: string[] = []
  const sections: string[] = []
  let totalBytes = 0

  for (const { path, label } of candidates) {
    if (totalBytes >= maxTotal) break
    if (!safeExists(path)) continue

    try {
      const stats = statSync(path)
      if (!stats.isFile()) continue
      if (stats.size === 0) continue
      // Drop oversized files — the model's context window matters more
      // than a completeness guarantee here.
      const remainingBudget = maxTotal - totalBytes
      const readLimit = Math.min(maxFile, remainingBudget)
      if (stats.size > readLimit && readLimit < 1024) continue

      let content = readFileSync(path, 'utf8')
      if (content.length > readLimit) {
        content = content.slice(0, readLimit) + '\n\n[…truncated for context-window budget]'
      }
      const trimmed = content.trim()
      if (!trimmed) continue

      const hash = cheapHash(trimmed)
      if (seenHashes.has(hash)) continue
      seenHashes.add(hash)

      sources.push(path)
      sections.push(`<!-- source: ${label} -->\n${trimmed}`)
      totalBytes += Buffer.byteLength(trimmed, 'utf8')
    } catch {
      // Unreadable files are skipped silently — they shouldn't break
      // the lane. Permission / symlink / binary-in-a-.md-file etc.
    }
  }

  const content = sections.length === 0
    ? ''
    : sections.join('\n\n---\n\n')

  return { content, sources, totalBytes }
}

function safeExists(path: string): boolean {
  try { return existsSync(path) } catch { return false }
}

// Fast content-identity hash — djb2 variant. Good enough for "same body
// of text submitted twice" dedup, not a cryptographic hash.
function cheapHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i)
  }
  return String(h >>> 0)
}
