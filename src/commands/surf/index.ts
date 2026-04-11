import type { Command } from '../../commands.js'
import { isSurfEnabled } from '../../utils/surf/state.js'

export default {
  type: 'local-jsx',
  name: 'surf',
  get description() {
    return isSurfEnabled()
      ? 'Smart phase router — on (toggle, status, config)'
      : 'Smart phase router — auto-switch models per phase'
  },
  isEnabled: () => true,
  argumentHint: '[on|off|status|config|reset|help]',
  load: () => import('./surf.js'),
} satisfies Command
