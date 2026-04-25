import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { findGitBashPath } from '../windowsPaths.js'

export type BashSource =
  | 'system' // Linux/macOS /usr/bin/bash, etc.
  | 'apple-stock' // macOS /bin/bash 3.2 (ancient, ships with macOS)
  | 'homebrew' // /opt/homebrew/bin/bash or /usr/local/bin/bash from brew
  | 'git-for-windows' // bash.exe shipped with Git for Windows
  | 'wsl' // bash routed through wsl.exe
  | null

export type BashStatus = {
  ok: boolean
  /** Resolved bash executable path, or null when no bash is reachable. */
  path: string | null
  /** Parsed major version (e.g. 5 for "5.2.21(1)-release"), or null. */
  major: number | null
  /** Full first-line of `bash --version`, or null. */
  versionLine: string | null
  source: BashSource
  /**
   * True when the only bash on this machine is Apple's GPL2 stuck 3.2.
   * Functional for spawning commands but worth offering an upgrade.
   */
  isAppleStock: boolean
  /** True when the detected bash is too old for claudex's bash features. */
  isOutdated: boolean
}

export const MINIMUM_BASH_MAJOR = 4

const NULL_STATUS: BashStatus = {
  ok: false,
  path: null,
  major: null,
  versionLine: null,
  source: null,
  isAppleStock: false,
  isOutdated: false,
}

/** Cached result — bash availability is stable for the life of a process. */
let cached: BashStatus | null = null

export function detectBash(): BashStatus {
  if (cached) return cached
  cached = computeStatus()
  return cached
}

/** For tests / post-install verification — drop the cache. */
export function resetBashAvailabilityCache(): void {
  cached = null
}

function computeStatus(): BashStatus {
  if (process.platform === 'win32') {
    return detectWindowsBash()
  }
  return detectUnixBash()
}

function detectUnixBash(): BashStatus {
  // Prefer an explicit Homebrew bash on macOS — that's the modern (5.x)
  // install. Fall back to /bin/bash (Apple stock 3.2) if brew bash isn't
  // present, which still works for spawning commands.
  if (process.platform === 'darwin') {
    for (const brewPath of ['/opt/homebrew/bin/bash', '/usr/local/bin/bash']) {
      if (existsSync(brewPath)) {
        const probe = probeBash(brewPath)
        if (probe) return { ...probe, source: 'homebrew' }
      }
    }
    if (existsSync('/bin/bash')) {
      const probe = probeBash('/bin/bash')
      if (probe) {
        const isAppleStock = probe.major !== null && probe.major <= 3
        return {
          ...probe,
          source: isAppleStock ? 'apple-stock' : 'system',
          isAppleStock,
          isOutdated: isBashOutdated(probe.major),
        }
      }
    }
  }

  // Linux / fallback — trust PATH.
  const probe = probeBash('bash')
  if (probe) return { ...probe, source: 'system' }
  return NULL_STATUS
}

function detectWindowsBash(): BashStatus {
  const gitBash = findGitBashPath()
  if (gitBash) {
    const probe = probeBash(gitBash)
    if (probe) return { ...probe, source: 'git-for-windows' }
  }

  // On Windows claudex uses Git Bash for native shell commands. WSL is only
  // detected so the setup dialog can explain why Git Bash is still required.
  if (existsSync('C:\\Windows\\System32\\wsl.exe')) {
    const out = spawnSync(
      'C:\\Windows\\System32\\wsl.exe',
      ['bash', '--version'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
    )
    if (out.status === 0) {
      const versionLine = (out.stdout?.toString() ?? '').split('\n')[0]?.trim() || null
      return {
        ok: true,
        path: 'wsl.exe',
        major: parseMajor(versionLine),
        versionLine,
        source: 'wsl',
        isAppleStock: false,
        isOutdated: isBashOutdated(parseMajor(versionLine)),
      }
    }
  }

  return NULL_STATUS
}

function probeBash(executable: string): BashStatus | null {
  const out = spawnSync(executable, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    windowsHide: true,
  })
  if (out.status !== 0) return null
  const versionLine = (out.stdout?.toString() ?? '').split('\n')[0]?.trim() || null
  return {
    ok: true,
    path: executable,
    major: parseMajor(versionLine),
    versionLine,
    source: 'system',
    isAppleStock: false,
    isOutdated: isBashOutdated(parseMajor(versionLine)),
  }
}

export function isBashOutdated(major: number | null): boolean {
  return major !== null && major < MINIMUM_BASH_MAJOR
}

function parseMajor(line: string | null): number | null {
  if (!line) return null
  const match = line.match(/version\s+(\d+)\./i)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) ? n : null
}
