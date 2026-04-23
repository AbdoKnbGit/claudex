import {
  getDefaultMainLoopModelSetting,
  modelDisplayString,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { getAPIProvider, type APIProvider } from './providers.js'
import { getProviderModelDisplayName } from './providerDisplayNames.js'

export { getProviderModelDisplayName } from './providerDisplayNames.js'

export function renderModelLabelForProvider(
  model: string | null,
  provider: APIProvider = getAPIProvider(),
): string {
  if (model !== null) {
    const providerDisplay = getProviderModelDisplayName(provider, model)
    if (providerDisplay) {
      return providerDisplay
    }
  }

  const rendered = renderDefaultModelSetting(
    model ?? getDefaultMainLoopModelSetting(),
  )
  return model === null ? `${rendered} (default)` : rendered
}

export function modelDisplayStringForProvider(
  model: ModelSetting,
  provider: APIProvider = getAPIProvider(),
): string {
  if (model !== null) {
    const providerDisplay = getProviderModelDisplayName(provider, model)
    if (providerDisplay) {
      return providerDisplay
    }
  }

  return modelDisplayString(model)
}
