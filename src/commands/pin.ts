import type { Command, LocalCommandCall } from '../types/command.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

type PinSetting = { text: string; enabled: boolean }

const USAGE = [
  'Usage:',
  '  /pin                — show current pin',
  '  /pin set <text>     — set pinned text (replaces current)',
  '  /pin add <text>     — append another line to the pin',
  '  /pin on             — enable injection',
  '  /pin off            — disable injection',
  '  /pin clear          — clear pinned text and disable',
].join('\n')

function getPin(): PinSetting {
  const raw = getInitialSettings().pin
  return {
    text: raw?.text ?? '',
    enabled: raw?.enabled ?? false,
  }
}

function writePin(next: PinSetting): { error: Error | null } {
  const result = updateSettingsForSource('userSettings', { pin: next })
  if (!result.error) settingsChangeDetector.notifyChange('userSettings')
  return result
}

function formatState(p: PinSetting): string {
  const status = p.enabled ? 'on' : 'off'
  if (!p.text) {
    return `Pin: ${status} (no text set)\n${USAGE}`
  }
  return `Pin: ${status}\n---\n${p.text}\n---`
}

const call: LocalCommandCall = async args => {
  const trimmed = args.trim()
  const current = getPin()

  if (!trimmed) {
    return { type: 'text', value: formatState(current) }
  }

  // Split on the first whitespace so subcommand value can contain spaces.
  const firstSpace = trimmed.search(/\s/)
  const sub =
    firstSpace === -1
      ? trimmed.toLowerCase()
      : trimmed.slice(0, firstSpace).toLowerCase()
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim()

  switch (sub) {
    case 'on': {
      if (!current.text) {
        return {
          type: 'text',
          value: 'Cannot enable pin: no text set. Use "/pin set <text>" first.',
        }
      }
      const result = writePin({ ...current, enabled: true })
      if (result.error) {
        return { type: 'text', value: 'Failed to update settings.' }
      }
      return { type: 'text', value: 'Pin enabled.' }
    }
    case 'off': {
      const result = writePin({ ...current, enabled: false })
      if (result.error) {
        return { type: 'text', value: 'Failed to update settings.' }
      }
      return { type: 'text', value: 'Pin disabled.' }
    }
    case 'clear': {
      const result = writePin({ text: '', enabled: false })
      if (result.error) {
        return { type: 'text', value: 'Failed to update settings.' }
      }
      return { type: 'text', value: 'Pin cleared.' }
    }
    case 'set': {
      if (!rest) {
        return { type: 'text', value: 'Usage: /pin set <text>' }
      }
      const result = writePin({ text: rest, enabled: current.enabled })
      if (result.error) {
        return { type: 'text', value: 'Failed to update settings.' }
      }
      const status = current.enabled ? 'on' : 'off (use "/pin on" to enable)'
      return { type: 'text', value: `Pin set. Status: ${status}.` }
    }
    case 'add': {
      if (!rest) {
        return { type: 'text', value: 'Usage: /pin add <text>' }
      }
      const next = current.text ? `${current.text}\n${rest}` : rest
      const result = writePin({ text: next, enabled: current.enabled })
      if (result.error) {
        return { type: 'text', value: 'Failed to update settings.' }
      }
      const status = current.enabled ? 'on' : 'off (use "/pin on" to enable)'
      return { type: 'text', value: `Pin updated. Status: ${status}.` }
    }
    default:
      return {
        type: 'text',
        value: `Unknown subcommand: ${sub}\n${USAGE}`,
      }
  }
}

const pin = {
  type: 'local',
  name: 'pin',
  description:
    'Pin a constraint sentence that gets appended to every user message',
  argumentHint: '[set|add|on|off|clear] [text]',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default pin
