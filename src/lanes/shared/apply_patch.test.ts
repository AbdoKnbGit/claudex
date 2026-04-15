/**
 * Self-check smoke tests for apply_patch parser + applicator.
 * Mirrors the critical test cases from codex-rs/apply-patch/src/parser.rs
 * and seek_sequence.rs. Run via `bun run src/lanes/shared/apply_patch.test.ts`.
 */

import {
  parsePatch,
  seekSequence,
  deriveNewContents,
  ApplyPatchParseError,
  type Hunk,
} from './apply_patch.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function eq<T>(actual: T, expected: T, hint?: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    throw new Error(`${hint ?? 'assertion'}\n  expected: ${b}\n  actual:   ${a}`)
  }
}

function throws(fn: () => unknown, match?: string): void {
  try {
    fn()
  } catch (e: any) {
    if (match && !String(e?.message ?? e).includes(match)) {
      throw new Error(`Error message did not contain "${match}": ${e?.message ?? e}`)
    }
    return
  }
  throw new Error('Expected throw, got none')
}

// ─── parser tests ────────────────────────────────────────────────

console.log('parser:')

test('rejects missing begin marker', () => {
  throws(() => parsePatch('bad', { lenient: false }), "must be '*** Begin Patch'")
})

test('rejects missing end marker', () => {
  throws(() => parsePatch('*** Begin Patch\nbad', { lenient: false }), "must be '*** End Patch'")
})

test('parses add-file hunk', () => {
  const r = parsePatch('*** Begin Patch\n*** Add File: foo\n+hi\n*** End Patch', { lenient: false })
  const expected: Hunk[] = [{ kind: 'add', path: 'foo', contents: 'hi\n' }]
  eq(r.hunks, expected)
})

test('rejects empty update hunk', () => {
  throws(
    () => parsePatch('*** Begin Patch\n*** Update File: test.py\n*** End Patch', { lenient: false }),
    "Update file hunk for path 'test.py' is empty",
  )
})

test('parses empty patch body', () => {
  const r = parsePatch('*** Begin Patch\n*** End Patch', { lenient: false })
  eq(r.hunks, [])
})

test('parses mixed hunks with move_to and context', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: path/add.py',
    '+abc',
    '+def',
    '*** Delete File: path/delete.py',
    '*** Update File: path/update.py',
    '*** Move to: path/update2.py',
    '@@ def f():',
    '-    pass',
    '+    return 123',
    '*** End Patch',
  ].join('\n')
  const r = parsePatch(patch, { lenient: false })
  eq(r.hunks.length, 3)
  eq(r.hunks[0], { kind: 'add', path: 'path/add.py', contents: 'abc\ndef\n' })
  eq(r.hunks[1], { kind: 'delete', path: 'path/delete.py' })
  const update = r.hunks[2] as Extract<Hunk, { kind: 'update' }>
  eq(update.kind, 'update')
  eq(update.path, 'path/update.py')
  eq(update.movePath, 'path/update2.py')
  eq(update.chunks.length, 1)
  eq(update.chunks[0], {
    changeContext: 'def f():',
    oldLines: ['    pass'],
    newLines: ['    return 123'],
    isEndOfFile: false,
  })
})

test('update without @@ parses when lenient-allow-missing-context applies', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: file2.py',
    ' import foo',
    '+bar',
    '*** End Patch',
  ].join('\n')
  const r = parsePatch(patch, { lenient: false })
  const update = r.hunks[0] as Extract<Hunk, { kind: 'update' }>
  eq(update.chunks[0], {
    changeContext: undefined,
    oldLines: ['import foo'],
    newLines: ['import foo', 'bar'],
    isEndOfFile: false,
  })
})

test('lenient mode strips heredoc wrappers (<<EOF)', () => {
  const inner = [
    '*** Begin Patch',
    '*** Update File: file.py',
    ' import foo',
    '+bar',
    '*** End Patch',
  ].join('\n')
  const wrapped = `<<EOF\n${inner}\nEOF`
  const r = parsePatch(wrapped)
  eq(r.hunks.length, 1)
  const update = r.hunks[0] as Extract<Hunk, { kind: 'update' }>
  eq(update.path, 'file.py')
})

test("lenient mode strips single-quoted heredoc (<<'EOF')", () => {
  const inner = `*** Begin Patch\n*** Add File: x\n+a\n*** End Patch`
  const r = parsePatch(`<<'EOF'\n${inner}\nEOF`)
  eq(r.hunks.length, 1)
})

// ─── seek_sequence tests ─────────────────────────────────────────

console.log('seek_sequence:')

test('exact match finds sequence', () => {
  eq(seekSequence(['foo', 'bar', 'baz'], ['bar', 'baz'], 0, false), 1)
})

test('rstrip match ignores trailing whitespace', () => {
  eq(seekSequence(['foo   ', 'bar\t\t'], ['foo', 'bar'], 0, false), 0)
})

test('trim match ignores leading+trailing whitespace', () => {
  eq(seekSequence(['    foo   ', '   bar\t'], ['foo', 'bar'], 0, false), 0)
})

test('pattern longer than input returns null', () => {
  eq(seekSequence(['one'], ['a', 'b', 'c'], 0, false), null)
})

test('empty pattern returns start', () => {
  eq(seekSequence(['a', 'b'], [], 3, false), 3)
})

test('unicode normalization matches smart quotes', () => {
  eq(seekSequence(['say \u201Chi\u201D'], ['say "hi"'], 0, false), 0)
})

// ─── apply tests ─────────────────────────────────────────────────

console.log('apply:')

test('applies a simple replace chunk', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: a.txt',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n')
  const { hunks } = parsePatch(patch, { lenient: false })
  const update = hunks[0] as Extract<Hunk, { kind: 'update' }>
  const original = 'foo\nold\nbar\n'
  const result = deriveNewContents(original, update.chunks, update.path)
  eq(result, 'foo\nnew\nbar\n')
})

test('applies add-only chunk to empty context', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: a.txt',
    '@@',
    '+appended',
    '*** End Patch',
  ].join('\n')
  const { hunks } = parsePatch(patch, { lenient: false })
  const update = hunks[0] as Extract<Hunk, { kind: 'update' }>
  const original = 'line1\nline2\n'
  const result = deriveNewContents(original, update.chunks, update.path)
  eq(result, 'line1\nline2\nappended\n')
})

test('applies chunk with change_context narrowing', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: b.txt',
    '@@ section B',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n')
  const { hunks } = parsePatch(patch, { lenient: false })
  const update = hunks[0] as Extract<Hunk, { kind: 'update' }>
  const original = 'section A\nold\nsection B\nold\ntail\n'
  const result = deriveNewContents(original, update.chunks, update.path)
  // Context 'section B' scoped the match to the second 'old'.
  eq(result, 'section A\nold\nsection B\nnew\ntail\n')
})

test('fails gracefully on missing context', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: c.txt',
    '@@',
    '-nope',
    '+new',
    '*** End Patch',
  ].join('\n')
  const { hunks } = parsePatch(patch, { lenient: false })
  const update = hunks[0] as Extract<Hunk, { kind: 'update' }>
  throws(
    () => deriveNewContents('foo\nbar\n', update.chunks, update.path),
    'Failed to find expected lines',
  )
})

// ─── summary ─────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
