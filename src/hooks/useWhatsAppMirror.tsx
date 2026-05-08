/**
 * Mirrors new assistant text replies out to the WhatsApp chat that drove the
 * most recent inbound message. Modeled on useReplBridge's "track lastWritten
 * index, scan for new messages" pattern.
 *
 * Only forwards completed visible text (assistant text and local command output).
 * If no chat is active (because the user typed in the terminal), nothing is
 * forwarded.
 */

import { useEffect, useRef } from 'react'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../constants/xml.js'
import { getClient } from '../services/whatsapp/client.js'
import { isOn } from '../services/whatsapp/lifecycle.js'
import {
  clearActiveChat,
  getActiveChatJid,
} from '../services/whatsapp/router.js'
import type { Message } from '../types/message.js'

const MAX_WHATSAPP_TEXT_LENGTH = 3500

function extractTextContent(content: unknown): string | null {
  if (!content) return null
  if (typeof content === 'string') return content.trim() || null

  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: string }).text
      if (text) parts.push(text)
    }
  }
  const joined = parts.join('\n').trim()
  return joined.length > 0 ? joined : null
}

function extractTagContent(content: string, tagName: string): string | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`).exec(
    content,
  )
  return match?.[1]?.trim() || null
}

function extractLocalCommandOutput(content: string): string | null {
  return (
    extractTagContent(content, LOCAL_COMMAND_STDOUT_TAG) ??
    extractTagContent(content, LOCAL_COMMAND_STDERR_TAG)
  )
}

function extractMirrorText(msg: Message): string | null {
  if (msg.type === 'assistant') {
    return extractTextContent(msg.message?.content)
  }

  if (msg.type === 'system' && msg.subtype === 'local_command') {
    return extractLocalCommandOutput(msg.content)
  }

  if (msg.type === 'user') {
    const content = extractTextContent(msg.message?.content)
    return content ? extractLocalCommandOutput(content) : null
  }

  return null
}

function splitForWhatsApp(text: string): string[] {
  if (text.length <= MAX_WHATSAPP_TEXT_LENGTH) return [text]

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > MAX_WHATSAPP_TEXT_LENGTH) {
    let splitAt = remaining.lastIndexOf('\n\n', MAX_WHATSAPP_TEXT_LENGTH)
    if (splitAt < MAX_WHATSAPP_TEXT_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf('\n', MAX_WHATSAPP_TEXT_LENGTH)
    }
    if (splitAt < MAX_WHATSAPP_TEXT_LENGTH * 0.5) {
      splitAt = MAX_WHATSAPP_TEXT_LENGTH
    }
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export function useWhatsAppMirror(
  messages: readonly Message[],
  isLoading: boolean,
): void {
  const lastWrittenRef = useRef(0)

  useEffect(() => {
    if (!isOn()) {
      lastWrittenRef.current = messages.length
      return
    }
    const jid = getActiveChatJid()
    if (!jid) {
      lastWrittenRef.current = messages.length
      return
    }
    if (lastWrittenRef.current > messages.length) {
      lastWrittenRef.current = messages.length
    }
    if (isLoading) return

    const startIdx = lastWrittenRef.current
    const newTexts: string[] = []
    for (let i = startIdx; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue
      const text = extractMirrorText(msg)
      if (text) newTexts.push(text)
    }
    lastWrittenRef.current = messages.length
    const replyText = newTexts.join('\n\n').trim()
    if (!replyText) {
      clearActiveChat()
      return
    }

    const client = getClient()
    if (!client.isConnected()) {
      clearActiveChat()
      return
    }

    void (async () => {
      for (const t of splitForWhatsApp(replyText)) {
        try {
          await client.sendText(jid, t)
        } catch {
          /* ignore — connection might be churning */
        }
      }
      clearActiveChat()
    })()
  }, [messages, isLoading])
}
