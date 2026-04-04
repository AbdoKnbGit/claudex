import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getAPIProvider, PROVIDER_DISPLAY_NAMES } from '../../utils/model/providers.js'

export default {
  type: 'local-jsx',
  name: 'logout',
  get description() {
    const provider = getAPIProvider()
    return `Sign out from ${PROVIDER_DISPLAY_NAMES[provider]}`
  },
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGOUT_COMMAND),
  load: () => import('./logout.js'),
} satisfies Command
