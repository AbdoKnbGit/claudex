import type { Command } from '../../commands.js'
import { isHeyModeFeatureOn } from '../../voice/heyModeEnabled.js'

const hey = {
  type: 'local',
  name: 'hey',
  description:
    'Toggle hey mode (hold V to speak, releases auto-submit, replies spoken aloud)',
  isEnabled: () => isHeyModeFeatureOn(),
  isHidden: false,
  supportsNonInteractive: false,
  load: () => import('./hey.js'),
} satisfies Command

export default hey
