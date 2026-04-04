import type { Command } from '../../commands.js'
import { getAPIProvider, PROVIDER_DISPLAY_NAMES } from '../../utils/model/providers.js'

export default {
  type: 'local-jsx',
  name: 'provider',
  get description() {
    const current = getAPIProvider()
    return `Switch AI provider (currently ${PROVIDER_DISPLAY_NAMES[current]})`
  },
  isEnabled: () => true,
  load: () => import('./provider.js'),
} satisfies Command
