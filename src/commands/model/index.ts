import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getMainLoopModel, renderModelName } from '../../utils/model/model.js'
import { isSurfEnabled } from '../../utils/surf/state.js'

export default {
  type: 'local-jsx',
  name: 'model',
  // Hidden from the slash-menu — /models is the user-facing command.
  // /model stays wired up so existing "/model <name>" invocations still work.
  isHidden: true,
  get description() {
    if (isSurfEnabled()) {
      return 'Disabled while /surf is on — router picks the model per phase'
    }
    return `Set the AI model for Claudex (currently ${renderModelName(getMainLoopModel())})`
  },
  argumentHint: '[model]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./model.js'),
} satisfies Command
