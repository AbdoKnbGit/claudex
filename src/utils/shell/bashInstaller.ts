import { spawnSync, type SpawnSyncReturns } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { findGitBashPath } from '../windowsPaths.js'
import {
  detectBash,
  isBashOutdated,
  resetBashAvailabilityCache,
  type BashStatus,
} from './bashAvailability.js'

export type InstallResult = {
  ok: boolean
  /** Human-readable summary of what happened. */
  message: string
  /**
   * The exact command we ran (or would have run). Useful for showing the
   * user a copy-paste fallback when the spawn fails.
   */
  command: string | null
}

export type InstallPlan = {
  action: 'install' | 'upgrade'
  /** True if there is a sensible automatic install path on this system. */
  canInstall: boolean
  /** Short, human-readable label for the install path (e.g. "winget Git.Git"). */
  label: string
  /** Same exact command shape we will spawn. Shown to the user before running. */
  command: string
  /** When canInstall is false, why — and a manual URL for the user. */
  manualUrl?: string
  manualNote?: string
  /** Distro id resolved on Linux (apt/dnf/pacman/zypper/apk/null). */
  linuxFamily?: LinuxFamily
}

type LinuxFamily = 'apt' | 'dnf' | 'pacman' | 'zypper' | 'apk' | null

/**
 * Build an install plan for the current OS without running anything.
 * Returns the command we'd run + whether it's fully automatable.
 */
export function planBashInstall(status: BashStatus = detectBash()): InstallPlan {
  if (process.platform === 'win32') return planWindows(status)
  if (process.platform === 'darwin') return planMacOS(status)
  if (process.platform === 'linux') return planLinux(status)
  return {
    action: 'install',
    canInstall: false,
    label: 'unsupported platform',
    command: '',
    manualNote: `Unsupported platform: ${process.platform}. Install bash with your system tools.`,
  }
}

/**
 * Run the install plan synchronously. We use spawnSync with stdio: 'inherit'
 * so the user sees real-time output (winget progress, brew taps, sudo
 * password prompt) directly in their terminal. The Ink root must be paused
 * before calling this.
 */
export function runBashInstall(plan: InstallPlan): InstallResult {
  if (!plan.canInstall) {
    return {
      ok: false,
      message: plan.manualNote ?? 'No automatic install available.',
      command: null,
    }
  }

  const [bin, ...args] = parseCommand(plan.command)
  if (!bin) {
    return { ok: false, message: 'Empty install command.', command: plan.command }
  }

  let result: SpawnSyncReturns<Buffer>
  try {
    result = spawnSync(bin, args, { stdio: 'inherit' })
  } catch (err) {
    return {
      ok: false,
      message: `Failed to spawn ${bin}: ${(err as Error).message}`,
      command: plan.command,
    }
  }

  // After install, clear caches so subsequent detectBash() / findGitBashPath()
  // pick up the new executable without requiring a process restart.
  resetBashAvailabilityCache()
  ;(findGitBashPath as { cache?: { clear?: () => void } }).cache?.clear?.()

  if (result.status === 0) {
    resetBashAvailabilityCache()
    const status = detectBash()
    const usable =
      status.ok &&
      !isBashOutdated(status.major) &&
      !(process.platform === 'win32' && status.source !== 'git-for-windows')
    if (usable) {
      const verb = plan.action === 'upgrade' ? 'Updated' : 'Installed'
      return { ok: true, message: `${verb} via ${plan.label}.`, command: plan.command }
    }
    return {
      ok: false,
      message:
        `Command completed, but claudex still cannot find a current bash. ` +
        `Detected: ${status.versionLine ?? 'none'}. You can run \`${plan.command}\` manually to retry.`,
      command: plan.command,
    }
  }
  return {
    ok: false,
    message: `Install failed (${plan.label}, exit ${result.status}). You can run \`${plan.command}\` manually to retry.`,
    command: plan.command,
  }
}

// ── Per-platform plans ──────────────────────────────────────────────

function planWindows(status: BashStatus): InstallPlan {
  const winget = resolveWinget()
  const action = status.source === 'git-for-windows' ? 'upgrade' : 'install'
  if (winget) {
    // --silent + --accept-*-agreements run unattended; --scope user avoids
    // an admin prompt and installs into %LOCALAPPDATA%, which is what we
    // want for a CLI postinstall flow. Git for Windows is the package.
    return {
      action,
      canInstall: true,
      label: `winget ${action === 'upgrade' ? 'upgrade Git.Git' : 'Git.Git'}`,
      command:
        action === 'upgrade'
          ? `${quote(winget)} upgrade --id Git.Git -e --source winget --silent --accept-source-agreements --accept-package-agreements`
          : `${quote(winget)} install --id Git.Git -e --source winget --silent --scope user --accept-source-agreements --accept-package-agreements`,
    }
  }
  return {
    action,
    canInstall: false,
    label: 'manual',
    command: '',
    manualUrl: 'https://git-scm.com/download/win',
    manualNote:
      'winget not available. Download Git for Windows from https://git-scm.com/download/win and run claudex again.',
  }
}

function planMacOS(status: BashStatus): InstallPlan {
  const brew = resolveBrew()
  const action = status.ok && status.source === 'homebrew' ? 'upgrade' : 'install'
  if (brew) {
    return {
      action,
      canInstall: true,
      label: `brew ${action} bash`,
      command: `${quote(brew)} ${action} bash`,
    }
  }
  return {
    action,
    canInstall: false,
    label: 'manual',
    command: '',
    manualUrl: 'https://brew.sh',
    manualNote:
      'Homebrew not detected. Install it from https://brew.sh and re-run claudex; macOS ships only bash 3.2 and brew is the standard upgrade path.',
  }
}

function planLinux(status: BashStatus): InstallPlan {
  const family = detectLinuxFamily()
  const action = status.ok ? 'upgrade' : 'install'
  switch (family) {
    case 'apt':
      return {
        action,
        canInstall: true,
        linuxFamily: family,
        label: 'apt-get',
        command:
          action === 'upgrade'
            ? 'sudo apt-get update && sudo apt-get install --only-upgrade -y bash'
            : 'sudo apt-get update && sudo apt-get install -y bash',
      }
    case 'dnf':
      return {
        action,
        canInstall: true,
        linuxFamily: family,
        label: 'dnf',
        command: `sudo dnf ${action === 'upgrade' ? 'upgrade' : 'install'} -y bash`,
      }
    case 'pacman':
      return {
        action,
        canInstall: true,
        linuxFamily: family,
        label: 'pacman',
        command:
          action === 'upgrade'
            ? 'sudo pacman -Syu --noconfirm bash'
            : 'sudo pacman -Sy --noconfirm bash',
      }
    case 'zypper':
      return {
        action,
        canInstall: true,
        linuxFamily: family,
        label: 'zypper',
        command: `sudo zypper ${action === 'upgrade' ? 'update' : 'install'} -y bash`,
      }
    case 'apk':
      return {
        action,
        canInstall: true,
        linuxFamily: family,
        label: 'apk',
        command: `sudo apk add ${action === 'upgrade' ? '--upgrade ' : ''}bash`,
      }
    default:
      return {
        action,
        canInstall: false,
        label: 'unknown distro',
        command: '',
        manualNote:
          'Could not detect your Linux distro. Install bash via your package manager (e.g. apt/dnf/pacman/zypper/apk).',
      }
  }
}

// ── Detection helpers ───────────────────────────────────────────────

function resolveWinget(): string | null {
  const candidates = [
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\winget.exe`
      : null,
    'C:\\Windows\\System32\\winget.exe',
  ].filter(Boolean) as string[]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Fall back to PATH lookup.
  const probe = spawnSync('winget', ['--version'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 5000,
  })
  return probe.status === 0 ? 'winget' : null
}

function resolveBrew(): string | null {
  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (existsSync(candidate)) return candidate
  }
  const probe = spawnSync('brew', ['--version'], { stdio: 'ignore', timeout: 5000 })
  return probe.status === 0 ? 'brew' : null
}

function detectLinuxFamily(): LinuxFamily {
  // /etc/os-release is the freedesktop.org standard — every modern distro
  // ships it. ID and ID_LIKE together cover derivatives (e.g. Mint → ubuntu).
  let osRelease = ''
  try {
    osRelease = readFileSync('/etc/os-release', 'utf8')
  } catch {
    // Fall through to executable probing below.
  }
  const ids = parseOsRelease(osRelease)
  for (const id of ids) {
    if (id === 'debian' || id === 'ubuntu' || id === 'linuxmint' || id === 'pop' || id === 'kali') return 'apt'
    if (id === 'fedora' || id === 'rhel' || id === 'centos' || id === 'rocky' || id === 'almalinux' || id === 'amzn') return 'dnf'
    if (id === 'arch' || id === 'manjaro' || id === 'endeavouros') return 'pacman'
    if (id === 'opensuse' || id === 'opensuse-leap' || id === 'opensuse-tumbleweed' || id === 'sles') return 'zypper'
    if (id === 'alpine') return 'apk'
  }
  // Fallback: probe the package managers directly.
  for (const [bin, family] of [
    ['apt-get', 'apt'],
    ['dnf', 'dnf'],
    ['pacman', 'pacman'],
    ['zypper', 'zypper'],
    ['apk', 'apk'],
  ] as const) {
    const probe = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000 })
    if (probe.status === 0) return family
  }
  return null
}

function parseOsRelease(content: string): string[] {
  const ids: string[] = []
  for (const line of content.split('\n')) {
    const match = line.match(/^(ID|ID_LIKE)=("?)([^"\n]*)\2$/)
    if (!match) continue
    const value = match[3] ?? ''
    for (const token of value.split(/\s+/)) {
      const trimmed = token.trim().toLowerCase()
      if (trimmed) ids.push(trimmed)
    }
  }
  return ids
}

// ── Tiny utilities ──────────────────────────────────────────────────

function quote(s: string): string {
  if (!/[\s"']/.test(s)) return s
  return `"${s.replace(/"/g, '\\"')}"`
}

/**
 * Naive command-line splitter: handles double-quoted segments. Adequate for
 * the commands we generate above; we never accept user-supplied strings.
 */
function parseCommand(cmd: string): string[] {
  const out: string[] = []
  let buf = ''
  let inQuote = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (!inQuote && ch === ' ') {
      if (buf) {
        out.push(buf)
        buf = ''
      }
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  // Linux apt path uses `&&` chaining — for that we must shell-execute.
  if (cmd.includes('&&')) {
    return ['/bin/sh', '-c', cmd]
  }
  return out
}
