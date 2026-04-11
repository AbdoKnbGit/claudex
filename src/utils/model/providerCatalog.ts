import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import { resolveProviderAuth } from '../../services/api/auth/provider_auth.js'
import { getProvider } from '../../services/api/providers/providerShim.js'
import { validateProviderAuth } from '../auth.js'
import {
  SELECTABLE_PROVIDERS,
  type APIProvider,
  PROVIDER_DISPLAY_NAMES,
} from './providers.js'

export type BrowsableModelProvider = Exclude<APIProvider, 'firstParty'>

export const BROWSABLE_MODEL_PROVIDERS: readonly BrowsableModelProvider[] =
  SELECTABLE_PROVIDERS.filter(
    (provider): provider is BrowsableModelProvider =>
      provider !== 'firstParty',
  )

export function getDefaultBrowsableProvider(
  preferredProvider: APIProvider,
): BrowsableModelProvider {
  if (
    preferredProvider !== 'firstParty' &&
    BROWSABLE_MODEL_PROVIDERS.includes(preferredProvider)
  ) {
    return preferredProvider
  }

  return (
    BROWSABLE_MODEL_PROVIDERS.find(provider =>
      validateProviderAuth(provider).valid,
    ) ?? 'openai'
  )
}

export function parseProviderModelQuery(
  rawArgs: string,
  fallbackProvider: BrowsableModelProvider,
): { provider: BrowsableModelProvider; query: string } {
  const args = rawArgs.trim()
  if (!args) {
    return { provider: fallbackProvider, query: '' }
  }

  const colonIndex = args.indexOf(':')
  if (colonIndex > 0) {
    const providerCandidate = args
      .slice(0, colonIndex)
      .trim()
      .toLowerCase() as BrowsableModelProvider
    if (BROWSABLE_MODEL_PROVIDERS.includes(providerCandidate)) {
      return {
        provider: providerCandidate,
        query: args.slice(colonIndex + 1).trim(),
      }
    }
  }

  const [firstToken, ...rest] = args.split(/\s+/)
  const providerCandidate = firstToken?.toLowerCase() as
    | BrowsableModelProvider
    | undefined
  if (providerCandidate && BROWSABLE_MODEL_PROVIDERS.includes(providerCandidate)) {
    return {
      provider: providerCandidate,
      query: rest.join(' ').trim(),
    }
  }

  return { provider: fallbackProvider, query: args }
}

export async function loadProviderModels(
  provider: BrowsableModelProvider,
): Promise<ModelInfo[]> {
  await resolveProviderAuth(provider)

  const models = await getProvider(provider).listModels()
  return sortProviderModels(models)
}

export function filterProviderModels(
  models: readonly ModelInfo[],
  query: string,
): ModelInfo[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return [...models]
  }

  return models.filter(model => {
    const haystack = `${model.id} ${model.name ?? ''}`.toLowerCase()
    return haystack.includes(normalized)
  })
}

export function getProviderBrowseLabel(provider: BrowsableModelProvider): string {
  return PROVIDER_DISPLAY_NAMES[provider]
}

function sortProviderModels(models: readonly ModelInfo[]): ModelInfo[] {
  return [...models].sort((left, right) => {
    const leftName = (left.name || left.id).toLowerCase()
    const rightName = (right.name || right.id).toLowerCase()

    if (leftName !== rightName) {
      return leftName.localeCompare(rightName)
    }

    return left.id.localeCompare(right.id)
  })
}
