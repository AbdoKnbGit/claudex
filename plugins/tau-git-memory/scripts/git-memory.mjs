#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const HOOK_COMMANDS = new Set([
  'hook-session-start',
  'hook-user-prompt-submit',
])

const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'and',
  'any',
  'are',
  'before',
  'but',
  'can',
  'did',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'into',
  'its',
  'just',
  'then',
  'than',
  'they',
  'will',
  'been',
  'more',
  'not',
  'now',
  'our',
  'past',
  'please',
  'same',
  'should',
  'that',
  'the',
  'this',
  'was',
  'what',
  'when',
  'where',
  'with',
  'you',
])

const MEMORY_TAGS = new Set(['pinned', 'fallback', 'normal'])
const TAG_ALIASES = new Map([
  ['pin', 'pinned'],
  ['pined', 'pinned'],
  ['pins', 'pinned'],
])

const DEFAULT_KEYWORD_LIMIT = 5
const DEFAULT_FALLBACK_LIMIT = 5
const DEFAULT_SNIPPET_CHARS = 280
const DEFAULT_MIN_SCORE = 2
const RECENT_7_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const RECENT_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const RECENT_7_DAYS_SCORE = 2
const RECENT_30_DAYS_SCORE = 1
const BIGRAM_PATH_SCORE = 6
const BIGRAM_BODY_SCORE = 3
const LOCK_FILE = '.tau-git-memory.lock'
const PINNED_CONTEXT_CACHE_FILE = '.tau-git-memory-pinned-context-cache.json'

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--path' || arg === '-p') opts.path = argv[++i]
    else if (arg === '--namespace' || arg === '-n') opts.namespace = argv[++i]
    else if (arg === '--project') opts.project = argv[++i]
    else if (arg === '--store') opts.store = argv[++i]
    else if (arg === '--branch') opts.branch = argv[++i]
    else if (arg === '--limit') opts.limit = Number(argv[++i])
    else if (arg === '--min-score') opts.minScore = Number(argv[++i])
    else if (arg === '--tag' || arg === '--tags') {
      if (!opts.tags) opts.tags = []
      opts.tags.push(argv[++i])
    }
    else if (arg === '--stdin') opts.stdin = true
    else if (arg === '--append') opts.append = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--text') opts.text = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else opts._.push(arg)
  }
  return opts
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function parseJsonInput(raw) {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return {}
  }
}

function positiveIntFromEnv(name, fallback, max = 10000) {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

function optionalPositiveIntFromEnv(name, max = 10000) {
  const raw = process.env[name]
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.floor(value), max)
}

function nonNegativeIntFromEnv(name, fallback, max = 10000) {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.min(Math.floor(value), max)
}

function contextConfig(opts = {}) {
  const keywordLimit =
    Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : positiveIntFromEnv('TAU_GIT_MEMORY_KEYWORD_LIMIT', DEFAULT_KEYWORD_LIMIT, 20)
  return {
    keywordLimit,
    fallbackLimit: positiveIntFromEnv(
      'TAU_GIT_MEMORY_FALLBACK_LIMIT',
      DEFAULT_FALLBACK_LIMIT,
      20,
    ),
    snippetChars: positiveIntFromEnv(
      'TAU_GIT_MEMORY_SNIPPET_CHARS',
      DEFAULT_SNIPPET_CHARS,
      1200,
    ),
    minScore:
      Number.isFinite(opts.minScore) && opts.minScore >= 0
        ? Math.floor(opts.minScore)
        : nonNegativeIntFromEnv('TAU_GIT_MEMORY_MIN_SCORE', DEFAULT_MIN_SCORE, 100),
    pinnedLimit: optionalPositiveIntFromEnv('TAU_GIT_MEMORY_PINNED_LIMIT', 100),
  }
}

function normalizeTag(raw) {
  const token = String(raw || '').trim().toLowerCase()
  const tag = TAG_ALIASES.get(token) || token
  if (!MEMORY_TAGS.has(tag)) {
    throw new Error(`invalid memory tag "${raw}". Use pinned, fallback, or normal`)
  }
  return tag
}

function normalizeTags(input, fallback = ['normal']) {
  const rawValues = Array.isArray(input) ? input : input ? [input] : []
  const tokens = rawValues
    .flatMap(value => String(value).split(/[,\s]+/))
    .map(value => value.trim())
    .filter(Boolean)

  const tags = []
  for (const token of tokens) {
    const tag = normalizeTag(token)
    if (!tags.includes(tag)) tags.push(tag)
  }

  const normalized = tags.length ? tags : [...fallback]
  if (normalized.length > 2) {
    throw new Error('a memory can have at most 2 tags')
  }
  if (normalized.includes('normal') && normalized.length > 1) {
    throw new Error('normal memories cannot also be tagged pinned or fallback')
  }
  return normalized
}

function tagsFromMeta(value) {
  try {
    return normalizeTags(value)
  } catch {
    return ['normal']
  }
}

function tagText(tags) {
  return normalizeTags(tags).join(', ')
}

function hasTag(item, tag) {
  return Array.isArray(item.tags) && item.tags.includes(tag)
}

function hasAnyTag(item, tags) {
  return tags.some(tag => hasTag(item, tag))
}

function compactSnippet(body, maxChars) {
  const text = String(body || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text

  const hardLimit = Math.max(0, maxChars - 3)
  if (hardLimit <= 0) return text.slice(0, Math.max(0, maxChars))

  const sentenceWindowStart = Math.floor(hardLimit * 0.8)
  for (let index = hardLimit - 1; index >= sentenceWindowStart; index--) {
    if (/[.!?]/.test(text[index])) {
      return `${text.slice(0, index + 1).trimEnd()}...`
    }
  }

  const wordBoundary = text.lastIndexOf(' ', hardLimit)
  if (wordBoundary > 0) {
    return `${text.slice(0, wordBoundary).trimEnd()}...`
  }

  return `${text.slice(0, hardLimit).trimEnd()}...`
}

function toNativePath(value) {
  if (!value) return value
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(value)) {
    return `${value[1].toUpperCase()}:\\${value.slice(3).replace(/\//g, '\\')}`
  }
  return value
}

function expandHome(value) {
  if (!value) return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
  })

  if (result.error) {
    if (options.allowFailure) return result
    throw result.error
  }

  if (result.status !== 0 && !options.allowFailure) {
    const stderr = (result.stderr || '').trim()
    const stdout = (result.stdout || '').trim()
    const detail = stderr || stdout || `exit ${result.status}`
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }

  return result
}

function git(args, cwd, options = {}) {
  return run('git', args, { cwd, ...options })
}

function gitOut(args, cwd, options = {}) {
  return (git(args, cwd, options).stdout || '').trim()
}

function gitDirPath(repoRoot) {
  const dotGit = path.join(repoRoot, '.git')
  try {
    const stat = fs.statSync(dotGit)
    if (stat.isDirectory()) return dotGit
    if (stat.isFile()) {
      const raw = fs.readFileSync(dotGit, 'utf8').trim()
      const match = raw.match(/^gitdir:\s*(.+)$/i)
      if (!match) return null
      const gitDir = toNativePath(match[1])
      return path.resolve(repoRoot, gitDir)
    }
  } catch {
    return null
  }
  return null
}

function branchFromHead(repoRoot) {
  const gitDir = gitDirPath(repoRoot)
  if (!gitDir) return null

  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const match = head.match(/^ref:\s+refs\/heads\/(.+)$/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function projectDirFrom(opts, hookInput = {}) {
  const raw =
    opts.project ||
    process.env.TAU_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    hookInput.cwd ||
    process.cwd()
  return path.resolve(toNativePath(raw))
}

function fastGitRootOf(projectDir) {
  let current = path.resolve(projectDir)
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function gitRootOf(projectDir) {
  const fastRoot = fastGitRootOf(projectDir)
  if (fastRoot) return fastRoot

  const result = git(['-C', projectDir, 'rev-parse', '--show-toplevel'], null, {
    allowFailure: true,
  })
  if (result.status === 0 && result.stdout.trim()) {
    return path.resolve(toNativePath(result.stdout.trim()))
  }
  return projectDir
}

function slugForPath(projectRoot) {
  const normalized = path.resolve(projectRoot).replace(/\\/g, '/')
  const withoutDriveColon = normalized.replace(/^([A-Za-z]):/, '$1')
  const slug = withoutDriveColon
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (slug || 'project').slice(-140)
}

function resolveStore(opts, projectRoot) {
  const explicit = opts.store || process.env.TAU_GIT_MEMORY_STORE
  if (explicit) return path.resolve(toNativePath(expandHome(explicit)))

  const home = process.env.TAU_GIT_MEMORY_HOME
    ? path.resolve(toNativePath(expandHome(process.env.TAU_GIT_MEMORY_HOME)))
    : path.join(os.homedir(), '.tau', 'git-memory')
  return path.join(home, slugForPath(projectRoot))
}

function safeBranchName(raw) {
  let name = String(raw || 'main').trim()
  if (!name || name === 'HEAD') name = 'main'
  name = name
    .replace(/\\/g, '/')
    .replace(/\s+/g, '-')
    .replace(/[\x00-\x20~^:?*[\]]/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/\.\./g, '.')
    .replace(/@\{/g, '@-')
    .replace(/\.lock$/i, '-lock')
  if (!name) name = 'main'

  const check = git(['check-ref-format', '--branch', name], null, {
    allowFailure: true,
  })
  if (check.status === 0) return name.slice(0, 180)
  return `branch-${slugForPath(name).replace(/\./g, '-') || 'main'}`
}

function currentCodeBranch(projectRoot) {
  const fastBranch = branchFromHead(projectRoot)
  if (fastBranch) return fastBranch

  const branch = gitOut(
    ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'],
    null,
    { allowFailure: true },
  )
  if (!branch) return 'main'
  if (branch === 'HEAD') {
    const short = gitOut(['-C', projectRoot, 'rev-parse', '--short', 'HEAD'], null, {
      allowFailure: true,
    })
    return safeBranchName(short ? `detached-${short}` : 'detached')
  }
  return safeBranchName(branch)
}

function configureGitIdentity(store) {
  const name = gitOut(['config', '--get', 'user.name'], store, {
    allowFailure: true,
  })
  if (!name) git(['config', 'user.name', 'Tau Git Memory'], store)

  const email = gitOut(['config', '--get', 'user.email'], store, {
    allowFailure: true,
  })
  if (!email) git(['config', 'user.email', 'tau-git-memory@local'], store)
}

function hasHead(store) {
  return git(['rev-parse', '--verify', 'HEAD'], store, {
    allowFailure: true,
  }).status === 0
}

function hasChanges(store) {
  return Boolean(gitOut(['status', '--porcelain'], store, { allowFailure: true }))
}

function commitAllIfChanged(store, message) {
  git(['add', '-A'], store)
  if (!hasChanges(store)) return false
  git(['commit', '-m', message], store)
  return true
}

function ensureStoreUnlocked(store) {
  fs.mkdirSync(store, { recursive: true })
  const gitDir = path.join(store, '.git')
  const isNew = !fs.existsSync(gitDir)

  if (isNew) {
    git(['init'], store)
  }

  configureGitIdentity(store)

  const ignorePath = path.join(store, '.gitignore')
  const ignoreLines = [LOCK_FILE, PINNED_CONTEXT_CACHE_FILE]
  const existingIgnore = fs.existsSync(ignorePath)
    ? fs.readFileSync(ignorePath, 'utf8')
    : ''
  const existingIgnoreLines = existingIgnore.split(/\r?\n/)
  const missingIgnoreLines = ignoreLines.filter(line => !existingIgnoreLines.includes(line))
  if (missingIgnoreLines.length) {
    fs.writeFileSync(
      ignorePath,
      `${existingIgnore.replace(/\s*$/, '')}${existingIgnore.trim() ? '\n' : ''}${missingIgnoreLines.join('\n')}\n`,
      'utf8',
    )
  }
  for (const ignoreLine of ignoreLines) {
    git(['rm', '--cached', '--ignore-unmatch', ignoreLine], store, {
      allowFailure: true,
    })
  }

  fs.mkdirSync(path.join(store, 'memories', 'default'), { recursive: true })

  const readme = path.join(store, 'README.md')
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      [
        '# Tau Git Memory Store',
        '',
        'This repository is managed by the tau-git-memory plugin.',
        'Each memory is a Markdown file under memories/<namespace>/...',
        '',
      ].join('\n'),
      'utf8',
    )
  }

  const keep = path.join(store, 'memories', 'default', '.gitkeep')
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '', 'utf8')

  if (!hasHead(store)) {
    commitAllIfChanged(store, 'chore: initialize tau git memory')
    git(['branch', '-M', 'main'], store)
  } else if (isNew || hasChanges(store)) {
    commitAllIfChanged(store, 'chore: checkpoint tau git memory store')
  }
}

function branchExists(store, branch) {
  return (
    git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], store, {
      allowFailure: true,
    }).status === 0
  )
}

function currentMemoryBranch(store) {
  return branchFromHead(store) || gitOut(['branch', '--show-current'], store, { allowFailure: true }) || 'main'
}

function checkoutMemoryBranch(store, branch, currentBranchHint = null) {
  const target = safeBranchName(branch)
  commitAllIfChanged(store, 'chore: checkpoint pending memory edits')

  const current = branchFromHead(store) || currentBranchHint || currentMemoryBranch(store)
  if (current === target) return target

  if (branchExists(store, target)) {
    git(['checkout', target], store)
    return target
  }

  if (branchExists(store, 'main')) {
    git(['checkout', 'main'], store)
  }
  git(['checkout', '-b', target], store)
  return target
}

function withLock(store, fn) {
  fs.mkdirSync(store, { recursive: true })
  const lockPath = path.join(store, LOCK_FILE)
  const start = Date.now()
  let fd = null

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs
        if (ageMs > 10 * 60 * 1000) {
          fs.unlinkSync(lockPath)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() - start > 10_000) {
        throw new Error(`memory store is locked: ${lockPath}`)
      }
      sleep(100)
    }
  }

  try {
    return fn()
  } finally {
    if (fd !== null) fs.closeSync(fd)
    try {
      fs.unlinkSync(lockPath)
    } catch {
      // best effort
    }
  }
}

function memoriesDir(store) {
  return path.join(store, 'memories')
}

function openContext(opts, hookInput, fn, options = {}) {
  const projectDir = projectDirFrom(opts, hookInput)
  const projectRoot = options.skipMissingStore
    ? fastGitRootOf(projectDir) || projectDir
    : gitRootOf(projectDir)
  const store = resolveStore(opts, projectRoot)
  if (options.skipMissingStore && !fs.existsSync(memoriesDir(store))) {
    return options.missingStoreValue ?? {}
  }

  const codeBranch = opts.branch || process.env.TAU_GIT_MEMORY_BRANCH || currentCodeBranch(projectRoot)
  const currentBranchHint = branchFromHead(store)

  return withLock(store, () => {
    ensureStoreUnlocked(store)
    const branch = checkoutMemoryBranch(store, codeBranch, currentBranchHint)
    return fn({ projectDir, projectRoot, store, codeBranch, branch })
  })
}

function validateNamespace(namespace) {
  const ns = namespace || 'default'
  if (!/^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/.test(ns)) {
    throw new Error(`invalid namespace: ${namespace}`)
  }
  return ns
}

function validateMemoryPath(memoryPath) {
  const key = String(memoryPath || '').trim()
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,5}$/.test(key)) {
    throw new Error(
      `invalid memory path "${memoryPath}". Use lowercase dot paths like preferences.coding.style`,
    )
  }
  return key
}

function namespaceDir(namespace) {
  return namespace.replace(/[^A-Za-z0-9._-]/g, '__')
}

function memoryFilePath(store, namespace, memoryPath) {
  const ns = validateNamespace(namespace)
  const key = validateMemoryPath(memoryPath)
  return path.join(store, 'memories', namespaceDir(ns), ...key.split('.')) + '.md'
}

function stripFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { meta: {}, body: raw }

  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim().replace(/^"|"$/g, '')
    if (key) meta[key] = value
  }
  return { meta, body: raw.slice(match[0].length) }
}

function frontmatter(namespace, memoryPath, updated, tags) {
  return [
    '---',
    `path: ${memoryPath}`,
    `namespace: ${namespace}`,
    `tags: ${tagText(tags)}`,
    `updated: ${updated}`,
    '---',
    '',
  ].join('\n')
}

function normalizeContent(content) {
  const normalized = String(content || '').replace(/\r\n/g, '\n').trim()
  if (!normalized) throw new Error('memory content is empty')
  return normalized
}

function currentCommit(store) {
  return gitOut(['rev-parse', '--short', 'HEAD'], store, { allowFailure: true })
}

function remember(ctx, opts, rawContent) {
  const namespace = validateNamespace(opts.namespace)
  const memoryPath = validateMemoryPath(opts.path || opts._[0])
  const content =
    opts.path || opts._.length <= 1
      ? normalizeContent(rawContent)
      : normalizeContent(opts._.slice(1).join(' '))
  const filePath = memoryFilePath(ctx.store, namespace, memoryPath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const existing = fs.existsSync(filePath)
    ? stripFrontmatter(fs.readFileSync(filePath, 'utf8'))
    : null
  const tags = opts.tags !== undefined
    ? normalizeTags(opts.tags)
    : existing
      ? tagsFromMeta(existing.meta.tags)
      : ['normal']

  let body = content
  if (opts.append && existing) {
    const existingBody = existing.body.trim()
    body = `${existingBody}\n\n## Update ${new Date().toISOString()}\n\n${content}`
  }

  const updated = new Date().toISOString()
  fs.writeFileSync(filePath, `${frontmatter(namespace, memoryPath, updated, tags)}${body}\n`, 'utf8')

  const changed = commitAllIfChanged(ctx.store, `remember: ${namespace}:${memoryPath}`)
  return {
    ok: true,
    changed,
    namespace,
    path: memoryPath,
    fullKey: `${namespace}:${memoryPath}`,
    tags,
    file: filePath,
    branch: currentMemoryBranch(ctx.store),
    commit: currentCommit(ctx.store),
    store: ctx.store,
  }
}

function splitRememberText(rawText) {
  let text = String(rawText || '').trim()
  const tags = []

  while (text.startsWith('--')) {
    let match = text.match(/^--(?:tag|tags)\s+(\S+)\s+([\s\S]+)$/)
    if (match) {
      tags.push(match[1])
      text = match[2].trim()
      continue
    }

    match = text.match(/^--(pinned|pined|fallback|normal)\b\s*([\s\S]*)$/)
    if (match) {
      tags.push(match[1])
      text = match[2].trim()
      continue
    }

    break
  }

  const match = text.match(/^(\S+)\s+([\s\S]+)$/)
  if (!match) {
    return {
      ok: false,
      error:
        'Usage: /tau-git-memory:remember [--tag pinned|fallback|normal] <dot.path> <memory text>. Example: /tau-git-memory:remember --tag pinned preferences.coding.style Keep edits focused.',
    }
  }
  try {
    return {
      ok: true,
      path: validateMemoryPath(match[1]),
      content: normalizeContent(match[2]),
      tags: normalizeTags(tags),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function getMemory(ctx, opts) {
  const namespace = validateNamespace(opts.namespace)
  const memoryPath = validateMemoryPath(opts.path || opts._[0])
  const filePath = memoryFilePath(ctx.store, namespace, memoryPath)
  if (!fs.existsSync(filePath)) {
    return {
      ok: true,
      found: false,
      namespace,
      path: memoryPath,
      fullKey: `${namespace}:${memoryPath}`,
      branch: currentMemoryBranch(ctx.store),
      store: ctx.store,
    }
  }
  const { meta, body } = stripFrontmatter(fs.readFileSync(filePath, 'utf8'))
  const tags = tagsFromMeta(meta.tags)
  return {
    ok: true,
    found: true,
    namespace,
    path: memoryPath,
    fullKey: `${namespace}:${memoryPath}`,
    tags,
    updated: meta.updated,
    content: body.trim(),
    file: filePath,
    branch: currentMemoryBranch(ctx.store),
    commit: currentCommit(ctx.store),
    store: ctx.store,
  }
}

function getMemoryWithFallback(ctx, opts) {
  return withMemoryReadBranch(ctx, opts, status => {
    const result = getMemory(ctx, opts)
    if (status.branchFallback) result.branchFallback = status.branchFallback
    return result
  })
}

function walkFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

function fallbackKeyFromFile(baseDir, file) {
  return path
    .relative(baseDir, file)
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .split('/')
    .join('.')
}

function firstLine(body) {
  return body
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || ''
}

function listMemories(ctx, opts = {}) {
  const requestedNamespace = opts.namespace ? validateNamespace(opts.namespace) : null
  const root = path.join(ctx.store, 'memories')
  const items = []

  for (const nsEntry of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
    if (!nsEntry.isDirectory()) continue
    const nsDir = path.join(root, nsEntry.name)
    for (const file of walkFiles(nsDir)) {
      const raw = fs.readFileSync(file, 'utf8')
      const { meta, body } = stripFrontmatter(raw)
      const namespace = meta.namespace || nsEntry.name
      if (requestedNamespace && namespace !== requestedNamespace) continue
      const memoryPath = meta.path || fallbackKeyFromFile(nsDir, file)
      const tags = tagsFromMeta(meta.tags)
      items.push({
        namespace,
        path: memoryPath,
        fullKey: `${namespace}:${memoryPath}`,
        tags,
        updated: meta.updated,
        summary: firstLine(body).slice(0, 180),
        file,
      })
    }
  }

  items.sort((a, b) => a.fullKey.localeCompare(b.fullKey))
  return {
    ok: true,
    store: ctx.store,
    branch: currentMemoryBranch(ctx.store),
    codeBranch: ctx.codeBranch,
    projectRoot: ctx.projectRoot,
    count: items.length,
    memories: items,
    commit: currentCommit(ctx.store),
  }
}

function configuredFallbackBranch() {
  return safeBranchName(process.env.TAU_GIT_MEMORY_FALLBACK_BRANCH || 'main')
}

function withMemoryReadBranch(ctx, opts, readFn) {
  const primaryStatus = listMemories(ctx, opts)
  if (primaryStatus.count > 0) return readFn(primaryStatus)

  const originalBranch = currentMemoryBranch(ctx.store)
  const fallbackBranch = configuredFallbackBranch()
  if (fallbackBranch === originalBranch || !branchExists(ctx.store, fallbackBranch)) {
    return readFn(primaryStatus)
  }

  git(['checkout', fallbackBranch], ctx.store)
  try {
    const fallbackStatus = listMemories({ ...ctx, branch: fallbackBranch }, opts)
    if (fallbackStatus.count > 0) {
      fallbackStatus.branchFallback = {
        from: originalBranch,
        to: fallbackBranch,
      }
      return readFn(fallbackStatus)
    }
  } finally {
    git(['checkout', originalBranch], ctx.store)
  }

  return readFn(primaryStatus)
}

function searchTokensFor(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(term => term.length > 2 && !STOPWORDS.has(term))
    .slice(0, 16)
}

function termsFor(query) {
  return [...new Set(searchTokensFor(query))]
}

function bigramsForTokens(tokens) {
  const bigrams = []
  for (let i = 0; i < tokens.length - 1; i++) {
    const phrase = `${tokens[i]} ${tokens[i + 1]}`
    if (!bigrams.includes(phrase)) bigrams.push(phrase)
  }
  return bigrams
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function recencyScore(updated) {
  const timestamp = Date.parse(updated || '')
  if (!Number.isFinite(timestamp)) return 0
  const ageMs = Date.now() - timestamp
  if (ageMs < 0) return RECENT_7_DAYS_SCORE
  if (ageMs <= RECENT_7_DAYS_MS) return RECENT_7_DAYS_SCORE
  if (ageMs <= RECENT_30_DAYS_MS) return RECENT_30_DAYS_SCORE
  return 0
}

function filteredMemoryItems(items, opts = {}) {
  const excludeTags = Array.isArray(opts.excludeTags) ? opts.excludeTags : []
  return items.filter(item => !hasAnyTag(item, excludeTags))
}

function enrichMemoryItem(item, snippetChars) {
  const raw = fs.readFileSync(item.file, 'utf8')
  const body = stripFrontmatter(raw).body.trim()
  return {
    ...item,
    snippet: compactSnippet(body, snippetChars),
  }
}

function searchMemoryItems(items, opts, query) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 7
  const snippetChars = opts.snippetChars || DEFAULT_SNIPPET_CHARS
  const minScore =
    Number.isFinite(opts.minScore) && opts.minScore >= 0
      ? Math.floor(opts.minScore)
      : nonNegativeIntFromEnv('TAU_GIT_MEMORY_MIN_SCORE', DEFAULT_MIN_SCORE, 100)
  const tokens = searchTokensFor(query)
  const terms = [...new Set(tokens)]
  const bigrams = bigramsForTokens(tokens)
  const all = filteredMemoryItems(items, opts)
  const scored = []

  for (const item of all) {
    if (terms.length === 0 && !opts.emptyMatchesAll) continue
    const raw = fs.readFileSync(item.file, 'utf8')
    const body = stripFrontmatter(raw).body.trim()
    const bodyText = normalizeSearchText(body)
    const keyText = normalizeSearchText(item.fullKey)
    const summaryText = normalizeSearchText(item.summary)
    const tagText = normalizeSearchText(item.tags.join(' '))
    let score = 0
    for (const term of terms) {
      if (keyText.includes(term)) score += 4
      if (summaryText.includes(term)) score += 2
      if (bodyText.includes(term)) score += 1
      if (tagText.includes(term)) score += 1
    }
    for (const phrase of bigrams) {
      if (keyText.includes(phrase)) score += BIGRAM_PATH_SCORE
      if (bodyText.includes(phrase)) score += BIGRAM_BODY_SCORE
    }
    if (terms.length === 0 && opts.emptyMatchesAll) score = item.summary ? 1 : 0
    if (score >= minScore) {
      score += recencyScore(item.updated)
      scored.push({
        ...item,
        score,
        snippet: compactSnippet(body, snippetChars),
      })
    }
  }

  scored.sort((a, b) => b.score - a.score || a.fullKey.localeCompare(b.fullKey))
  return {
    query,
    terms,
    minScore,
    count: scored.length,
    matches: scored.slice(0, limit),
  }
}

function searchMemories(ctx, opts, query) {
  return withMemoryReadBranch(ctx, opts, status => {
    const search = searchMemoryItems(status.memories, opts, query)
    return {
      ok: true,
      query: search.query,
      terms: search.terms,
      minScore: search.minScore,
      store: ctx.store,
      branch: status.branch,
      codeBranch: status.codeBranch,
      branchFallback: status.branchFallback,
      count: search.count,
      matches: search.matches,
    }
  })
}

function buildMemoryTree(status) {
  const root = {}
  for (const item of status.memories) {
    if (!root[item.namespace]) root[item.namespace] = {}
    let node = root[item.namespace]
    const parts = item.path.split('.')
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!node[part]) node[part] = {}
      node = node[part]
      if (i === parts.length - 1) {
        node.$memory = {
          path: item.path,
          fullKey: item.fullKey,
          tags: item.tags,
          summary: item.summary,
          updated: item.updated,
          file: item.file,
        }
      }
    }
  }
  return root
}

function treeMemories(ctx, opts = {}) {
  const status = listMemories(ctx, opts)
  return {
    ok: true,
    store: status.store,
    branch: status.branch,
    codeBranch: status.codeBranch,
    projectRoot: status.projectRoot,
    count: status.count,
    tree: buildMemoryTree(status),
  }
}

function renderTreeNode(node, prefix, lines) {
  const keys = Object.keys(node)
    .filter(key => key !== '$memory')
    .sort((a, b) => a.localeCompare(b))
  keys.forEach((key, index) => {
    const child = node[key]
    const memory = child.$memory
    const isLast = index === keys.length - 1
    const branch = isLast ? '+-- ' : '|-- '
    const childPrefix = `${prefix}${isLast ? '    ' : '|   '}`
    const label = memory ? `${key}.md` : `${key}/`
    const suffix = memory
      ? ` [tags: ${tagText(memory.tags)}] [${memory.path}]${memory.summary ? ` - ${memory.summary}` : ''}`
      : ''
    lines.push(`${prefix}${branch}${label}${suffix}`)
    renderTreeNode(child, childPrefix, lines)
  })
}

function treeText(tree) {
  const lines = [
    'tau-git-memory schema',
    `branch: ${tree.branch}`,
    `code branch: ${tree.codeBranch}`,
    `memories: ${tree.count}`,
    `project: ${tree.projectRoot}`,
    `store: ${tree.store}`,
  ]

  const namespaces = Object.keys(tree.tree).sort((a, b) => a.localeCompare(b))
  if (namespaces.length === 0) {
    lines.push('', '(no memories saved yet)')
    return lines.join('\n')
  }

  lines.push('')
  lines.push('memories/')
  namespaces.forEach((namespace, index) => {
    const isLast = index === namespaces.length - 1
    const prefix = isLast ? '    ' : '|   '
    lines.push(`${isLast ? '+-- ' : '|-- '}${namespace}/`)
    renderTreeNode(tree.tree[namespace], prefix, lines)
  })
  return lines.join('\n')
}

function statusText(status) {
  const lines = [
    `tau-git-memory: ${status.branch} (${status.count} memories)`,
    `store: ${status.store}`,
    `project: ${status.projectRoot}`,
    `code branch: ${status.codeBranch}`,
    `commit: ${status.commit || '(none)'}`,
  ]
  if (status.memories.length) {
    lines.push('', 'paths:')
    for (const item of status.memories.slice(0, 80)) {
      lines.push(
        `- ${item.fullKey} [tags: ${tagText(item.tags)}]${item.summary ? ` - ${item.summary}` : ''}`,
      )
    }
    if (status.memories.length > 80) {
      lines.push(`- ... ${status.memories.length - 80} more`)
    }
  }
  return lines.join('\n')
}

function fallbackBranchLine(status) {
  if (!status.branchFallback) return null
  return `fallback source: ${status.branchFallback.to} (current memory branch ${status.branchFallback.from} has no memories)`
}

function pinnedCachePath(store) {
  return path.join(store, PINNED_CONTEXT_CACHE_FILE)
}

function pinnedCacheSignature(status, pinnedItems, config) {
  const limited = limitItems(pinnedItems, config.pinnedLimit)
  const files = limited.items.map(item => {
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(item.file).mtimeMs
    } catch {
      // If a pinned file disappears during rendering, force a cache miss.
      mtimeMs = -1
    }
    return {
      key: item.fullKey,
      file: path.relative(status.store, item.file).replace(/\\/g, '/'),
      mtimeMs,
    }
  })

  return {
    version: 1,
    branch: status.branch,
    snippetChars: config.snippetChars,
    pinnedLimit: config.pinnedLimit ?? null,
    omitted: limited.omitted,
    files,
  }
}

function readPinnedContextCache(store) {
  try {
    return JSON.parse(fs.readFileSync(pinnedCachePath(store), 'utf8'))
  } catch {
    return null
  }
}

function writePinnedContextCache(store, payload) {
  try {
    fs.writeFileSync(pinnedCachePath(store), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch {
    // Cache failures must not block memory injection.
  }
}

function renderPinnedSessionContext(pinned) {
  if (!pinned.items.length) return ''
  const lines = ['Pinned memories (always injected at session start):']
  for (const item of pinned.items) {
    lines.push(renderMemoryItemLine(item))
  }
  if (pinned.omitted > 0) {
    lines.push(`- ... ${pinned.omitted} more pinned memories omitted by limit`)
  }
  return lines.join('\n')
}

function cachedPinnedSessionContext(status, config) {
  const pinnedItems = status.memories.filter(item => hasTag(item, 'pinned'))
  if (!pinnedItems.length) return ''

  const signature = pinnedCacheSignature(status, pinnedItems, config)
  const signatureJson = JSON.stringify(signature)
  const cached = readPinnedContextCache(status.store)
  if (
    cached &&
    cached.signatureJson === signatureJson &&
    typeof cached.context === 'string'
  ) {
    return cached.context
  }

  const pinned = enrichMemoryItems(pinnedItems, config.snippetChars, config.pinnedLimit)
  const context = renderPinnedSessionContext(pinned)
  writePinnedContextCache(status.store, {
    signatureJson,
    signature,
    context,
    cachedAt: new Date().toISOString(),
  })
  return context
}

function renderSessionContext(status, pinnedContext = '') {
  if (!status.memories.length) return ''
  const lines = [
    '# Tau Git Memory',
    `store: ${status.store}`,
    `memory branch: ${status.branch}`,
    `code branch: ${status.codeBranch}`,
    `memories: ${status.count}`,
  ]
  const branchLine = fallbackBranchLine(status)
  if (branchLine) lines.push(branchLine)
  lines.push(
    '',
    'Tag zones:',
    '- pinned memories are always injected once at SessionStart.',
    '- fallback memories appear only when keyword search finds no normal match.',
    '- normal memories appear when the user prompt matches them.',
  )
  if (pinnedContext) {
    lines.push('', pinnedContext)
  }
  lines.push('', 'Available memory paths:')
  for (const item of status.memories.slice(0, 80)) {
    lines.push(
      `- ${item.fullKey} [tags: ${tagText(item.tags)}]${item.summary ? ` - ${item.summary}` : ''}`,
    )
  }
  if (status.memories.length > 80) {
    lines.push(`- ... ${status.memories.length - 80} more`)
  }
  lines.push(
    '',
    'Use the tau-git-memory recall skill or the plugin script to read exact values before relying on these memories.',
  )
  return lines.join('\n')
}

function limitItems(items, limit) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { items, omitted: 0 }
  }
  return {
    items: items.slice(0, limit),
    omitted: Math.max(0, items.length - limit),
  }
}

function enrichMemoryItems(items, snippetChars, limit = null) {
  const limited = limitItems(items, limit)
  return {
    items: limited.items.map(item => enrichMemoryItem(item, snippetChars)),
    omitted: limited.omitted,
  }
}

function promptMemoryRetrieval(ctx, opts, prompt) {
  const config = contextConfig(opts)
  return withMemoryReadBranch(ctx, opts, status => {
    const keyword = searchMemoryItems(
      status.memories,
      {
        ...opts,
        limit: config.keywordLimit,
        minScore: config.minScore,
        snippetChars: config.snippetChars,
        excludeTags: ['pinned', 'fallback'],
        emptyMatchesAll: false,
      },
      prompt,
    )

    const fallback =
      keyword.matches.length === 0
        ? enrichMemoryItems(
            status.memories.filter(item => hasTag(item, 'fallback') && !hasTag(item, 'pinned')),
            config.snippetChars,
            config.fallbackLimit,
          )
        : { items: [], omitted: 0 }

    return {
      branch: status.branch,
      codeBranch: status.codeBranch,
      branchFallback: status.branchFallback,
      keyword,
      fallback,
    }
  })
}

function renderMemoryItemLine(item) {
  return `- ${item.fullKey} [tags: ${tagText(item.tags)}]: ${item.snippet}`
}

function renderPromptMemoryContext(retrieval) {
  const hasKeyword = retrieval.keyword.matches.length > 0
  const hasFallback = retrieval.fallback.items.length > 0
  if (!hasKeyword && !hasFallback) return ''

  const mode = hasKeyword ? 'keyword' : 'fallback'
  const lines = [
    '# Tau Git Memory Context',
    `memory branch: ${retrieval.branch}`,
    `code branch: ${retrieval.codeBranch}`,
    `mode: ${mode}`,
    '',
  ]
  const branchLine = fallbackBranchLine(retrieval)
  if (branchLine) lines.splice(3, 0, branchLine)

  if (hasKeyword) {
    lines.push(`Keyword matches (normal memories, terms: ${retrieval.keyword.terms.join(', ')}, min score: ${retrieval.keyword.minScore}):`)
    for (const item of retrieval.keyword.matches) {
      lines.push(renderMemoryItemLine(item))
    }
  } else if (hasFallback) {
    lines.push('Fallback memories (used because keyword search found no normal match):')
    for (const item of retrieval.fallback.items) {
      lines.push(renderMemoryItemLine(item))
    }
    if (retrieval.fallback.omitted > 0) {
      lines.push(`- ... ${retrieval.fallback.omitted} more fallback memories omitted by limit`)
    }
  }

  return lines.join('\n').trimEnd()
}

function renderRecallContext(search) {
  if (!search.matches.length) return ''
  const lines = [
    '# Tau Git Memory Recall Candidates',
    `query terms: ${search.terms.join(', ') || '(none)'}`,
    '',
  ]
  for (const item of search.matches) {
    lines.push(`- ${item.fullKey} [tags: ${tagText(item.tags)}]: ${item.snippet}`)
  }
  return lines.join('\n')
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`)
}

function usage() {
  return [
    'tau-git-memory commands:',
    '  status [--text] [--project <dir>] [--store <dir>]',
    '  remember --path <dot.path> --stdin [--namespace default] [--append] [--tag pinned|fallback|normal]',
    '  get <dot.path> [--namespace default]',
    '  list [--namespace default]',
    '  tree [--text] [--namespace default]',
    '  search <query> [--limit 7]',
    '  hook-session-start',
    '  hook-user-prompt-submit',
    '',
    'Environment:',
    '  TAU_GIT_MEMORY_STORE overrides the store path.',
    '  TAU_GIT_MEMORY_HOME overrides the parent directory for project stores.',
    '  TAU_GIT_MEMORY_BRANCH overrides memory branch selection.',
    '  TAU_GIT_MEMORY_FALLBACK_BRANCH sets the read fallback branch when the current memory branch is empty.',
    '  TAU_GIT_MEMORY_MIN_SCORE sets the search relevance floor; default is 2.',
    '  TAU_GIT_MEMORY_KEYWORD_LIMIT, TAU_GIT_MEMORY_FALLBACK_LIMIT, TAU_GIT_MEMORY_PINNED_LIMIT, and TAU_GIT_MEMORY_SNIPPET_CHARS tune context size.',
  ].join('\n')
}

function main() {
  const command = process.argv[2] || 'help'
  const opts = parseArgs(process.argv.slice(3))

  if (opts.help || command === 'help') {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const hookInput = HOOK_COMMANDS.has(command) ? parseJsonInput(readStdin()) : {}

  if (command === 'hook-session-start') {
    const output = openContext(opts, hookInput, ctx => {
      const config = contextConfig(opts)
      return withMemoryReadBranch(ctx, opts, status => {
        const pinnedContext = cachedPinnedSessionContext(status, config)
        const context = renderSessionContext(status, pinnedContext)
        const result = {
          systemMessage: `[tau-git-memory] ${status.branch} - ${status.count} memories`,
        }
        if (context) {
          result.hookSpecificOutput = {
            hookEventName: 'SessionStart',
            additionalContext: context,
          }
        }
        return result
      })
    }, {
      skipMissingStore: true,
      missingStoreValue: {},
    })
    printJson(output)
    return
  }

  if (command === 'hook-user-prompt-submit') {
    const prompt = hookInput.prompt || ''
    if (!String(prompt).trim()) {
      printJson({})
      return
    }
    const output = openContext(opts, hookInput, ctx => {
      const retrieval = promptMemoryRetrieval(ctx, opts, prompt)
      const context = renderPromptMemoryContext(retrieval)
      if (!context) return {}
      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: context,
        },
      }
    }, {
      skipMissingStore: true,
      missingStoreValue: {},
    })
    printJson(output)
    return
  }

  const result = openContext(opts, hookInput, ctx => {
    if (command === 'init' || command === 'status') return listMemories(ctx, opts)
    if (command === 'remember') {
      const rawContent = opts.stdin ? readStdin() : opts._.slice(opts.path ? 0 : 1).join(' ')
      return remember(ctx, opts, rawContent)
    }
    if (command === 'remember-text') {
      const parsed = splitRememberText(opts.stdin ? readStdin() : opts._.join(' '))
      if (!parsed.ok) return parsed
      return remember(ctx, { ...opts, path: parsed.path, tags: parsed.tags, _: [] }, parsed.content)
    }
    if (command === 'get') return getMemoryWithFallback(ctx, opts)
    if (command === 'list') return listMemories(ctx, opts)
    if (command === 'tree') return treeMemories(ctx, opts)
    if (command === 'search') {
      return searchMemories(ctx, opts, opts.stdin ? readStdin() : opts._.join(' '))
    }
    throw new Error(`unknown command: ${command}`)
  })

  if (opts.text && command === 'tree') {
    process.stdout.write(`${treeText(result)}\n`)
  } else if (opts.text && (command === 'status' || command === 'init')) {
    process.stdout.write(`${statusText(result)}\n`)
  } else {
    printJson(result)
  }
}

try {
  main()
} catch (error) {
  const command = process.argv[2] || ''
  const message = error instanceof Error ? error.message : String(error)
  if (HOOK_COMMANDS.has(command)) {
    printJson({
      systemMessage: `[tau-git-memory] ${message}`,
    })
    process.exit(0)
  }
  printJson({ ok: false, error: message })
  process.exit(1)
}
