// Local OS-native text-to-speech for hey-mode responses.
//
// Uses whatever the platform ships with — zero dependencies, no API key,
// no network. Quality varies (Windows SAPI ≈ macOS `say` < ElevenLabs)
// but this is the "just works" path that satisfies the user's keep-it-easy
// rule. Power users can later layer a higher-quality TTS via env var
// (TAU_TTS_CMD) without touching this file's surface.
//
// Per-platform backends:
//   Windows: powershell.exe → System.Speech.Synthesizer (SAPI), text via stdin
//   macOS:   say -- (text via -- to handle leading-dash strings safely)
//   Linux:   espeak (best-effort; falls back to a no-op if espeak missing)

import { spawn, spawnSync } from 'child_process'
import { logForDebugging } from '../utils/debug.js'

const TTS_CMD_ENV = 'TAU_TTS_CMD'
const LEGACY_TTS_CMD_ENV = 'CLAUDEX_TTS_CMD'
const MAX_SPEECH_CHARS = 2000

// PowerShell that reads the entire text-to-speak from stdin and pipes it
// into the SAPI synthesizer. Reading via stdin sidesteps argv quoting
// pitfalls (smart quotes, dollar signs, embedded newlines, length limits)
// that would otherwise break user-visible speech on real assistant
// responses. Console::In.ReadToEnd is synchronous and blocks until the
// pipe closes, which we do explicitly in spawnPowerShellSpeak.
const POWERSHELL_SCRIPT =
  "Add-Type -AssemblyName System.Speech;" +
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;" +
  "$t = [Console]::In.ReadToEnd();" +
  "$s.Speak($t);"

function checkBinary(name: string): boolean {
  // --version isn't universal (espeak uses --version, say has no flag) so
  // probe by spawning with no args and looking only at the spawn error —
  // exit code is irrelevant, we only care that the binary exists on PATH.
  const result = spawnSync(name, [], {
    stdio: 'ignore',
    timeout: 2000,
  })
  return result.error === undefined
}

let availabilityCache: TtsAvailability | null = null

function getCustomTtsCommand(): string | undefined {
  return process.env[TTS_CMD_ENV] ?? process.env[LEGACY_TTS_CMD_ENV]
}

export type TtsAvailability = {
  available: boolean
  backend: 'sapi' | 'say' | 'espeak' | 'custom' | null
  reason: string | null
}

export function checkTtsAvailable(): TtsAvailability {
  if (availabilityCache) return availabilityCache

  if (getCustomTtsCommand()) {
    availabilityCache = { available: true, backend: 'custom', reason: null }
    return availabilityCache
  }

  if (process.platform === 'win32') {
    // PowerShell is present on every supported Windows version (5.1+ on
    // Win10+; pwsh on newer). System.Speech is part of .NET Framework
    // and is shipped with the OS. Treat as always available — the actual
    // failure surfaces from the spawned PowerShell at speak time, not
    // here, since checking would itself launch PowerShell.
    availabilityCache = { available: true, backend: 'sapi', reason: null }
    return availabilityCache
  }
  if (process.platform === 'darwin') {
    if (checkBinary('say')) {
      availabilityCache = { available: true, backend: 'say', reason: null }
      return availabilityCache
    }
    availabilityCache = {
      available: false,
      backend: null,
      reason: '`say` not found on PATH (it ships with macOS — check $PATH).',
    }
    return availabilityCache
  }
  // Linux + everything else
  if (checkBinary('espeak')) {
    availabilityCache = { available: true, backend: 'espeak', reason: null }
    return availabilityCache
  }
  if (checkBinary('espeak-ng')) {
    availabilityCache = { available: true, backend: 'espeak', reason: null }
    return availabilityCache
  }
  availabilityCache = {
    available: false,
    backend: null,
    reason:
      'No TTS engine available. Install espeak (e.g. `sudo apt install espeak` or `sudo dnf install espeak`).',
  }
  return availabilityCache
}

export function _resetTtsCacheForTesting(): void {
  availabilityCache = null
}

let activeSpeaker: ReturnType<typeof spawn> | null = null

// Stop any currently-speaking TTS process. Safe to call when no speech
// is active. Used by /hey when the user starts a new turn — the previous
// response shouldn't keep talking over fresh input.
export function stopSpeaking(): void {
  if (activeSpeaker && !activeSpeaker.killed) {
    try {
      activeSpeaker.kill('SIGTERM')
    } catch (err) {
      logForDebugging(
        `[hey] failed to stop active TTS process: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  activeSpeaker = null
}

function killActiveSpeakerOnAbort(signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {}
  const onAbort = () => stopSpeaking()
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

export type SpeakOptions = {
  signal?: AbortSignal
}

// Speak the given text and resolve when audio playback finishes. The
// previous speaker (if any) is interrupted — there's no audio mixer in
// the terminal and overlapping voices is worse than truncating.
export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const trimmed = text.trim().slice(0, MAX_SPEECH_CHARS)
  if (!trimmed) return

  const avail = checkTtsAvailable()
  if (!avail.available) {
    logForDebugging(`[hey] TTS unavailable: ${avail.reason ?? 'unknown'}`)
    return
  }

  stopSpeaking()

  const cleanupAbort = killActiveSpeakerOnAbort(opts.signal)

  try {
    if (avail.backend === 'custom') {
      await spawnCustomSpeak(trimmed)
      return
    }
    if (avail.backend === 'sapi') {
      await spawnPowerShellSpeak(trimmed)
      return
    }
    if (avail.backend === 'say') {
      await spawnSaySpeak(trimmed)
      return
    }
    if (avail.backend === 'espeak') {
      await spawnEspeakSpeak(trimmed)
      return
    }
  } finally {
    cleanupAbort()
  }
}

function spawnPowerShellSpeak(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // -NoProfile skips $PROFILE init (faster cold start, avoids user-script
    // side effects). -Command runs the inline script. WindowStyle Hidden
    // keeps a stray console window from flashing on some Windows configs.
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        POWERSHELL_SCRIPT,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    )
    activeSpeaker = child
    let settled = false
    let stderr = ''
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      if (activeSpeaker === child) activeSpeaker = null
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('close', code => {
      if (code !== 0 && code !== null) {
        logForDebugging(
          `[hey] PowerShell SAPI exit ${code}: ${stderr.slice(-200)}`,
        )
      }
      finish()
    })
    child.on('error', err => {
      finish(err)
    })
    child.stdin?.on('error', err => {
      logForDebugging(
        `[hey] PowerShell SAPI stdin error: ${err instanceof Error ? err.message : String(err)}`,
      )
      finish()
    })
    try {
      child.stdin?.end(text, 'utf8')
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

function spawnSaySpeak(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `--` separates `say`'s flags from the text, so leading dashes in
    // the text aren't reinterpreted. say reads from stdin if no text is
    // given, but the flag form is simpler and avoids encoding edge cases.
    const child = spawn('say', ['--', text], { stdio: 'ignore' })
    activeSpeaker = child
    child.on('close', () => {
      if (activeSpeaker === child) activeSpeaker = null
      resolve()
    })
    child.on('error', err => {
      if (activeSpeaker === child) activeSpeaker = null
      reject(err)
    })
  })
}

function spawnEspeakSpeak(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('espeak', ['--', text], { stdio: 'ignore' })
    activeSpeaker = child
    child.on('close', () => {
      if (activeSpeaker === child) activeSpeaker = null
      resolve()
    })
    child.on('error', err => {
      if (activeSpeaker === child) activeSpeaker = null
      reject(err)
    })
  })
}

function spawnCustomSpeak(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = getCustomTtsCommand()
    if (!cmd) {
      resolve()
      return
    }
    // The custom command is parsed shell-style; user supplies the full
    // invocation (e.g. `flite -voice slt -t`) and we pipe text via stdin.
    // Splitting on whitespace is intentionally simple — quoting is the
    // user's responsibility, matching the shell-quote semantics already
    // used elsewhere in the codebase.
    const parts = cmd.split(/\s+/).filter(Boolean)
    const [bin, ...args] = parts
    if (!bin) {
      resolve()
      return
    }
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    activeSpeaker = child
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      if (activeSpeaker === child) activeSpeaker = null
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }
    child.on('close', () => {
      finish()
    })
    child.on('error', err => {
      finish(err)
    })
    child.stdin?.on('error', err => {
      logForDebugging(
        `[hey] custom TTS stdin error: ${err instanceof Error ? err.message : String(err)}`,
      )
      finish()
    })
    try {
      child.stdin?.end(text, 'utf8')
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
