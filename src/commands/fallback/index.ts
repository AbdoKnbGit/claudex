import type { Command } from '../../commands.js'
import {
  hasConfiguredFallbackTargets,
  isFallbackEnabled,
} from '../../utils/fallback/state.js'

export default {
  type: 'local-jsx',
  name: 'fallback',
  get description() {
    if (!hasConfiguredFallbackTargets()) {
      return 'Configure three priority fallback models'
    }
    return isFallbackEnabled()
      ? 'Automatic fallback is on'
      : 'Automatic fallback is off'
  },
  argumentHint: '[on|off|status|config|reset|help]',
  load: () => import('./fallback.js'),
} satisfies Command
