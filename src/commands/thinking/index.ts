import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'thinking',
  description: 'Toggle thinking mode for supported models',
  // Hidden from the slash-menu — thinking is opt-in and off by default.
  // `/thinking on` / `/thinking off` still work for users who know about it.
  isHidden: true,
  argumentHint: '[on|off]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./thinking.js'),
} satisfies Command
