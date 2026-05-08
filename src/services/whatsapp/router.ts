/**
 * Routes WhatsApp inbound messages into the Tau command queue, and tracks
 * which chat to reply into when the assistant responds.
 *
 * The "current chat" is the JID of the most-recent inbound message. While
 * Tau is processing a turn driven by WhatsApp, the assistant's text reply
 * is mirrored to that chat. Manual terminal-typed turns clear the active
 * chat so the assistant doesn't accidentally reply on WhatsApp.
 */

import { enqueue } from '../../utils/messageQueueManager.js'
import { getClient, type InboundEvent } from './client.js'
import { tryConsumeWhatsAppPermissionReply } from './permissions.js'

let activeChatJid: string | null = null
let activeMsgId: string | null = null

export function getActiveChatJid(): string | null {
  return activeChatJid
}

export function clearActiveChat(): void {
  activeChatJid = null
  activeMsgId = null
}

export function setActiveChat(jid: string, msgId: string | null): void {
  activeChatJid = jid
  activeMsgId = msgId
}

let unsubscribe: (() => void) | null = null

export function startInboundRouter(): void {
  if (unsubscribe) return
  const client = getClient()
  unsubscribe = client.onInbound(async (e: InboundEvent) => {
    const text = e.text.trim()
    if (!text) return

    activeChatJid = e.jid
    activeMsgId = e.msgId

    // React with a small ack so the user knows Tau picked up the message.
    void client.react(e.jid, e.msgId, '👀').catch(() => {})

    if (tryConsumeWhatsAppPermissionReply(e.jid, text)) {
      return
    }

    enqueue({
      value: text,
      mode: 'prompt' as const,
      skipSlashCommands: true,
      bridgeOrigin: true,
      whatsappOrigin: true,
    })
  })
}

export function stopInboundRouter(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  clearActiveChat()
}
