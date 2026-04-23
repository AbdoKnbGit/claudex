import { getCursorModelDisplayName } from '../../lanes/cursor/catalog.js'
import type { APIProvider } from './providers.js'

export function getProviderModelDisplayName(
  provider: APIProvider,
  modelId: string,
): string | null {
  switch (provider) {
    case 'cursor':
      return getCursorModelDisplayName(modelId)
    default:
      return null
  }
}
