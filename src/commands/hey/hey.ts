import { logEvent } from '../../services/analytics/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { isHeyModeFeatureOn } from '../../voice/heyModeEnabled.js'
import { HEY_TTS_ENV, isHeyTtsEnabled } from '../../voice/heyTtsEnabled.js'

export const call: LocalCommandCall = async () => {
  if (!isHeyModeFeatureOn()) {
    return {
      type: 'text' as const,
      value: 'Hey mode is not available in this build.',
    }
  }

  const currentSettings = getInitialSettings()
  const isCurrentlyEnabled = currentSettings.heyEnabled === true

  // Toggle OFF — no preflight needed.
  if (isCurrentlyEnabled) {
    const result = updateSettingsForSource('userSettings', {
      heyEnabled: false,
    })
    if (result.error) {
      return {
        type: 'text' as const,
        value:
          'Failed to update settings. Check your settings file for syntax errors.',
      }
    }
    settingsChangeDetector.notifyChange('userSettings')
    logEvent('tengu_hey_toggled', { enabled: false })
    return {
      type: 'text' as const,
      value: 'Hey mode disabled.',
    }
  }

  // Toggle ON: verify mic and whisper.cpp before saving so the user gets a
  // clear error up front rather than mid-conversation.
  const { checkRecordingAvailability, checkVoiceDependencies } = await import(
    '../../services/voice.js'
  )
  const recording = await checkRecordingAvailability()
  if (!recording.available) {
    return {
      type: 'text' as const,
      value:
        recording.reason ?? 'Audio recording is not available in this environment.',
    }
  }
  const deps = await checkVoiceDependencies()
  if (!deps.available) {
    const hint = deps.installCommand
      ? `\nInstall audio recording tools: ${deps.installCommand}`
      : '\nInstall SoX manually for audio recording (or use the native audio backend).'
    return {
      type: 'text' as const,
      value: `No audio recording tool found.${hint}`,
    }
  }

  const { checkWhisperAvailable } = await import(
    '../../services/whisperLocal.js'
  )
  const whisper = checkWhisperAvailable()
  if (!whisper.available) {
    return {
      type: 'text' as const,
      value: `Hey mode needs whisper.cpp for local speech-to-text.\n\n${whisper.reason ?? ''}`,
    }
  }

  const ttsEnabled = isHeyTtsEnabled()
  const tts = ttsEnabled
    ? (await import('../../services/ttsLocal.js')).checkTtsAvailable()
    : { available: false, reason: null }
  // Voice replies are opt-in because the OS TTS backend can be unstable on
  // some Windows terminals. Text replies remain the default.
  const ttsNote = ttsEnabled
    ? tts.available
      ? '\nVoice replies are enabled.'
      : `\nVoice replies requested, but TTS is unavailable (${tts.reason ?? 'unknown'}). Replies will be text-only.`
    : `\nReplies are text-only by default. Set ${HEY_TTS_ENV}=1 to enable local voice replies.`

  const result = updateSettingsForSource('userSettings', { heyEnabled: true })
  if (result.error) {
    return {
      type: 'text' as const,
      value:
        'Failed to update settings. Check your settings file for syntax errors.',
    }
  }
  settingsChangeDetector.notifyChange('userSettings')
  logEvent('tengu_hey_toggled', {
    enabled: true,
    ttsAvailable: ttsEnabled && tts.available,
  })

  return {
    type: 'text' as const,
    value: `Hey mode enabled. Hold V to talk; release to send. Tau will show "Heard: ..." before sending.${ttsNote}`,
  }
}
