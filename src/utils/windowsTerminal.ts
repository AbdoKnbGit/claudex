import { constants as fsConstants, openSync } from 'fs'
import { ReadStream, WriteStream } from 'tty'

type WindowsTerminalStreams = {
  stdout?: WriteStream
  stderr?: WriteStream
  stdin?: ReadStream
}

let cachedStreams: WindowsTerminalStreams | null = null
let cachedHasConsoleTTY: boolean | null = null

function hasWindowsTerminalEnvHint(): boolean {
  if (process.env.CI) {
    return false
  }
  if (process.env.WT_SESSION || process.env.ConEmuPID || process.env.ANSICON) {
    return true
  }
  if (process.env.SESSIONNAME && process.env.SESSIONNAME !== 'Services') {
    return true
  }
  if (process.env.MSYSTEM || process.env.MINGW_PREFIX) {
    return true
  }
  if (process.env.TERM && process.env.TERM !== 'dumb') {
    return true
  }
  return false
}

function probeWindowsTerminalStreams(): WindowsTerminalStreams {
  const streams: WindowsTerminalStreams = {}

  // First try: create TTY streams directly from fds 0/1/2.
  // Works when the process was launched with real console handles.
  try {
    const stdout = new WriteStream(1)
    if (stdout.isTTY) {
      streams.stdout = stdout
    }
  } catch {
    // Ignore: no console stream available on fd 1.
  }

  try {
    const stderr = new WriteStream(2)
    if (stderr.isTTY) {
      streams.stderr = stderr
    }
  } catch {
    // Ignore: no console stream available on fd 2.
  }

  try {
    const stdin = new ReadStream(0)
    if (stdin.isTTY) {
      streams.stdin = stdin
    }
  } catch {
    // Ignore: no console stream available on fd 0.
  }

  // Fallback: try CONOUT$/CONIN$ — Windows console pseudo-files.
  // These bypass piped stdio (npm .cmd shims, Bun binaries) and
  // connect directly to the console, like /dev/tty on Unix.
  // Use //./CONOUT$ format (UNC device path) because bare CONOUT$
  // gets path-mangled by MSYS2/Git Bash into C:\...\CONOUT$.
  const conoutPaths = ['CONOUT$', '//./CONOUT$']
  const coninPaths = ['CONIN$', '//./CONIN$']

  if (!streams.stdout) {
    for (const p of conoutPaths) {
      try {
        const conoutFd = openSync(p, fsConstants.O_WRONLY)
        const conout = new WriteStream(conoutFd)
        if (conout.isTTY) {
          streams.stdout = conout
          if (!streams.stderr) {
            streams.stderr = conout
          }
          break
        }
      } catch {
        // Try next path variant.
      }
    }
  }

  if (!streams.stdin) {
    for (const p of coninPaths) {
      try {
        const coninFd = openSync(p, fsConstants.O_RDONLY)
        const conin = new ReadStream(coninFd)
        if (conin.isTTY) {
          streams.stdin = conin
          break
        }
      } catch {
        // Try next path variant.
      }
    }
  }

  return streams
}

export function getWindowsTerminalStreams(): WindowsTerminalStreams {
  if (cachedStreams) {
    return cachedStreams
  }
  cachedStreams = probeWindowsTerminalStreams()
  return cachedStreams
}

export function hasWindowsConsoleTTY(): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  if (cachedHasConsoleTTY !== null) {
    return cachedHasConsoleTTY
  }

  if (process.stdout.isTTY || process.stderr.isTTY || process.stdin.isTTY) {
    cachedHasConsoleTTY = true
    return true
  }

  if (hasWindowsTerminalEnvHint()) {
    cachedHasConsoleTTY = true
    return true
  }

  const streams = getWindowsTerminalStreams()
  cachedHasConsoleTTY = Boolean(
    streams.stdout?.isTTY || streams.stderr?.isTTY || streams.stdin?.isTTY,
  )
  return cachedHasConsoleTTY
}
