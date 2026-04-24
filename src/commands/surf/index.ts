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
  // Hidden from the slash-menu — /surf is opt-in and off by default.
  // `/surf on` etc. still work for users who want the phase router.
  isHidden: true,
  argumentHint: '[on|off|status|config|reset|help]',
  load: () => import('./surf.js'),
} satisfies Command
