import type { Command } from '../../commands.js'
import {
  getPendingFallback,
  hasConfiguredFallbackTargets,
} from '../../utils/fallback/state.js'

export default {
  type: 'local-jsx',
  name: 'fallback',
  get description() {
    if (getPendingFallback()) {
      return 'Approve or cancel fallback continuation'
    }
    return hasConfiguredFallbackTargets()
      ? 'Show or change the fallback model chain'
      : 'Configure three priority fallback models'
  },
  argumentHint: '[yes|no|status|config|reset|help]',
  load: () => import('./fallback.js'),
} satisfies Command
