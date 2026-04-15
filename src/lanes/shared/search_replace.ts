/**
 * Aider-style SEARCH/REPLACE edit-block parser + applicator.
 *
 * This is the fallback edit format for the OpenAI-compatible lane when
 * apply_patch is unreliable (smaller / non-frontier models tend to mangle
 * apply_patch but handle SEARCH/REPLACE cleanly — it's much simpler).
 *
 * Format (canonical Aider grammar):
 *
 *   path/to/file.ts
 *   ```typescript
 *   <<<<<<< SEARCH
 *   old content
 *   =======
 *   new content
 *   >>>>>>> REPLACE
 *   ```
 *
 * Reference: Aider's editblock_coder.py. Regex + matching ladder ported.
 */

// ─── Types ───────────────────────────────────────────────────────

export interface SearchReplaceBlock {
  /** File path. May be inferred from previous block if omitted. */
  path: string
  /**
   * Lines to search for. Empty → new-file creation (path must not exist).
   * Matching is exact first, then whitespace-flexible, then fuzzy.
   */
  searchLines: string[]
  /** Replacement lines. */
  replaceLines: string[]
}

export class SearchReplaceParseError extends Error {
  constructor(message: string, public readonly lineNumber?: number) {
    super(message)
    this.name = 'SearchReplaceParseError'
  }
}

// ─── Markers ─────────────────────────────────────────────────────

// Aider accepts 5–9 repeats of the marker char to tolerate emission drift.
const HEAD_RE = /^<{5,9} SEARCH>?\s*$/
const DIVIDER_RE = /^={5,9}\s*$/
const UPDATED_RE = /^>{5,9} REPLACE\s*$/

// Default fence. Aider supports custom fences via config; we accept ```
// and ~~~ which cover 99% of model outputs.
const FENCE_RE = /^```[\w-]*$|^~~~[\w-]*$/

// ─── Parser ──────────────────────────────────────────────────────

/**
 * Parse all SEARCH/REPLACE blocks out of a model message. Inherits the
 * filename from the previous block when a block doesn't declare one.
 *
 * Throws SearchReplaceParseError on malformed markers. Returns [] when
 * no blocks are present (caller may treat that as "no edits").
 */
export function parseSearchReplace(text: string): SearchReplaceBlock[] {
  const lines = text.split('\n')
  const blocks: SearchReplaceBlock[] = []
  let currentFilename: string | null = null
  let i = 0

  while (i < lines.length) {
    // Scan for the next HEAD marker.
    if (!HEAD_RE.test(lines[i])) {
      i++
      continue
    }

    // Find the filename: walk backward skipping fences and blank lines.
    const filename: string | null = findFilenameBefore(lines, i) ?? currentFilename
    if (!filename) {
      throw new SearchReplaceParseError(
        'SEARCH/REPLACE block at line ' + (i + 1) + ' has no filename and no prior block to inherit from',
        i + 1,
      )
    }
    currentFilename = filename

    // Consume SEARCH content until DIVIDER.
    const searchStart = i + 1
    let dividerIdx = -1
    for (let j = searchStart; j < lines.length; j++) {
      if (DIVIDER_RE.test(lines[j])) {
        dividerIdx = j
        break
      }
      // Early-abort if we see another HEAD before the divider (malformed).
      if (HEAD_RE.test(lines[j]) || UPDATED_RE.test(lines[j])) {
        throw new SearchReplaceParseError(
          "SEARCH/REPLACE block missing '=======' divider",
          searchStart,
        )
      }
    }
    if (dividerIdx === -1) {
      throw new SearchReplaceParseError(
        "SEARCH/REPLACE block missing '=======' divider",
        searchStart,
      )
    }

    // Consume REPLACE content until UPDATED.
    const replaceStart = dividerIdx + 1
    let updatedIdx = -1
    for (let j = replaceStart; j < lines.length; j++) {
      if (UPDATED_RE.test(lines[j])) {
        updatedIdx = j
        break
      }
      if (HEAD_RE.test(lines[j]) || DIVIDER_RE.test(lines[j])) {
        throw new SearchReplaceParseError(
          "SEARCH/REPLACE block missing '>>>>>>> REPLACE' closer",
          replaceStart,
        )
      }
    }
    if (updatedIdx === -1) {
      throw new SearchReplaceParseError(
        "SEARCH/REPLACE block missing '>>>>>>> REPLACE' closer",
        replaceStart,
      )
    }

    const searchLines = lines.slice(searchStart, dividerIdx)
    const replaceLines = lines.slice(replaceStart, updatedIdx)

    blocks.push({
      path: filename,
      searchLines,
      replaceLines,
    })

    i = updatedIdx + 1
  }

  return blocks
}

// Walk backward from the HEAD line to find a filename. Stops at blank lines
// or the top of the input. Strips leading # / backticks / asterisks and
// trailing : / backticks that models often add cosmetically.
function findFilenameBefore(lines: string[], headIdx: number): string | null {
  for (let j = headIdx - 1; j >= 0; j--) {
    const raw = lines[j]
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    if (FENCE_RE.test(trimmed)) continue // skip the opening fence
    // Skip "..." ellipsis lines — Aider treats them as connective tissue.
    if (trimmed === '...') continue

    const cleaned = trimmed
      .replace(/^#+\s*/, '')
      .replace(/:+$/, '')
      .replace(/`+/g, '')
      .replace(/\*+/g, '')
      .trim()

    if (cleaned.length === 0) return null
    // Sanity: a filename shouldn't contain the marker characters.
    if (cleaned.includes('<<<<<<<') || cleaned.includes('>>>>>>>')) return null
    return cleaned
  }
  return null
}

// ─── Applicator ──────────────────────────────────────────────────

/**
 * Replace `searchLines` in `originalContents` with `replaceLines`.
 * Empty `searchLines` means "new file creation" — the caller must verify
 * the file doesn't exist. Returns the new contents or throws on failure.
 *
 * Matching ladder (Aider's editblock_coder.py order):
 *   1. Exact match (line-for-line equality)
 *   2. Whitespace-flexible (normalize leading indentation)
 *   3. Ellipsis: SEARCH contains `...` lines — treat as "any content between"
 *   4. Fuzzy match via SequenceMatcher-like ratio ≥ 0.8
 */
export function applySearchReplace(
  originalContents: string,
  block: SearchReplaceBlock,
): string {
  // New-file creation.
  if (block.searchLines.length === 0) {
    return block.replaceLines.join('\n') + (block.replaceLines.length > 0 ? '\n' : '')
  }

  const originalLines = originalContents.split('\n')

  // Strategy 1: exact match.
  const exactIdx = findExactMatch(originalLines, block.searchLines)
  if (exactIdx !== null) {
    const before = originalLines.slice(0, exactIdx)
    const after = originalLines.slice(exactIdx + block.searchLines.length)
    return [...before, ...block.replaceLines, ...after].join('\n')
  }

  // Strategy 2: whitespace-flexible match (preserve target indentation).
  const wsResult = findWhitespaceFlexibleMatch(originalLines, block.searchLines)
  if (wsResult !== null) {
    const { index, targetIndent, searchIndent } = wsResult
    const reindent = computeReindent(targetIndent, searchIndent)
    const before = originalLines.slice(0, index)
    const after = originalLines.slice(index + block.searchLines.length)
    const newLines = block.replaceLines.map(l => reindent(l))
    return [...before, ...newLines, ...after].join('\n')
  }

  // Strategy 3: ellipsis handling.
  const ellipsisResult = findEllipsisMatch(originalLines, block.searchLines, block.replaceLines)
  if (ellipsisResult !== null) return ellipsisResult.join('\n')

  // Strategy 4: fuzzy match.
  const fuzzyIdx = findFuzzyMatch(originalLines, block.searchLines, 0.8)
  if (fuzzyIdx !== null) {
    const before = originalLines.slice(0, fuzzyIdx)
    const after = originalLines.slice(fuzzyIdx + block.searchLines.length)
    return [...before, ...block.replaceLines, ...after].join('\n')
  }

  throw new SearchReplaceParseError(
    'Could not find SEARCH content in ' + block.path + ':\n'
    + block.searchLines.slice(0, 5).join('\n')
    + (block.searchLines.length > 5 ? '\n…' : ''),
  )
}

/** Apply every block in order, folding results into one file-by-file map. */
export function applySearchReplaceBlocks(
  fileContents: Record<string, string>,
  blocks: SearchReplaceBlock[],
): Record<string, string> {
  const out: Record<string, string> = { ...fileContents }
  for (const block of blocks) {
    const current = out[block.path] ?? ''
    out[block.path] = applySearchReplace(current, block)
  }
  return out
}

// ─── Matching Strategies ─────────────────────────────────────────

function findExactMatch(lines: string[], pattern: string[]): number | null {
  if (pattern.length === 0 || pattern.length > lines.length) return null
  outer: for (let i = 0; i <= lines.length - pattern.length; i++) {
    for (let k = 0; k < pattern.length; k++) {
      if (lines[i + k] !== pattern[k]) continue outer
    }
    return i
  }
  return null
}

interface WhitespaceMatch {
  index: number
  targetIndent: string
  searchIndent: string
}

// Match ignoring leading indentation delta. Returns the target's common
// leading-whitespace so the applicator can re-indent the replace block.
function findWhitespaceFlexibleMatch(
  lines: string[],
  pattern: string[],
): WhitespaceMatch | null {
  if (pattern.length === 0 || pattern.length > lines.length) return null
  const searchIndent = commonLeadingWhitespace(pattern)

  outer: for (let i = 0; i <= lines.length - pattern.length; i++) {
    const slice = lines.slice(i, i + pattern.length)
    const targetIndent = commonLeadingWhitespace(slice)
    for (let k = 0; k < pattern.length; k++) {
      const a = stripLeading(slice[k], targetIndent)
      const b = stripLeading(pattern[k], searchIndent)
      if (a.trimEnd() !== b.trimEnd()) continue outer
    }
    return { index: i, targetIndent, searchIndent }
  }
  return null
}

function commonLeadingWhitespace(lines: string[]): string {
  let prefix: string | null = null
  for (const line of lines) {
    if (line.trim() === '') continue
    const match = line.match(/^(\s*)/)
    const lead = match ? match[1] : ''
    if (prefix === null) prefix = lead
    else {
      let common = ''
      for (let i = 0; i < Math.min(prefix.length, lead.length); i++) {
        if (prefix[i] === lead[i]) common += prefix[i]
        else break
      }
      prefix = common
    }
  }
  return prefix ?? ''
}

function stripLeading(line: string, prefix: string): string {
  return line.startsWith(prefix) ? line.slice(prefix.length) : line.replace(/^\s+/, '')
}

function computeReindent(target: string, search: string): (line: string) => string {
  // Preserve the target's indent level by stripping the search-block's
  // common indent and prepending the target's common indent.
  return (line: string) => {
    if (line.trim() === '') return line
    const stripped = line.startsWith(search) ? line.slice(search.length) : line
    return target + stripped
  }
}

// Ellipsis: SEARCH may contain lines that are literally `...` meaning
// "any content between". We split on `...`, match each segment via exact
// match, then splice from original-before-first-segment through the
// replaced segments (REPLACE is split by `...` the same way).
function findEllipsisMatch(
  lines: string[],
  searchLines: string[],
  replaceLines: string[],
): string[] | null {
  const searchHasEllipsis = searchLines.some(l => l.trim() === '...')
  const replaceHasEllipsis = replaceLines.some(l => l.trim() === '...')
  if (!searchHasEllipsis) return null

  const searchSegments = splitByEllipsis(searchLines)
  const replaceSegments = replaceHasEllipsis ? splitByEllipsis(replaceLines) : null
  if (replaceSegments && replaceSegments.length !== searchSegments.length) return null

  // Locate each search segment in order.
  const segmentIndices: number[] = []
  let start = 0
  for (const seg of searchSegments) {
    const idx = findExactMatch(lines.slice(start), seg)
    if (idx === null) return null
    segmentIndices.push(start + idx)
    start = start + idx + seg.length
  }

  // Build the output: keep lines before first segment, interleave replaced
  // segments with the connective tissue between originals.
  const out: string[] = []
  out.push(...lines.slice(0, segmentIndices[0]))
  for (let k = 0; k < searchSegments.length; k++) {
    const seg = searchSegments[k]
    const newSeg = replaceSegments ? replaceSegments[k] : (k === 0 ? replaceLines : [])
    out.push(...newSeg)
    const segEnd = segmentIndices[k] + seg.length
    const next = k + 1 < segmentIndices.length ? segmentIndices[k + 1] : lines.length
    out.push(...lines.slice(segEnd, next))
  }
  return out
}

function splitByEllipsis(lines: string[]): string[][] {
  const out: string[][] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.trim() === '...') {
      if (current.length > 0) out.push(current)
      current = []
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

function findFuzzyMatch(
  lines: string[],
  pattern: string[],
  threshold: number,
): number | null {
  if (pattern.length === 0 || pattern.length > lines.length) return null
  let bestIdx = -1
  let bestRatio = 0
  for (let i = 0; i <= lines.length - pattern.length; i++) {
    const slice = lines.slice(i, i + pattern.length)
    const ratio = similarity(slice.join('\n'), pattern.join('\n'))
    if (ratio > bestRatio) {
      bestRatio = ratio
      bestIdx = i
    }
  }
  return bestRatio >= threshold ? bestIdx : null
}

// Jaccard-ish similarity on token sets — cheap approximation of Python's
// SequenceMatcher.ratio() that avoids the full Ratcliff-Obershelp impl.
// Fine for coarse "is this mostly the same paragraph" fuzzy matching.
function similarity(a: string, b: string): number {
  const tokensA = new Set(a.trim().split(/\s+/).filter(Boolean))
  const tokensB = new Set(b.trim().split(/\s+/).filter(Boolean))
  if (tokensA.size === 0 && tokensB.size === 0) return 1
  let intersect = 0
  tokensA.forEach(t => { if (tokensB.has(t)) intersect++ })
  const union = tokensA.size + tokensB.size - intersect
  return union === 0 ? 0 : intersect / union
}
