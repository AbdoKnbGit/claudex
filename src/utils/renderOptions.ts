import { constants as fsConstants, openSync } from 'fs'
import { ReadStream } from 'tty'
import type { RenderOptions } from '../ink.js'
import { isEnvTruthy } from './envUtils.js'
import { logError } from './log.js'
import { getWindowsTerminalStreams } from './windowsTerminal.js'

// Cached stdin override - computed once per process
let cachedStdinOverride: ReadStream | undefined | null = null

/**
 * Gets a ReadStream for /dev/tty when stdin is piped.
 * This allows interactive Ink rendering even when stdin is a pipe.
 * Result is cached for the lifetime of the process.
 *
 * On Windows, the TTY stream replacement in cli.tsx handles this case
 * before we get here, so no /dev/tty equivalent is needed.
 */
function getStdinOverride(): ReadStream | undefined {
  // Return cached result if already computed
  if (cachedStdinOverride !== null) {
    return cachedStdinOverride
  }

  // No override needed if stdin is already a real TTY.
  // If __claudexPatchedTTY is set, isTTY was faked by Strategy C — still probe.
  if (process.stdin.isTTY && !(process as any).__claudexPatchedTTY) {
    cachedStdinOverride = undefined
    return undefined
  }

  // Skip in CI environments
  if (isEnvTruthy(process.env.CI)) {
    cachedStdinOverride = undefined
    return undefined
  }

  // Skip if running MCP (input hijacking breaks MCP)
  if (process.argv.includes('mcp')) {
    cachedStdinOverride = undefined
    return undefined
  }

  // On Windows, try CONIN$ — the console input pseudo-file, equivalent
  // to Unix /dev/tty. This works even when process.stdin is a pipe
  // (e.g., npm .cmd shims, Bun-compiled binaries).
  // Use //./CONIN$ as fallback because bare CONIN$ gets path-mangled
  // by MSYS2/Git Bash.
  if (process.platform === 'win32') {
    for (const p of ['CONIN$', '//./CONIN$']) {
      try {
        const conFd = openSync(p, fsConstants.O_RDONLY)
        const conStream = new ReadStream(conFd)
        if (conStream.isTTY) {
          cachedStdinOverride = conStream
          return cachedStdinOverride
        }
      } catch {
        // Try next path variant
      }
    }
    cachedStdinOverride = undefined
    return undefined
  }

  // Try to open /dev/tty as an alternative input source
  try {
    const ttyFd = openSync(
      '/dev/tty',
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
    )
    const ttyStream = new ReadStream(ttyFd)
    // Explicitly set isTTY to true since we know /dev/tty is a TTY.
    // This is needed because some runtimes (like Bun's compiled binaries)
    // may not correctly detect isTTY on ReadStream created from a file descriptor.
    ttyStream.isTTY = true
    cachedStdinOverride = ttyStream
    return cachedStdinOverride
  } catch (err) {
    logError(err as Error)
    cachedStdinOverride = undefined
    return undefined
  }
}

/**
 * Returns base render options for Ink, including stdin override when needed.
 * Use this for all render() calls to ensure piped input works correctly.
 *
 * @param exitOnCtrlC - Whether to exit on Ctrl+C (usually false for dialogs)
 */
export function getBaseRenderOptions(
  exitOnCtrlC: boolean = false,
): RenderOptions {
  const stdin = getStdinOverride()
  const options: RenderOptions = { exitOnCtrlC }
  if (stdin) {
    options.stdin = stdin
  }
  // Windows fallback: some shells misreport stdio TTY flags. Probe real
  // console streams from fds (and CONOUT$/CONIN$) and wire Ink to those
  // streams when available. Also probe when isTTY was patched (Strategy C).
  const patchedTTY = !!(process as any).__claudexPatchedTTY
  if (process.platform === 'win32' && (!process.stdout.isTTY || patchedTTY)) {
    // If stderr is the only TTY stream, render through it.
    if (process.stderr.isTTY) {
      options.stdout = process.stderr
      options.stderr = process.stderr
    }
    const windowsStreams = getWindowsTerminalStreams()
    if (windowsStreams.stdout) {
      options.stdout = windowsStreams.stdout
      options.stderr = windowsStreams.stderr ?? windowsStreams.stdout
    } else if (!options.stdout && windowsStreams.stderr) {
      options.stdout = windowsStreams.stderr
      options.stderr = windowsStreams.stderr
    }
    if (!options.stdin && windowsStreams.stdin) {
      options.stdin = windowsStreams.stdin
    }
  }
  // Even when stdout.isTTY is true (e.g., Strategy B patched it or
  // Strategy A succeeded for stdout only), stdin might still be a pipe.
  // Ensure we have a working stdin via the override or Windows probes.
  if (process.platform === 'win32' && !options.stdin && (!process.stdin.isTTY || patchedTTY)) {
    const windowsStreams = getWindowsTerminalStreams()
    if (windowsStreams.stdin) {
      options.stdin = windowsStreams.stdin
    }
  }
  return options
}
