// Speaks completed assistant text aloud while hey-mode is enabled.
//
// We watch isLoading transition from true → false (turn finished) and grab
// the latest assistant message at that moment. Text blocks are
// concatenated, tool-use blocks are silently dropped (announcing every
// tool name out loud is noisy and doesn't help conversation flow), and
// the result is sent to ttsLocal.speak. Subsequent identical messages are
// skipped via uuid tracking — without this, edits/retries that re-fire
// turn-complete would re-speak the same response.
//
// Toggle off mid-speech is honored: stopSpeaking() interrupts the active
// TTS process so disabling /hey does not leave Tau speaking.

import { useEffect, useRef } from 'react'
import { logForDebugging } from '../utils/debug.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { getLastAssistantMessage } from '../utils/messages.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { isHeyTtsEnabled } from '../voice/heyTtsEnabled.js'

type TtsModule = typeof import('../services/ttsLocal.js')
let ttsModule: TtsModule | null = null
async function loadTts(): Promise<TtsModule> {
  if (ttsModule) return ttsModule
  ttsModule = await import('../services/ttsLocal.js')
  return ttsModule
}

// Strip markdown so we don't read out asterisks, backticks, hash signs,
// and link URLs literally. Conservative: strips emphasis markers,
// headings, fenced/inline code, list bullets, and link syntax. Keeps
// the link text. Block-level newlines collapse to spaces so the prosody
// flows naturally instead of pausing on each markdown break.
export function plainifyForSpeech(markdown: string): string {
  let text = markdown
  // Fenced code blocks — replace with a short verbal placeholder so the
  // listener knows code was elided rather than just silenced.
  text = text.replace(/```[\s\S]*?```/g, ' (code block) ')
  // Inline code
  text = text.replace(/`([^`]+)`/g, '$1')
  // Images (![alt](url)) → alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Links ([text](url)) → text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Headings, blockquotes, list bullets at start of line
  text = text.replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
  text = text.replace(/^[ \t]*>[ \t]?/gm, '')
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  text = text.replace(/^[ \t]*\d+\.[ \t]+/gm, '')
  // Bold / italic / strikethrough markers
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')
  text = text.replace(/(\*|_)(.*?)\1/g, '$2')
  text = text.replace(/~~(.*?)~~/g, '$1')
  // Horizontal rules
  text = text.replace(/^[ \t]*-{3,}[ \t]*$/gm, '')
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()
  return text
}

function extractAssistantText(msg: AssistantMessage): string {
  const content = msg.message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block) {
      // Only read out plain text blocks. Tool calls, tool results,
      // thinking blocks etc. are noise when spoken aloud.
      if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        parts.push((block as { text: string }).text)
      }
    }
  }
  return parts.join('\n').trim()
}

type UseHeyResponseSpeakerArgs = {
  enabled: boolean
  messages: Message[]
  isLoading: boolean
}

export function useHeyResponseSpeaker({
  enabled,
  messages,
  isLoading,
}: UseHeyResponseSpeakerArgs): void {
  // Track which assistant message id we've already spoken so we don't
  // re-speak on every re-render or when downstream effects mutate the
  // messages array (compaction, edits) without producing a new turn.
  const lastSpokenIdRef = useRef<string | null>(null)
  const wasLoadingRef = useRef(isLoading)

  useEffect(() => {
    if (!enabled) {
      // If hey was just toggled off and TTS is mid-sentence, kill it so
      // Tau does not keep speaking after the user disabled the feature.
      void loadTts()
        .then(mod => mod.stopSpeaking())
        .catch(err => logError(toError(err)))
    }
  }, [enabled])

  useEffect(() => {
    try {
      const wasLoading = wasLoadingRef.current
      wasLoadingRef.current = isLoading
      if (!enabled || !isHeyTtsEnabled()) return
      // Only fire on the loading-to-idle edge. Without this guard a fresh
      // render mid-stream would speak partial output, then re-speak the
      // full output on completion.
      if (!(wasLoading && !isLoading)) return

      const last = getLastAssistantMessage(messages)
      if (!last) return
      const id = last.uuid
      if (id === lastSpokenIdRef.current) return

      const raw = extractAssistantText(last)
      if (!raw) return
      const speakable = plainifyForSpeech(raw)
      if (!speakable) return

      lastSpokenIdRef.current = id
      logForDebugging(
        `[hey] speaking assistant message ${id} (${speakable.length} chars)`,
      )
      void loadTts()
        .then(mod => mod.speak(speakable))
        .catch(err => logError(toError(err)))
    } catch (err) {
      logError(toError(err))
    }
  }, [enabled, isLoading, messages])
}
