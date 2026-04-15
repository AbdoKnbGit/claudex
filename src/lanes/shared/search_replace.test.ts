/**
 * Smoke tests for the SEARCH/REPLACE parser + applicator.
 * Run via `bun run src/lanes/shared/search_replace.test.ts`.
 */

import {
  parseSearchReplace,
  applySearchReplace,
  applySearchReplaceBlocks,
  SearchReplaceParseError,
} from './search_replace.js'

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

function eq<T>(a: T, b: T, hint?: string): void {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa !== sb) throw new Error(`${hint ?? 'assertion'}\n  expected: ${sb}\n  actual:   ${sa}`)
}

function throws(fn: () => unknown, match?: string): void {
  try { fn() } catch (e: any) {
    if (match && !String(e?.message ?? e).includes(match)) {
      throw new Error(`Error message did not contain "${match}": ${e?.message ?? e}`)
    }
    return
  }
  throw new Error('Expected throw, got none')
}

console.log('parser:')

test('parses a basic block', () => {
  const msg = [
    'here\'s the edit:',
    '',
    'src/foo.ts',
    '```typescript',
    '<<<<<<< SEARCH',
    'const a = 1',
    '=======',
    'const a = 2',
    '>>>>>>> REPLACE',
    '```',
  ].join('\n')
  const blocks = parseSearchReplace(msg)
  eq(blocks.length, 1)
  eq(blocks[0], {
    path: 'src/foo.ts',
    searchLines: ['const a = 1'],
    replaceLines: ['const a = 2'],
  })
})

test('inherits filename across adjacent blocks', () => {
  const msg = [
    'src/foo.ts',
    '<<<<<<< SEARCH',
    'a',
    '=======',
    'A',
    '>>>>>>> REPLACE',
    '',
    '<<<<<<< SEARCH',
    'b',
    '=======',
    'B',
    '>>>>>>> REPLACE',
  ].join('\n')
  const blocks = parseSearchReplace(msg)
  eq(blocks.length, 2)
  eq(blocks[0].path, 'src/foo.ts')
  eq(blocks[1].path, 'src/foo.ts')
})

test('handles 7-char markers', () => {
  const msg = [
    'a.ts',
    '<<<<<<< SEARCH',
    'x',
    '=======',
    'y',
    '>>>>>>> REPLACE',
  ].join('\n')
  eq(parseSearchReplace(msg).length, 1)
})

test('handles 9-char markers', () => {
  const msg = [
    'a.ts',
    '<<<<<<<<< SEARCH',
    'x',
    '=========',
    'y',
    '>>>>>>>>> REPLACE',
  ].join('\n')
  eq(parseSearchReplace(msg).length, 1)
})

test('throws on unclosed search', () => {
  const msg = [
    'a.ts',
    '<<<<<<< SEARCH',
    'unclosed',
  ].join('\n')
  throws(() => parseSearchReplace(msg), 'divider')
})

test('throws on missing filename with no prior block', () => {
  const msg = [
    '<<<<<<< SEARCH',
    'x',
    '=======',
    'y',
    '>>>>>>> REPLACE',
  ].join('\n')
  throws(() => parseSearchReplace(msg), 'no filename')
})

test('strips backticks and colons from filename line', () => {
  const msg = [
    '`src/foo.ts`:',
    '<<<<<<< SEARCH',
    'x',
    '=======',
    'y',
    '>>>>>>> REPLACE',
  ].join('\n')
  eq(parseSearchReplace(msg)[0].path, 'src/foo.ts')
})

test('detects new-file creation (empty SEARCH)', () => {
  const msg = [
    'new.ts',
    '<<<<<<< SEARCH',
    '=======',
    'hello',
    '>>>>>>> REPLACE',
  ].join('\n')
  const [block] = parseSearchReplace(msg)
  eq(block.searchLines, [])
  eq(block.replaceLines, ['hello'])
})

console.log('apply:')

test('exact match replaces', () => {
  const original = 'line1\nold\nline3\n'
  const result = applySearchReplace(original, {
    path: 'a.ts',
    searchLines: ['old'],
    replaceLines: ['new'],
  })
  eq(result, 'line1\nnew\nline3\n')
})

test('whitespace-flexible match preserves target indent', () => {
  const original = '    x = 1\n    y = 2\n'
  const result = applySearchReplace(original, {
    path: 'a.ts',
    searchLines: ['x = 1'],
    replaceLines: ['x = 100'],
  })
  eq(result, '    x = 100\n    y = 2\n')
})

test('new-file creation returns replace content', () => {
  const result = applySearchReplace('', {
    path: 'new.ts',
    searchLines: [],
    replaceLines: ['hello', 'world'],
  })
  eq(result, 'hello\nworld\n')
})

test('throws when search content not found', () => {
  throws(
    () => applySearchReplace('nothing here', {
      path: 'a.ts',
      searchLines: ['xxxxxxxxx', 'yyyyyyyyy'],
      replaceLines: ['z'],
    }),
    'Could not find SEARCH content',
  )
})

test('applySearchReplaceBlocks folds sequential edits', () => {
  const files = {
    'a.ts': 'start\nold\nend\n',
  }
  const blocks = [
    { path: 'a.ts', searchLines: ['old'], replaceLines: ['middle'] },
    { path: 'b.ts', searchLines: [], replaceLines: ['new file'] },
  ]
  const out = applySearchReplaceBlocks(files, blocks)
  eq(out['a.ts'], 'start\nmiddle\nend\n')
  eq(out['b.ts'], 'new file\n')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
