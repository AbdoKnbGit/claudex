/**
 * Cursor header + checksum generation.
 *
 * Port of reference/9router-master/open-sse/utils/cursorChecksum.js.
 * The x-cursor-checksum header uses a "jyh cipher": XOR each byte of the
 * (Date.now()/1e6) timestamp with a rolling key (seeded at 165), base64
 * the result, concatenate the machineId.
 *
 * Cursor's server rejects requests whose checksum/timestamp clock-skews
 * more than a few minutes — so we regenerate per request; no caching.
 */

import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** SHA-256(input + salt) as 64-char lowercase hex. */
export function hashed64Hex(input: string, salt = ''): string {
  return createHash('sha256').update(input + salt).digest('hex')
}

/**
 * Tiny UUIDv5 over the DNS namespace. We only use it to derive a stable
 * session id from the access token — pulling the full `uuid` package in
 * for this one call is overkill.
 */
const _DNS_NAMESPACE = [
  0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1,
  0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
]
export function uuidV5(name: string): string {
  const bytes = Buffer.from(name, 'utf8')
  const h = createHash('sha1')
  h.update(Buffer.from(_DNS_NAMESPACE))
  h.update(bytes)
  const digest = h.digest()
  // Per RFC 4122 §4.3: take the first 16 bytes, set version + variant.
  const out = Buffer.from(digest.slice(0, 16))
  out[6] = (out[6]! & 0x0f) | 0x50 // version 5
  out[8] = (out[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = out.toString('hex')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  )
}

/**
 * Jyh-cipher checksum. The algorithm below matches the reference 1:1:
 *   1. timestamp = floor(Date.now() / 1e6)
 *   2. bytes = timestamp as 6-byte big-endian
 *   3. t = 165
 *   4. for i in 0..5: bytes[i] = ((bytes[i] ^ t) + (i % 256)) & 0xFF; t = bytes[i]
 *   5. URL-safe base64 (no padding) using the custom alphabet below
 *   6. append machineId
 *
 * The custom alphabet places '-' / '_' at positions 62 / 63 (URL-safe).
 */
export function cursorChecksum(machineId: string): string {
  const timestamp = Math.floor(Date.now() / 1_000_000)
  const bytes = new Uint8Array([
    (timestamp >>> 40) & 0xff,
    (timestamp >>> 32) & 0xff,
    (timestamp >>> 24) & 0xff,
    (timestamp >>> 16) & 0xff,
    (timestamp >>> 8) & 0xff,
    timestamp & 0xff,
  ])

  let t = 165
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = ((bytes[i]! ^ t) + (i % 256)) & 0xff
    t = bytes[i]!
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let encoded = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    encoded += alphabet[a >> 2]!
    encoded += alphabet[((a & 3) << 4) | (b >> 4)]!
    if (i + 1 < bytes.length) encoded += alphabet[((b & 15) << 2) | (c >> 6)]!
    if (i + 2 < bytes.length) encoded += alphabet[c & 63]!
  }

  return `${encoded}${machineId}`
}

/**
 * Build the full Cursor request header set. machineId is optional — when
 * the user paste-flow didn't capture one we derive it from the token
 * (same SHA-256 scheme the reference uses). The client identity mirrors
 * Cursor's IDE ConnectRPC endpoint expectations, but does not require the
 * `cursor` binary or Cursor IDE to be installed.
 */
export function buildCursorHeaders(opts: {
  accessToken: string
  machineId?: string | null
  ghostMode?: boolean
}): Record<string, string> {
  // Tokens copy-pasted from state.vscdb sometimes come prefixed with
  // "<uuid>::" — strip that so we send only the real JWT.
  const clean = opts.accessToken.includes('::')
    ? (opts.accessToken.split('::')[1] ?? opts.accessToken)
    : opts.accessToken

  const machineId =
    opts.machineId
    || process.env.CURSOR_MACHINE_ID
    || _detectCursorMachineId()
    || hashed64Hex(clean, 'machineId')
  const sessionId = uuidV5(clean)
  const clientKey = hashed64Hex(clean)
  const checksum = cursorChecksum(machineId)
  const clientVersion = process.env.CURSOR_CLIENT_VERSION ?? _detectCursorClientVersion()
  const clientType = process.env.CURSOR_CLIENT_TYPE ?? 'ide'

  let os = 'linux'
  if (process.platform === 'win32') os = 'windows'
  else if (process.platform === 'darwin') os = 'macos'
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'

  return {
    'Authorization': `Bearer ${clean}`,
    'connect-accept-encoding': 'gzip',
    'connect-protocol-version': '1',
    'Content-Type': 'application/connect+proto',
    'User-Agent': 'connect-es/1.6.1',
    'x-amzn-trace-id': `Root=${randomUUID()}`,
    'x-client-key': clientKey,
    'x-cursor-checksum': checksum,
    'x-cursor-client-version': clientVersion,
    'x-cursor-client-type': clientType,
    'x-cursor-client-os': os,
    'x-cursor-client-arch': arch,
    'x-cursor-client-device-type': 'desktop',
    'x-cursor-config-version': randomUUID(),
    'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'x-ghost-mode': opts.ghostMode === false ? 'false' : 'true',
    'x-verified-ghost-mode': opts.ghostMode === false ? 'false' : 'true',
    'x-request-id': randomUUID(),
    'x-session-id': sessionId,
  }
}

function _detectCursorMachineId(): string | null {
  for (const candidate of _cursorGlobalStoragePaths('storage.json')) {
    try {
      if (!existsSync(candidate)) continue
      const raw = readFileSync(candidate, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const machineId =
        _readStringRecordField(parsed, 'storage.serviceMachineId')
        ?? _readStringRecordField(parsed, 'telemetry.machineId')
        ?? _readStringRecordField(parsed, 'machineId')
      if (machineId) return machineId
    } catch {
      // ignore and keep falling back
    }
  }

  return null
}

function _cursorGlobalStoragePaths(filename: string): string[] {
  const candidates: string[] = []
  const appData = process.env.APPDATA
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  const home = process.env.HOME ?? process.env.USERPROFILE

  if (appData) {
    candidates.push(join(appData, 'Cursor', 'User', 'globalStorage', filename))
  }
  if (xdgConfigHome) {
    candidates.push(join(xdgConfigHome, 'Cursor', 'User', 'globalStorage', filename))
  }
  if (home) {
    candidates.push(join(home, '.config', 'Cursor', 'User', 'globalStorage', filename))
    candidates.push(join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', filename))
  }

  return candidates
}

function _readStringRecordField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function _detectCursorClientVersion(): string {
  const candidates: string[] = []
  const localAppData = process.env.LOCALAPPDATA
  const home = process.env.HOME ?? process.env.USERPROFILE

  if (localAppData) {
    candidates.push(join(localAppData, 'Programs', 'cursor', 'resources', 'app', 'package.json'))
    candidates.push(join(localAppData, 'Programs', 'Cursor', 'resources', 'app', 'package.json'))
  }
  if (home) {
    candidates.push(join(home, 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app', 'package.json'))
  }
  candidates.push('/Applications/Cursor.app/Contents/Resources/app/package.json')
  candidates.push('/opt/Cursor/resources/app/package.json')
  candidates.push('/usr/share/cursor/resources/app/package.json')

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const raw = readFileSync(candidate, 'utf8')
      const parsed = JSON.parse(raw) as { version?: string }
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim()
      }
    } catch {
      // ignore and keep falling back
    }
  }

  return '3.1.17'
}
