import type { Command } from '../../commands.js'
import { getAPIProvider, PROVIDER_DISPLAY_NAMES } from '../../utils/model/providers.js'
import { NIM_MODEL_COUNT } from '../../utils/model/nim_catalog.js'

export default {
  type: 'local-jsx',
  name: 'models',
  get description() {
    const current = getAPIProvider()
    return `Browse ${NIM_MODEL_COUNT} NIM models with search (provider: ${PROVIDER_DISPLAY_NAMES[current]})`
  },
  isEnabled: () => true,
  argumentHint: '[search query]',
  load: () => import('./models.js'),
} satisfies Command
