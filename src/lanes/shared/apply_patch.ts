/**
 * apply_patch — shared edit primitive
 *
 * Ported line-for-line from codex-rs/apply-patch/src/parser.rs and lib.rs.
 * This is the format OpenAI's Codex models were post-trained on; keeping
 * the behavior identical to the Rust reference is non-negotiable because
 * any drift shows up as quiet quality regressions on edit-heavy tasks.
 *
 * Used by:
 *   - Codex lane (native apply_patch tool)
 *   - Any other lane that wants apply_patch as an opt-in edit primitive
 *
 * Format (Lark grammar from parser.rs):
 *   start: begin_patch hunk+ end_patch
 *   begin_patch: "*** Begin Patch" LF
 *   end_patch:   "*** End Patch" LF?
 *   hunk: add_hunk | delete_hunk | update_hunk
 *   add_hunk:    "*** Add File: " filename LF add_line+
 *   delete_hunk: "*** Delete File: " filename LF
 *   update_hunk: "*** Update File: " filename LF change_move? change?
 *   change_move: "*** Move to: " filename LF
 *   change: (change_context | change_line)+ eof_line?
 *   change_context: ("@@" | "@@ " /(.+)/) LF
 *   change_line: ("+" | "-" | " ") /(.+)/ LF
 *   eof_line: "*** End of File" LF
 *
 * Lenient mode tolerates heredoc wrapping like `<<'EOF' ... EOF` (GPT-4.1
 * emits this when it mistakes local_shell for a real shell).
 */

// ─── Markers ─────────────────────────────────────────────────────

const BEGIN_PATCH_MARKER = '*** Begin Patch'
const END_PATCH_MARKER = '*** End Patch'
const ADD_FILE_MARKER = '*** Add File: '
const DELETE_FILE_MARKER = '*** Delete File: '
const UPDATE_FILE_MARKER = '*** Update File: '
const MOVE_TO_MARKER = '*** Move to: '
const EOF_MARKER = '*** End of File'
const CHANGE_CONTEXT_MARKER = '@@ '
const EMPTY_CHANGE_CONTEXT_MARKER = '@@'

// Parse leniently by default, matching Codex Rust's PARSE_IN_STRICT_MODE = false.
const DEFAULT_LENIENT = true

// ─── Types ───────────────────────────────────────────────────────

export type Hunk =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; movePath?: string; chunks: UpdateFileChunk[] }

export interface UpdateFileChunk {
  /** Single line of context used to narrow down chunk position (often a function/class header). */
  changeContext?: string
  /** Contiguous lines to be replaced. Must occur strictly after changeContext. */
  oldLines: string[]
  /** Replacement lines. */
  newLines: string[]
  /** When true, oldLines must occur at end of file. */
  isEndOfFile: boolean
}

export interface ApplyPatchArgs {
  patch: string
  hunks: Hunk[]
  workdir?: string
}

export class ApplyPatchParseError extends Error {
  constructor(public readonly kind: 'invalid_patch' | 'invalid_hunk', message: string, public readonly lineNumber?: number) {
    super(message)
    this.name = 'ApplyPatchParseError'
  }
}

// ─── Parser ──────────────────────────────────────────────────────

/**
 * Parse an apply_patch body into its hunks. Throws ApplyPatchParseError on
 * malformed input. Accepts heredoc-wrapped bodies when lenient=true (default).
 */
export function parsePatch(patch: string, opts?: { lenient?: boolean }): ApplyPatchArgs {
  const lenient = opts?.lenient ?? DEFAULT_LENIENT
  let lines = patch.trim().split('\n')

  try {
    checkPatchBoundariesStrict(lines)
  } catch (err) {
    if (lenient && err instanceof ApplyPatchParseError && err.kind === 'invalid_patch') {
      const innerLines = checkPatchBoundariesLenient(lines, err)
      lines = innerLines
    } else {
      throw err
    }
  }

  const hunks: Hunk[] = []
  const lastIndex = Math.max(lines.length - 1, 0)
  let remaining = lines.slice(1, lastIndex)
  let lineNumber = 2

  while (remaining.length > 0) {
    const { hunk, consumed } = parseOneHunk(remaining, lineNumber)
    hunks.push(hunk)
    lineNumber += consumed
    remaining = remaining.slice(consumed)
  }

  return {
    patch: lines.join('\n'),
    hunks,
    workdir: undefined,
  }
}

function checkPatchBoundariesStrict(lines: string[]): void {
  const first = lines.length > 0 ? lines[0].trim() : undefined
  const last = lines.length > 0 ? lines[lines.length - 1].trim() : undefined

  if (first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) return

  if (first !== BEGIN_PATCH_MARKER) {
    throw new ApplyPatchParseError(
      'invalid_patch',
      "The first line of the patch must be '*** Begin Patch'",
    )
  }
  throw new ApplyPatchParseError(
    'invalid_patch',
    "The last line of the patch must be '*** End Patch'",
  )
}

// GPT-4.1 emits heredoc-wrapped patches via local_shell. Codex Rust strips
// `<<EOF`, `<<'EOF'`, `<<"EOF"` openings and any `...EOF` closings.
function checkPatchBoundariesLenient(
  original: string[],
  originalError: ApplyPatchParseError,
): string[] {
  if (original.length < 4) throw originalError
  const first = original[0]
  const last = original[original.length - 1]
  const isHeredoc = first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"'
  if (!isHeredoc) throw originalError
  if (!last.endsWith('EOF')) throw originalError

  const inner = original.slice(1, original.length - 1)
  checkPatchBoundariesStrict(inner) // rethrows if still invalid
  return inner
}

function parseOneHunk(
  lines: string[],
  lineNumber: number,
): { hunk: Hunk; consumed: number } {
  const first = lines[0].trim()

  if (first.startsWith(ADD_FILE_MARKER)) {
    const path = first.slice(ADD_FILE_MARKER.length)
    let contents = ''
    let consumed = 1
    for (const line of lines.slice(1)) {
      if (line.startsWith('+')) {
        contents += line.slice(1) + '\n'
        consumed++
      } else {
        break
      }
    }
    return {
      hunk: { kind: 'add', path, contents },
      consumed,
    }
  }

  if (first.startsWith(DELETE_FILE_MARKER)) {
    const path = first.slice(DELETE_FILE_MARKER.length)
    return {
      hunk: { kind: 'delete', path },
      consumed: 1,
    }
  }

  if (first.startsWith(UPDATE_FILE_MARKER)) {
    const path = first.slice(UPDATE_FILE_MARKER.length)
    let remaining = lines.slice(1)
    let consumed = 1

    // Optional *** Move to: line
    let movePath: string | undefined
    if (remaining[0]?.startsWith(MOVE_TO_MARKER)) {
      movePath = remaining[0].slice(MOVE_TO_MARKER.length)
      remaining = remaining.slice(1)
      consumed++
    }

    const chunks: UpdateFileChunk[] = []
    while (remaining.length > 0) {
      // Skip blank lines between chunks
      if (remaining[0].trim() === '') {
        consumed++
        remaining = remaining.slice(1)
        continue
      }
      // Next hunk marker ends this one
      if (remaining[0].startsWith('***')) break

      const { chunk, consumed: chunkConsumed } = parseUpdateFileChunk(
        remaining,
        lineNumber + consumed,
        chunks.length === 0,
      )
      chunks.push(chunk)
      consumed += chunkConsumed
      remaining = remaining.slice(chunkConsumed)
    }

    if (chunks.length === 0) {
      throw new ApplyPatchParseError(
        'invalid_hunk',
        `Update file hunk for path '${path}' is empty`,
        lineNumber,
      )
    }

    return {
      hunk: { kind: 'update', path, movePath, chunks },
      consumed,
    }
  }

  throw new ApplyPatchParseError(
    'invalid_hunk',
    `'${first}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    lineNumber,
  )
}

function parseUpdateFileChunk(
  lines: string[],
  lineNumber: number,
  allowMissingContext: boolean,
): { chunk: UpdateFileChunk; consumed: number } {
  if (lines.length === 0) {
    throw new ApplyPatchParseError(
      'invalid_hunk',
      'Update hunk does not contain any lines',
      lineNumber,
    )
  }

  let startIndex = 0
  let changeContext: string | undefined

  if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
    changeContext = undefined
    startIndex = 1
  } else if (lines[0].startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = lines[0].slice(CHANGE_CONTEXT_MARKER.length)
    startIndex = 1
  } else {
    if (!allowMissingContext) {
      throw new ApplyPatchParseError(
        'invalid_hunk',
        `Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`,
        lineNumber,
      )
    }
    changeContext = undefined
    startIndex = 0
  }

  if (startIndex >= lines.length) {
    throw new ApplyPatchParseError(
      'invalid_hunk',
      'Update hunk does not contain any lines',
      lineNumber + 1,
    )
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  }
  let parsedLines = 0

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]
    if (line === EOF_MARKER) {
      if (parsedLines === 0) {
        throw new ApplyPatchParseError(
          'invalid_hunk',
          'Update hunk does not contain any lines',
          lineNumber + 1,
        )
      }
      chunk.isEndOfFile = true
      parsedLines++
      break
    }

    if (line.length === 0) {
      chunk.oldLines.push('')
      chunk.newLines.push('')
    } else {
      const ch = line[0]
      if (ch === ' ') {
        chunk.oldLines.push(line.slice(1))
        chunk.newLines.push(line.slice(1))
      } else if (ch === '+') {
        chunk.newLines.push(line.slice(1))
      } else if (ch === '-') {
        chunk.oldLines.push(line.slice(1))
      } else {
        if (parsedLines === 0) {
          throw new ApplyPatchParseError(
            'invalid_hunk',
            `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
            lineNumber + 1,
          )
        }
        // Start of next hunk — stop consuming.
        break
      }
    }
    parsedLines++
  }

  return { chunk, consumed: parsedLines + startIndex }
}

// ─── Applicator (seek_sequence port) ─────────────────────────────

/**
 * Find `pattern` within `lines` starting at or after `start`. Tries exact
 * match first, then rstrip-equal, then trim-equal, then Unicode-normalized
 * match. Mirrors seek_sequence.rs — same fallback ladder, same tolerances.
 */
export function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return null

  const searchStart = eof && lines.length >= pattern.length
    ? lines.length - pattern.length
    : start
  const maxStart = lines.length - pattern.length

  // Exact match
  for (let i = searchStart; i <= maxStart; i++) {
    if (arraysEqual(lines.slice(i, i + pattern.length), pattern)) return i
  }
  // rstrip match
  for (let i = searchStart; i <= maxStart; i++) {
    if (rangeEquals(lines, i, pattern, rtrim)) return i
  }
  // trim match
  for (let i = searchStart; i <= maxStart; i++) {
    if (rangeEquals(lines, i, pattern, (s) => s.trim())) return i
  }
  // Unicode-normalized match
  for (let i = searchStart; i <= maxStart; i++) {
    if (rangeEquals(lines, i, pattern, normalize)) return i
  }
  return null
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function rangeEquals(
  lines: string[],
  start: number,
  pattern: string[],
  transform: (s: string) => string,
): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (transform(lines[start + i]) !== transform(pattern[i])) return false
  }
  return true
}

function rtrim(s: string): string {
  return s.replace(/\s+$/, '')
}

// Normalize Unicode punctuation / NBSP so diffs authored in ASCII can apply
// to source containing typographic dashes, smart quotes, NBSPs, etc.
function normalize(s: string): string {
  return s
    .trim()
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, ' ')
}

// ─── Replacement computation ─────────────────────────────────────

export interface Replacement {
  startIndex: number
  oldLen: number
  newLines: string[]
}

export function computeReplacements(
  originalLines: string[],
  path: string,
  chunks: UpdateFileChunk[],
): Replacement[] {
  const replacements: Replacement[] = []
  let lineIndex = 0

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const idx = seekSequence(originalLines, [chunk.changeContext], lineIndex, false)
      if (idx === null) {
        throw new ApplyPatchParseError(
          'invalid_patch',
          `Failed to find context '${chunk.changeContext}' in ${path}`,
        )
      }
      lineIndex = idx + 1
    }

    if (chunk.oldLines.length === 0) {
      // Pure addition — append at end (or just before trailing empty line).
      const insertionIdx = originalLines.length > 0
        && originalLines[originalLines.length - 1] === ''
        ? originalLines.length - 1
        : originalLines.length
      replacements.push({
        startIndex: insertionIdx,
        oldLen: 0,
        newLines: [...chunk.newLines],
      })
      continue
    }

    let pattern: string[] = chunk.oldLines
    let newSlice: string[] = chunk.newLines
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)

    // If the last line of the pattern is empty (common when the model wrote
    // a trailing newline), retry without it — original_lines had its trailing
    // empty stripped before we passed it in.
    if (found === null && pattern.length > 0 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1)
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, -1)
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)
    }

    if (found === null) {
      throw new ApplyPatchParseError(
        'invalid_patch',
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`,
      )
    }

    replacements.push({
      startIndex: found,
      oldLen: pattern.length,
      newLines: [...newSlice],
    })
    lineIndex = found + pattern.length
  }

  replacements.sort((a, b) => a.startIndex - b.startIndex)
  return replacements
}

export function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
  const out = [...lines]
  // Apply in descending order so earlier edits don't shift later indices.
  for (let k = replacements.length - 1; k >= 0; k--) {
    const { startIndex, oldLen, newLines } = replacements[k]
    out.splice(startIndex, oldLen, ...newLines)
  }
  return out
}

/**
 * Apply a parsed chunk list to original file contents, returning the new
 * contents as a single string. Mirrors derive_new_contents_from_chunks
 * in codex-rs/apply-patch/src/lib.rs.
 */
export function deriveNewContents(
  originalContents: string,
  chunks: UpdateFileChunk[],
  path: string,
): string {
  const originalLines = originalContents.split('\n')
  // Drop the trailing empty element that results from the final newline.
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === '') {
    originalLines.pop()
  }

  const replacements = computeReplacements(originalLines, path, chunks)
  const newLines = applyReplacements(originalLines, replacements)
  if (newLines.length === 0 || newLines[newLines.length - 1] !== '') {
    newLines.push('')
  }
  return newLines.join('\n')
}
