import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getAPIProvider, PROVIDER_DISPLAY_NAMES } from '../../utils/model/providers.js'
import { isThirdPartyProvider } from '../../utils/model/providers.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    get description() {
      const provider = getAPIProvider()
      if (isThirdPartyProvider(provider)) {
        return `Sign in with ${PROVIDER_DISPLAY_NAMES[provider]}`
      }
      return 'Sign in with a provider'
    },
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command
