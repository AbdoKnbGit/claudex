// Hold-to-talk conversational voice mode (the /hey flow).
//
// On hold V → record audio via the existing voice service. On release →
// run whisper.cpp on the buffer, call onSubmit(transcript) so REPL routes
// it through the normal user-message pipeline. The TTS reply is wired
// up separately in useHeyResponseSpeaker — this hook only owns capture
// and dispatch.
//
// Compared to useVoice (the existing /voice flow): no streaming STT, no
// interim-transcript injection, no input-box anchor. One-shot per
// recording. Much simpler.

import { useCallback, useEffect, useRef, useState } from 'react'
import { logEvent } from '../services/analytics/index.js'
import { logForDebugging } from '../utils/debug.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'

export type HeyState = 'idle' | 'recording' | 'transcribing'

type UseHeyArgs = {
  enabled: boolean
  onSubmit: (text: string) => void
  onTranscript?: (text: string) => void
  onError?: (message: string) => void
}

type UseHeyReturn = {
  state: HeyState
  handleKeyEvent: (fallbackMs?: number) => void
}

// Match the voice key release semantics: a >200ms gap between auto-repeat
// events counts as the user releasing the key. Auto-repeat fires every
// 30-80ms, so 200ms covers jitter without being so long that release
// detection feels laggy.
const RELEASE_TIMEOUT_MS = 200

// Used when we haven't yet seen auto-repeat (single press / first event).
// Covers the OS initial-repeat delay (~500ms on macOS default) plus
// headroom — if the user tapped and released, we still need to fire
// release detection eventually.
const REPEAT_FALLBACK_MS = 600

// Below this many bytes of PCM (16 kHz × 16-bit × 1 ch = 32 kB/sec), we
// treat the recording as an accidental tap and silently drop it instead
// of running whisper on noise. ~50ms of audio.
const MIN_PCM_BYTES = 1600

// Lazy-loaded modules. Voice (audio capture) is heavy on first import
// because of the native module dlopen — defer it to first activation.
// Whisper module is light, but keep the lazy import for symmetry.
type VoiceModule = typeof import('../services/voice.js')
type WhisperModule = typeof import('../services/whisperLocal.js')
let voiceModule: VoiceModule | null = null
let whisperModule: WhisperModule | null = null

async function loadVoiceModule(): Promise<VoiceModule> {
  if (voiceModule) return voiceModule
  voiceModule = await import('../services/voice.js')
  return voiceModule
}
async function loadWhisperModule(): Promise<WhisperModule> {
  if (whisperModule) return whisperModule
  whisperModule = await import('../services/whisperLocal.js')
  return whisperModule
}

export function useHey({
  enabled,
  onSubmit,
  onTranscript,
  onError,
}: UseHeyArgs): UseHeyReturn {
  const [state, setState] = useState<HeyState>('idle')
  const stateRef = useRef<HeyState>('idle')
  const audioChunksRef = useRef<Buffer[]>([])
  const recordingStartRef = useRef(0)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const seenRepeatRef = useRef(false)
  // Latest callbacks via refs so handleKeyEvent doesn't churn deps and
  // recreate timers on every render.
  const onSubmitRef = useRef(onSubmit)
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  onSubmitRef.current = onSubmit
  onTranscriptRef.current = onTranscript
  onErrorRef.current = onError

  function updateState(next: HeyState): void {
    stateRef.current = next
    setState(next)
  }

  // Pre-load voice module when hey-mode is enabled so the first hold has
  // no first-press dlopen cost. Same pattern as useVoice.
  useEffect(() => {
    if (enabled) {
      void loadVoiceModule().catch(err => logError(toError(err)))
    }
  }, [enabled])

  const cleanup = useCallback((): void => {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    if (repeatFallbackTimerRef.current) {
      clearTimeout(repeatFallbackTimerRef.current)
      repeatFallbackTimerRef.current = null
    }
    audioChunksRef.current = []
    seenRepeatRef.current = false
    voiceModule?.stopRecording()
  }, [])

  // Stop and tear down any in-flight session whenever hey-mode toggles
  // off (or unmount). Without this, a stale recording keeps the mic
  // open and the next /hey enable will see weird state.
  useEffect(() => {
    if (!enabled && stateRef.current !== 'idle') {
      cleanup()
      updateState('idle')
    }
    return () => {
      cleanup()
    }
  }, [enabled, cleanup])

  async function startRecording(): Promise<void> {
    const voice = await loadVoiceModule()
    const availability = await voice.checkRecordingAvailability()
    if (!availability.available) {
      onErrorRef.current?.(
        availability.reason ?? 'Audio recording is not available.',
      )
      cleanup()
      updateState('idle')
      return
    }

    audioChunksRef.current = []
    recordingStartRef.current = Date.now()
    updateState('recording')

    const started = await voice.startRecording(
      (chunk: Buffer) => {
        // Defensive copy: cpal hands us a slice into a shared backing buffer
        // that's reused on subsequent reads. Without the copy the earlier
        // chunks get clobbered before whisper sees them.
        audioChunksRef.current.push(Buffer.from(chunk))
      },
      () => {
        // Device error / external stop. Treat as user-released so we still
        // try to transcribe whatever was captured.
        if (stateRef.current === 'recording') {
          void finishRecording()
        }
      },
      { silenceDetection: false },
    )
    if (!started) {
      onErrorRef.current?.(
        'Failed to start audio capture. Check that your microphone is accessible.',
      )
      cleanup()
      updateState('idle')
    }
  }

  async function finishRecording(): Promise<void> {
    if (stateRef.current !== 'recording') return
    updateState('transcribing')
    const voice = voiceModule
    voice?.stopRecording()
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    if (repeatFallbackTimerRef.current) {
      clearTimeout(repeatFallbackTimerRef.current)
      repeatFallbackTimerRef.current = null
    }
    seenRepeatRef.current = false

    const pcm = Buffer.concat(audioChunksRef.current)
    audioChunksRef.current = []
    const recordingDurationMs = Date.now() - recordingStartRef.current

    if (pcm.length < MIN_PCM_BYTES) {
      logForDebugging(
        `[hey] recording too short (${pcm.length}B, ${recordingDurationMs}ms) — ignoring`,
      )
      updateState('idle')
      return
    }

    try {
      const whisper = await loadWhisperModule()
      const text = await whisper.transcribePcm(pcm)
      logEvent('tengu_hey_transcribed', {
        recordingDurationMs,
        transcriptChars: text.length,
        pcmBytes: pcm.length,
      })
      if (text) {
        onTranscriptRef.current?.(text)
        onSubmitRef.current(text)
      } else {
        onErrorRef.current?.(
          'No speech detected. Try speaking closer to the mic.',
        )
      }
    } catch (err) {
      const error = toError(err)
      logError(error)
      onErrorRef.current?.(`Transcription failed: ${error.message}`)
    } finally {
      updateState('idle')
    }
  }

  function armReleaseTimer(): void {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
    }
    releaseTimerRef.current = setTimeout(() => {
      releaseTimerRef.current = null
      if (stateRef.current === 'recording') {
        void finishRecording()
      }
    }, RELEASE_TIMEOUT_MS)
  }

  const handleKeyEvent = useCallback(
    (fallbackMs: number = REPEAT_FALLBACK_MS): void => {
      if (!enabled) return
      // Drop key events during transcription — the user has already
      // released; new presses should wait until idle to start the next turn.
      if (stateRef.current === 'transcribing') return

      if (stateRef.current === 'idle') {
        void startRecording()
        // Fallback: if no auto-repeat arrives within fallbackMs, arm the
        // release timer anyway. Covers tap-and-release where the user lets
        // go before the OS initial-repeat delay elapses.
        repeatFallbackTimerRef.current = setTimeout(() => {
          repeatFallbackTimerRef.current = null
          if (stateRef.current === 'recording' && !seenRepeatRef.current) {
            seenRepeatRef.current = true
            armReleaseTimer()
          }
        }, fallbackMs)
        return
      }

      // recording: another keypress means auto-repeat is firing — the user
      // is still holding. Note we saw a repeat (so the release timer is
      // safe to arm) and reset the release timer.
      seenRepeatRef.current = true
      if (repeatFallbackTimerRef.current) {
        clearTimeout(repeatFallbackTimerRef.current)
        repeatFallbackTimerRef.current = null
      }
      armReleaseTimer()
    },
    [enabled],
  )

  return { state, handleKeyEvent }
}
