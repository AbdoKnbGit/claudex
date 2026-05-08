/**
 * Native WhatsApp client for Tau.
 *
 * Ported from the claude-code-whatsapp reference MCP server (server.cjs).
 * Connection lifecycle uses the same OpenClaw-derived patterns:
 *   - 515 = normal restart, reconnect quickly
 *   - never process.exit on errors (only stop on 440 / 401)
 *   - exponential backoff with jitter, reset after a healthy period
 *   - watchdog detects stale connections (30 min)
 *   - creds backup before save, auto-restore on corruption
 */

import { copyFileSync, chmodSync, readFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import {
  clearAuthDir,
  ensureWhatsAppDirs,
  getAuthDir,
  getWhatsAppDir,
} from './paths.js'
import { isAllowed } from './access.js'

// Baileys is dynamically imported so the WhatsApp module pays its load cost
// only when actually used. A direct top-level import would pull ~30 transitive
// modules into Tau's startup path even when WhatsApp is off.
type AnyMessage = Record<string, any>
type Sock = any

type Listener = (event: InboundEvent) => void
export type InboundEvent = {
  jid: string
  participant: string | undefined
  msgId: string
  text: string
  isGroup: boolean
  senderNumber: string
  ts: number
  raw: AnyMessage
}

const RECONNECT = { initialMs: 2000, maxMs: 30000, factor: 1.8, jitter: 0.25 }
const WATCHDOG_INTERVAL = 60 * 1000
const STALE_TIMEOUT = 30 * 60 * 1000
const HEALTHY_THRESHOLD = 60 * 1000
const SEEN_TTL = 20 * 60 * 1000
const SEEN_MAX = 5000
const RAW_MSG_CAP = 500

// Logs go to ~/.claude/whatsapp/whatsapp.log — never stderr, since stderr in
// the interactive TUI overlaps ink's render frames and corrupts the screen.
const log = (msg: string) => {
  try {
    ensureWhatsAppDirs()
    appendFileSync(
      join(getWhatsAppDir(), 'whatsapp.log'),
      `${new Date().toISOString()} ${msg}\n`,
    )
  } catch {
    /* if logging itself fails, don't blow up the connection */
  }
}

class WhatsAppClient {
  private sock: Sock | null = null
  private connectionReady = false
  private retryCount = 0
  private connectedAt = 0
  private lastInboundAt = 0
  private watchdogTimer: NodeJS.Timeout | null = null
  private saveCreds: (() => Promise<void>) | null = null
  private credsSaveQueue: Promise<unknown> = Promise.resolve()
  private rawMessages = new Map<string, AnyMessage>()
  private seenMessages = new Map<string, number>()
  // IDs of messages Tau itself sent. Used to suppress the echo from
  // `messages.upsert` when fromMe=true so that user-authored fromMe
  // messages (the "Message yourself" chat) still drive the agent loop.
  private ourSentIds = new Set<string>()
  // The connected account's own identifiers, derived from sock.user at
  // socket open. WhatsApp Multi-Device exposes both a phone-number JID
  // (id, "1234:N@s.whatsapp.net") and a privacy LID (lid,
  // "9876:N@lid") — and the "Message yourself" chat is keyed by the
  // LID, not the phone number. We track both so the self-chat filter
  // matches whichever form WhatsApp delivers.
  private ownBareIds = new Set<string>()
  private listeners = new Set<Listener>()
  private qrListeners = new Set<(qr: string) => void>()
  private statusListeners = new Set<(s: ClientStatus) => void>()
  private status: ClientStatus = 'idle'
  private pairingPhone: string | null = null
  private pairingCodeCallback: ((code: string) => void) | null = null
  private stopped = false

  getStatus(): ClientStatus {
    return this.status
  }

  isConnected(): boolean {
    return this.connectionReady
  }

  getSock(): Sock {
    return this.sock
  }

  onInbound(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onQR(fn: (qr: string) => void): () => void {
    this.qrListeners.add(fn)
    return () => this.qrListeners.delete(fn)
  }

  onStatus(fn: (s: ClientStatus) => void): () => void {
    this.statusListeners.add(fn)
    fn(this.status)
    return () => this.statusListeners.delete(fn)
  }

  /**
   * Begin a pairing flow. Always wipes the auth dir first so a half-finished
   * previous attempt can't poison this one (the #1 cause of "Status: logged-out"
   * appearing before the QR was scannable). If `phone` is provided, requests
   * a pairing code; otherwise waits for a QR from Baileys.
   */
  async startPairing(
    phone?: string,
  ): Promise<{ code?: string; error?: string }> {
    // Stop any in-flight socket and wipe creds before we start. Otherwise
    // a stale creds.json triggers a 401/loggedOut on the new connection
    // and the QR never appears.
    this.cleanupSocket()
    clearAuthDir()
    this.pairingPhone = phone ?? null
    this.stopped = false
    return new Promise(resolve => {
      this.pairingCodeCallback = (code: string) => {
        this.pairingCodeCallback = null
        resolve({ code })
      }
      this.connect().catch(err => {
        log(`pairing connect failed: ${err?.stack ?? err}`)
        this.setStatus('error')
        if (this.pairingCodeCallback) {
          this.pairingCodeCallback = null
        }
        resolve({ error: String(err?.message ?? err) })
      })
      if (!phone) {
        // QR flow doesn't need a pairing code; resolve immediately so caller
        // can subscribe to onQR / onStatus for progress.
        setTimeout(() => {
          if (this.pairingCodeCallback) {
            this.pairingCodeCallback = null
            resolve({})
          }
        }, 200)
      }
    })
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    this.cleanupSocket()
    this.setStatus('idle')
  }

  private setStatus(s: ClientStatus): void {
    this.status = s
    for (const fn of this.statusListeners) {
      try {
        fn(s)
      } catch {
        /* ignore */
      }
    }
  }

  private isDuplicate(key: string): boolean {
    if (this.seenMessages.has(key)) return true
    this.seenMessages.set(key, Date.now())
    if (this.seenMessages.size > SEEN_MAX) {
      const now = Date.now()
      for (const [k, t] of this.seenMessages) {
        if (now - t > SEEN_TTL) this.seenMessages.delete(k)
      }
    }
    return false
  }

  private storeRaw(msg: AnyMessage): void {
    const id = msg.key?.id
    if (!id) return
    this.rawMessages.set(id, msg)
    if (this.rawMessages.size > RAW_MSG_CAP) {
      const first = this.rawMessages.keys().next().value
      if (first) this.rawMessages.delete(first)
    }
  }

  getRaw(id: string): AnyMessage | undefined {
    return this.rawMessages.get(id)
  }

  private computeDelay(attempt: number): number {
    const base = Math.min(
      RECONNECT.initialMs * Math.pow(RECONNECT.factor, attempt),
      RECONNECT.maxMs,
    )
    const jitter = base * RECONNECT.jitter * (Math.random() * 2 - 1)
    return Math.max(250, Math.round(base + jitter))
  }

  private cleanupSocket(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners()
      } catch {
        /* ignore */
      }
      try {
        this.sock.end(undefined)
      } catch {
        /* ignore */
      }
      this.sock = null
    }
    this.connectionReady = false
  }

  private maybeRestoreCredsFromBackup(): void {
    const credsPath = join(getAuthDir(), 'creds.json')
    const backupPath = join(getAuthDir(), 'creds.json.bak')
    try {
      JSON.parse(readFileSync(credsPath, 'utf8'))
      return
    } catch {
      /* fall through */
    }
    try {
      JSON.parse(readFileSync(backupPath, 'utf8'))
      copyFileSync(backupPath, credsPath)
      try {
        chmodSync(credsPath, 0o600)
      } catch {
        /* ignore */
      }
      log('restored creds.json from backup')
    } catch {
      /* no backup either */
    }
  }

  private enqueueSaveCreds = (): void => {
    if (!this.saveCreds) return
    const credsPath = join(getAuthDir(), 'creds.json')
    const backupPath = join(getAuthDir(), 'creds.json.bak')
    this.credsSaveQueue = this.credsSaveQueue
      .then(() => {
        try {
          JSON.parse(readFileSync(credsPath, 'utf8'))
          copyFileSync(credsPath, backupPath)
          try {
            chmodSync(backupPath, 0o600)
          } catch {
            /* ignore */
          }
        } catch {
          /* no creds yet or unparseable; skip backup */
        }
        return this.saveCreds!()
      })
      .then(() => {
        try {
          chmodSync(credsPath, 0o600)
        } catch {
          /* ignore */
        }
      })
      .catch(err => {
        log(`creds save error: ${err} — retrying in 1s`)
        setTimeout(() => this.enqueueSaveCreds(), 1000)
      })
  }

  private async connect(): Promise<void> {
    this.cleanupSocket()
    if (this.stopped) return

    ensureWhatsAppDirs()
    this.maybeRestoreCredsFromBackup()

    // Baileys exposes `makeWASocket` as both default and named export. We
    // pull from the named exports so destructuring the rest works uniformly.
    const baileys: any = await import('@whiskeysockets/baileys')
    const {
      makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
    } = baileys

    const pinoMod: any = await import('pino')
    const pino: any = pinoMod.default ?? pinoMod
    const logger = pino({ level: 'silent' })

    const authState = await useMultiFileAuthState(getAuthDir())
    this.saveCreds = authState.saveCreds
    const { version } = await fetchLatestBaileysVersion()

    this.setStatus(authState.state.creds.registered ? 'connecting' : 'pairing')

    const sock = makeWASocket({
      auth: {
        creds: authState.state.creds,
        keys: makeCacheableSignalKeyStore(authState.state.keys, logger),
      },
      version,
      logger,
      printQRInTerminal: false,
      browser: ['Mac OS', 'Safari', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async (key: AnyMessage) => {
        const cached = this.rawMessages.get(key.id)
        if (cached?.message) return cached.message
        return { conversation: '' }
      },
    })
    this.sock = sock

    sock.ev.on('creds.update', this.enqueueSaveCreds)

    // Pairing-code path. Request after a short delay so the socket has time
    // to establish before we ask for a code.
    if (!authState.state.creds.registered && this.pairingPhone) {
      const phone = this.pairingPhone
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''))
          if (this.pairingCodeCallback) {
            this.pairingCodeCallback(code)
          }
        } catch (err) {
          log(`pairing code request failed: ${err}`)
        }
      }, 3000)
    }

    sock.ev.on('connection.update', (update: AnyMessage) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        log(`QR received (len=${qr.length}, listeners=${this.qrListeners.size})`)
        for (const fn of this.qrListeners) {
          try {
            fn(qr)
          } catch (err) {
            log(`qr listener threw: ${err}`)
          }
        }
      }

      if (connection === 'close') {
        this.connectionReady = false
        const reason = lastDisconnect?.error?.output?.statusCode

        if (reason === 440) {
          log('session conflict (440) — re-link required')
          this.setStatus('error')
          return
        }
        if (reason === DisconnectReason.loggedOut) {
          log('logged out (401) — re-pair needed')
          this.setStatus('logged-out')
          return
        }
        if (reason === 515) {
          log('WhatsApp requested restart (515) — reconnecting in 2s')
          setTimeout(() => void this.connect(), 2000)
          return
        }

        if (
          this.connectedAt &&
          Date.now() - this.connectedAt > HEALTHY_THRESHOLD
        ) {
          this.retryCount = 0
        }
        if (this.retryCount >= 15) {
          log('max retries reached — waiting 5min before reset')
          this.retryCount = 0
          setTimeout(() => void this.connect(), 5 * 60 * 1000)
          return
        }
        const delay = this.computeDelay(this.retryCount)
        this.retryCount++
        log(
          `connection closed (${reason}) — retry in ${delay}ms (attempt ${this.retryCount})`,
        )
        this.setStatus('reconnecting')
        setTimeout(() => void this.connect(), delay)
      }

      if (connection === 'open') {
        this.connectionReady = true
        this.connectedAt = Date.now()
        this.retryCount = 0
        this.pairingPhone = null
        // Pull every identifier WhatsApp gave us — both the phone-number
        // JID and the LID, from sock.user (preferred) and creds.me as a
        // fallback. Strip the ":N" device suffix and reduce to the bare
        // ID part (everything before "@" or ":") so a remoteJid match
        // works regardless of which form arrives.
        const candidates = [
          sock.user?.id,
          sock.user?.lid,
          authState.state.creds.me?.id,
          authState.state.creds.me?.lid,
        ].filter(Boolean) as string[]
        this.ownBareIds = new Set(
          candidates.map(id => id.replace(/[@:].*$/, '')).filter(Boolean),
        )
        log(
          `connected · sock.user=${JSON.stringify(sock.user)} creds.me=${JSON.stringify(authState.state.creds.me)} ownBareIds=${[...this.ownBareIds].join(',')}`,
        )
        this.setStatus('connected')

        if (this.watchdogTimer) clearInterval(this.watchdogTimer)
        this.watchdogTimer = setInterval(() => {
          if (!this.connectionReady) return
          if (
            this.lastInboundAt &&
            Date.now() - this.lastInboundAt > STALE_TIMEOUT
          ) {
            log(
              `no messages in ${STALE_TIMEOUT / 60000}min — forcing reconnect`,
            )
            void this.connect()
          }
        }, WATCHDOG_INTERVAL)
      }
    })

    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('error', (err: unknown) =>
        log(`WebSocket error: ${err}`),
      )
    }

    sock.ev.on(
      'messages.upsert',
      async ({ messages }: { messages: AnyMessage[] }) => {
        for (const msg of messages) {
          if (!msg.message) continue

          const jid = msg.key.remoteJid
          const msgId = msg.key.id
          const fromMe = !!msg.key.fromMe

          log(
            `upsert: jid=${jid} fromMe=${fromMe} id=${msgId} hasText=${!!extractText(msg.message)}`,
          )

          if (!jid) continue
          if (jid.endsWith('@broadcast') || jid.endsWith('@status')) continue

          // Drive Tau ONLY from the "Message yourself" chat. WhatsApp can
          // address the connected account by either its phone-number JID
          // or its LID, so we accept a match against any of the bare IDs
          // captured at connect time. Groups, friends, and side chats
          // never match and are dropped.
          const fromBareId = jid.replace(/[@:].*$/, '')
          if (this.ownBareIds.size === 0 || !this.ownBareIds.has(fromBareId)) {
            log(
              `upsert dropped: not self chat (own=${[...this.ownBareIds].join('|')} from=${fromBareId})`,
            )
            continue
          }

          // fromMe messages in the self-chat come from two sources:
          // (1) Tau's own replies echoed back — skip by tracked id.
          // (2) you typing in "Message yourself" — process as a prompt.
          if (fromMe && msgId && this.ourSentIds.has(msgId)) continue

          const participant = msg.key.participant

          if (msgId && this.isDuplicate(`${jid}:${msgId}`)) continue
          if (!isAllowed(jid, participant || undefined)) continue

          try {
            await sock.readMessages([msg.key])
          } catch {
            /* ignore */
          }

          this.lastInboundAt = Date.now()
          this.storeRaw(msg)
          this.dispatchInbound(msg, jid, participant || undefined)
        }
      },
    )
  }

  private dispatchInbound(
    msg: AnyMessage,
    jid: string,
    participant: string | undefined,
  ): void {
    const text = extractText(msg.message ?? {})
    const isGroup = jid.endsWith('@g.us')
    const senderJid = participant || jid
    const senderNumber = formatJid(senderJid)
    const ts = (Number(msg.messageTimestamp) || Date.now() / 1000) * 1000
    const event: InboundEvent = {
      jid,
      participant,
      msgId: msg.key?.id ?? `${Date.now()}`,
      text,
      isGroup,
      senderNumber,
      ts,
      raw: msg,
    }
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch (err) {
        log(`inbound listener error: ${err}`)
      }
    }
  }

  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock || !this.connectionReady) {
      throw new Error('WhatsApp not connected')
    }
    const sent = await this.sock.sendMessage(jid, { text })
    if (sent?.key?.id) this.trackSent(sent.key.id)
  }

  async react(jid: string, msgId: string, emoji: string): Promise<void> {
    if (!this.sock || !this.connectionReady) return
    const sent = await this.sock.sendMessage(jid, {
      react: { text: emoji, key: { remoteJid: jid, id: msgId } },
    })
    if (sent?.key?.id) this.trackSent(sent.key.id)
  }

  private trackSent(id: string): void {
    this.ourSentIds.add(id)
    // FIFO eviction — Set preserves insertion order. Cap at 500 so a
    // long-running session doesn't grow unbounded.
    if (this.ourSentIds.size > 500) {
      const first = this.ourSentIds.values().next().value
      if (first) this.ourSentIds.delete(first)
    }
  }

  isOurSentId(id: string): boolean {
    return this.ourSentIds.has(id)
  }
}

export type ClientStatus =
  | 'idle'
  | 'connecting'
  | 'pairing'
  | 'connected'
  | 'reconnecting'
  | 'logged-out'
  | 'error'

let instance: WhatsAppClient | null = null

export function getClient(): WhatsAppClient {
  if (!instance) instance = new WhatsAppClient()
  return instance
}

function extractText(msg: AnyMessage): string {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    ''
  )
}

function formatJid(jid: string): string {
  return jid
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@g\.us$/, '')
    .replace(/@lid$/, '')
    .replace(/:\d+$/, '')
}

// Baileys crypto errors should reconnect, not crash. Keep handler scoped.
let cryptoHandlerInstalled = false
export function installCryptoErrorHandler(): void {
  if (cryptoHandlerInstalled) return
  cryptoHandlerInstalled = true
  process.on('unhandledRejection', err => {
    const msg = String(err).toLowerCase()
    if (
      (msg.includes('unable to authenticate data') ||
        msg.includes('bad mac')) &&
      (msg.includes('baileys') ||
        msg.includes('noise-handler') ||
        msg.includes('signal'))
    ) {
      log('crypto error — forcing reconnect')
      const c = instance
      if (c) setTimeout(() => void c.start(), 2000)
    }
  })
}
