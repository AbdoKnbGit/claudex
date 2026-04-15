/**
 * Per-OS sandbox layer — shared across lanes.
 *
 * Three backends, one interface. Each backend wraps `execFile`-style
 * command execution with platform-specific isolation:
 *
 *   Linux   → bubblewrap + Landlock     (port of codex-rs/sandboxing/bwrap.rs)
 *   macOS   → sandbox-exec (Seatbelt)   (port of codex-rs/sandboxing/seatbelt.rs
 *                                         and gemini-cli's sandbox-darwin.sb profile)
 *   Windows → Job Objects + restricted token
 *                                        (port of codex-rs/windows-sandbox-rs)
 *
 * Policy levels match the Codex conventions:
 *   - 'read-only'       — filesystem read allowed everywhere, no writes, no net
 *   - 'workspace-write' — reads anywhere, writes only inside workspace, no net
 *   - 'danger-full'     — minimal restrictions; used when user opts out
 *
 * The sandbox layer is advisory at Phase-1: if the backend binary isn't
 * present (e.g. bwrap not installed, sandbox-exec removed in macOS 15),
 * we fall back to unsandboxed execution and log a warning. The Bash tool
 * caller decides whether to require a successful sandbox (strict mode).
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { tmpdir, platform } from 'os'
import { join } from 'path'

export type SandboxPolicy = 'read-only' | 'workspace-write' | 'danger-full'

export interface SandboxRequest {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  timeout?: number
  /** Directory the policy treats as "the workspace" for writability purposes. */
  workspace: string
  policy: SandboxPolicy
  /** Whether to allow outbound network. Defaults per-policy (false for RO and WS-write). */
  allowNetwork?: boolean
}

export interface SandboxResult {
  stdout: string
  stderr: string
  exitCode: number | null
  /** Which backend actually ran the command. */
  backend: 'bubblewrap' | 'seatbelt' | 'job-object' | 'passthrough'
  /** True when a sandbox was NOT applied (backend missing / policy=danger-full). */
  unsandboxed: boolean
  /** True when the process was killed due to timeout. */
  timedOut: boolean
}

// ─── Dispatch ────────────────────────────────────────────────────

/**
 * Run a command inside the active OS's sandbox. Returns stdout/stderr/exit,
 * plus metadata describing which backend was used. Never throws for policy
 * violations — those surface as non-zero exit codes, matching the Codex Rust
 * contract.
 */
export async function runSandboxed(req: SandboxRequest): Promise<SandboxResult> {
  if (req.policy === 'danger-full') {
    return execPassthrough(req, 'danger-full policy: no sandbox applied')
  }

  const p = platform()
  if (p === 'linux') return runLinux(req)
  if (p === 'darwin') return runMacos(req)
  if (p === 'win32') return runWindows(req)
  return execPassthrough(req, `unsupported platform: ${p}`)
}

// ─── Linux: bubblewrap ──────────────────────────────────────────

async function runLinux(req: SandboxRequest): Promise<SandboxResult> {
  const bwrap = findBinary('bwrap')
  if (!bwrap) return execPassthrough(req, 'bubblewrap (bwrap) not found on PATH')

  const args = buildBwrapArgs(req)
  return spawnAndCollect('bubblewrap', bwrap, args, req)
}

function buildBwrapArgs(req: SandboxRequest): string[] {
  const args: string[] = []

  // Unshare namespaces and use a fresh /proc.
  args.push('--unshare-all')
  // Keep network based on policy.
  if (req.allowNetwork ?? false) args.push('--share-net')

  // Bind-mount host system read-only. This is conservative — matches
  // bwrap.rs's default readonly-root layout.
  const roBinds = ['/bin', '/etc', '/lib', '/lib32', '/lib64', '/opt', '/sbin', '/usr', '/var']
  for (const p of roBinds) {
    if (existsSync(p)) args.push('--ro-bind', p, p)
  }

  // tmpfs for /tmp and a fresh proc+dev.
  args.push('--proc', '/proc')
  args.push('--dev', '/dev')
  args.push('--tmpfs', '/tmp')

  // Home handling per policy: workspace is always RW, rest of home is RO.
  if (req.policy === 'read-only') {
    args.push('--ro-bind-try', req.workspace, req.workspace)
  } else {
    args.push('--bind', req.workspace, req.workspace)
  }

  // Keep cwd inside the sandbox.
  args.push('--chdir', req.cwd)

  // Security hardening.
  args.push('--die-with-parent')
  args.push('--new-session')

  // Environment — pass a minimal safe set.
  args.push('--clearenv')
  const minEnv = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: req.workspace,
    USER: process.env.USER ?? 'sandbox',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: process.env.TERM ?? 'dumb',
    ...(req.env ?? {}),
  }
  for (const [k, v] of Object.entries(minEnv)) {
    args.push('--setenv', k, v)
  }

  // Finally, the command to run.
  args.push(req.command, ...req.args)
  return args
}

// ─── macOS: sandbox-exec (Seatbelt) ─────────────────────────────

async function runMacos(req: SandboxRequest): Promise<SandboxResult> {
  const exec = findBinary('sandbox-exec')
  if (!exec) return execPassthrough(req, 'sandbox-exec not found on PATH')

  const profile = buildSeatbeltProfile(req)
  const profileFile = join(tmpdir(), `claudex-sbx-${Date.now()}-${Math.random().toString(36).slice(2)}.sb`)
  try {
    // Write the profile to a temp file. sandbox-exec also accepts -p for
    // inline, but long profiles with quoted paths break arg length limits.
    const { writeFileSync, unlinkSync } = await import('fs')
    writeFileSync(profileFile, profile)
    const args = ['-f', profileFile, req.command, ...req.args]
    try {
      return await spawnAndCollect('seatbelt', exec, args, req)
    } finally {
      try { unlinkSync(profileFile) } catch { /* best-effort cleanup */ }
    }
  } catch (e: any) {
    return {
      stdout: '', stderr: `sandbox profile write failed: ${e?.message ?? e}`,
      exitCode: null, backend: 'seatbelt', unsandboxed: true, timedOut: false,
    }
  }
}

function buildSeatbeltProfile(req: SandboxRequest): string {
  // Base: deny all, then whitelist. Mirrors seatbelt.rs structure.
  const rules: string[] = []
  rules.push('(version 1)')
  rules.push('(deny default)')
  rules.push('(debug deny)')

  // Always allow reading system paths.
  rules.push('(allow file-read*)')
  // Process management for the command we spawn.
  rules.push('(allow process-exec)')
  rules.push('(allow process-fork)')
  rules.push('(allow signal (target self))')
  // sysctls, shared memory, mach ports that most CLIs need.
  rules.push('(allow sysctl-read)')
  rules.push('(allow mach-lookup)')
  rules.push('(allow ipc-posix-shm)')

  // Policy-dependent writes.
  if (req.policy === 'workspace-write') {
    rules.push(`(allow file-write* (subpath ${escSb(req.workspace)}))`)
    rules.push(`(allow file-write* (subpath "/private/tmp"))`)
    rules.push(`(allow file-write* (subpath "/tmp"))`)
    rules.push(`(allow file-write* (subpath "/var/folders"))`)
  }
  // Network per policy.
  if (req.allowNetwork) {
    rules.push('(allow network*)')
  } else {
    // UNIX sockets are often needed for syslog / keychain agent even
    // without general network. Allow abstract/local sockets only.
    rules.push('(allow network* (remote unix-socket))')
    rules.push('(allow network* (local ip))')
    rules.push('(deny network-outbound (remote ip))')
  }

  return rules.join('\n')
}

function escSb(path: string): string {
  return '"' + path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// ─── Windows: Job Objects (best-effort via cmd constraints) ─────

async function runWindows(req: SandboxRequest): Promise<SandboxResult> {
  // Windows Job Object APIs aren't exposed by Node's std spawn; the proper
  // port of windows-sandbox-rs would go through a small native addon.
  // For Phase-1 we apply the strongest fallback: run in a `cmd /d /s /c`
  // subshell with no inherited environment beyond what the policy allows,
  // and surface clearly that full sandboxing requires a native addon.
  const args = [...req.args]
  const envAllow: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    USERPROFILE: process.env.USERPROFILE ?? '',
    ...(req.env ?? {}),
  }
  const cp = spawn(req.command, args, {
    cwd: req.cwd,
    env: envAllow,
    windowsHide: true,
    // Best-effort: spawn in its own process group so we can kill-tree.
    detached: false,
  })
  return collectProcess('job-object', cp, req, 'windows job-object fallback: using env-scoped spawn (native addon not present)')
}

// ─── Passthrough (no sandbox) ───────────────────────────────────

async function execPassthrough(req: SandboxRequest, reason: string): Promise<SandboxResult> {
  const cp = spawn(req.command, req.args, {
    cwd: req.cwd,
    env: { ...process.env, ...(req.env ?? {}) },
    windowsHide: true,
  })
  return collectProcess('passthrough', cp, req, reason)
}

// ─── Shared process-collection helpers ──────────────────────────

async function spawnAndCollect(
  backend: SandboxResult['backend'],
  binary: string,
  args: string[],
  req: SandboxRequest,
): Promise<SandboxResult> {
  const cp = spawn(binary, args, {
    cwd: req.cwd,
    env: { ...(req.env ?? process.env) },
    windowsHide: true,
  })
  return collectProcess(backend, cp, req)
}

function collectProcess(
  backend: SandboxResult['backend'],
  cp: ChildProcess,
  req: SandboxRequest,
  unsandboxedReason?: string,
): Promise<SandboxResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false

    cp.stdout?.setEncoding('utf8')
    cp.stderr?.setEncoding('utf8')
    cp.stdout?.on('data', d => { stdout += String(d) })
    cp.stderr?.on('data', d => { stderr += String(d) })

    const timer = req.timeout && req.timeout > 0
      ? setTimeout(() => { timedOut = true; cp.kill('SIGTERM') }, req.timeout)
      : null

    cp.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({
        stdout,
        stderr: unsandboxedReason ? `[sandbox: ${unsandboxedReason}]\n${stderr}` : stderr,
        exitCode: code,
        backend,
        unsandboxed: backend === 'passthrough' || !!unsandboxedReason,
        timedOut,
      })
    })

    cp.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({
        stdout,
        stderr: (stderr + '\n' + String(err?.message ?? err)).trim(),
        exitCode: null,
        backend,
        unsandboxed: backend === 'passthrough' || !!unsandboxedReason,
        timedOut,
      })
    })
  })
}

function findBinary(name: string): string | null {
  // Quick PATH scan. Node has no built-in `which`, but existsSync on the
  // split PATH entries does the job for a small set of expected binaries.
  const pathsRaw = process.env.PATH ?? ''
  const sep = platform() === 'win32' ? ';' : ':'
  for (const dir of pathsRaw.split(sep)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
    if (platform() === 'win32') {
      for (const ext of ['.exe', '.cmd', '.bat']) {
        const c2 = join(dir, name + ext)
        if (existsSync(c2)) return c2
      }
    }
  }
  return null
}
