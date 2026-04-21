/**
 * AWS EventStream binary frame parser (application/vnd.amazon.eventstream).
 *
 * CodeWhisperer streams events as a sequence of self-delimited binary
 * frames. Each frame:
 *
 *   ┌──────────────┬──────────────┬──────────┬─────────┬──────────┬──────────┐
 *   │ Total length │ Headers len  │ Prelude  │ Headers │ Payload  │  Message │
 *   │   (u32 BE)   │   (u32 BE)   │   CRC    │         │          │    CRC   │
 *   │   4 bytes    │   4 bytes    │ 4 bytes  │   var   │   var    │  4 bytes │
 *   └──────────────┴──────────────┴──────────┴─────────┴──────────┴──────────┘
 *
 * Headers are (name_len:u8, name:utf8, type:u8, value). We only need
 * type=7 (string) to read the `:event-type` header that tells us what
 * the payload JSON represents (assistantResponseEvent, toolUseEvent, …).
 *
 * Ported from reference/9router-master/open-sse/executors/kiro.js
 * (parseEventFrame + the transform loop). Compared to that source we
 * drop the CRC validation — the stream is TLS-protected end-to-end, and
 * skipping the check lets the parser stay self-contained (no crc32c
 * dependency for a 400-line lane).
 */

export interface KiroEvent {
  eventType: string
  payload: Record<string, unknown> | null
}

/**
 * Incrementally parse EventStream frames from a growing byte buffer.
 * Returns the events parsed this call and the residual bytes that still
 * need more data. Carrier is a typed-array view, not a DataView — the
 * consumer loop is simpler if it just appends and re-feeds.
 */
export function parseFrames(buf: Uint8Array): {
  events: KiroEvent[]
  remainder: Uint8Array
} {
  const events: KiroEvent[] = []
  let cursor = buf

  // Hard cap on iterations per chunk — identical to the reference guard
  // against pathologically small total-length values from a partial frame.
  let iterations = 0
  const maxIterations = 1000

  while (cursor.length >= 16 && iterations < maxIterations) {
    iterations++
    const view = new DataView(cursor.buffer, cursor.byteOffset, cursor.length)
    const totalLength = view.getUint32(0, false)

    // Invalid prelude OR the frame hasn't fully arrived yet.
    if (totalLength < 16 || totalLength > cursor.length) break

    const frame = cursor.slice(0, totalLength)
    cursor = cursor.slice(totalLength)
    const ev = _parseFrame(frame)
    if (ev) events.push(ev)
  }

  return { events, remainder: cursor }
}

function _parseFrame(frame: Uint8Array): KiroEvent | null {
  try {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.length)
    const headersLength = view.getUint32(4, false)

    // Parse headers. Layout:
    //   u8 name_len, utf8 name, u8 type, (type-specific value)
    // We only read type=7 (UTF-8 string). Unknown types → stop at that
    // header so we can at least read the ones we understand so far.
    const headers: Record<string, string> = {}
    let offset = 12 // 4 (total) + 4 (headers len) + 4 (prelude CRC)
    const headerEnd = 12 + headersLength

    while (offset < headerEnd && offset < frame.length) {
      const nameLen = frame[offset]!
      offset++
      if (offset + nameLen > frame.length) break
      const name = _utf8(frame, offset, nameLen)
      offset += nameLen
      const headerType = frame[offset]!
      offset++
      if (headerType === 7) {
        const valueLen = (frame[offset]! << 8) | frame[offset + 1]!
        offset += 2
        if (offset + valueLen > frame.length) break
        headers[name] = _utf8(frame, offset, valueLen)
        offset += valueLen
      } else {
        break
      }
    }

    const payloadStart = 12 + headersLength
    const payloadEnd = frame.length - 4 // trailing message CRC
    let payload: Record<string, unknown> | null = null
    if (payloadEnd > payloadStart) {
      const payloadStr = _utf8(frame, payloadStart, payloadEnd - payloadStart)
      if (payloadStr.trim()) {
        try {
          payload = JSON.parse(payloadStr) as Record<string, unknown>
        } catch {
          // Drop malformed payloads — the executor logs and the outer
          // loop can fall through on missing event data.
          payload = null
        }
      }
    }

    const eventType = headers[':event-type'] ?? ''
    return { eventType, payload }
  } catch {
    return null
  }
}

const _decoder = new TextDecoder()
function _utf8(buf: Uint8Array, offset: number, length: number): string {
  return _decoder.decode(buf.slice(offset, offset + length))
}
