/**
 * Moonshot AI / Kimi provider.
 *
 * Moonshot's public API speaks the OpenAI Chat Completions shape at
 * https://api.moonshot.ai/v1 with bearer-token authentication.
 */

import { OpenAIProvider } from './openai_provider.js'
import type { ModelInfo, ProviderConfig } from './base_provider.js'
import {
  MOONSHOT_MODELS,
  cloneMoonshotModelInfo,
  isMoonshotChatModelId,
  normalizeMoonshotModelId,
  toMoonshotModelInfo,
} from '../../../utils/model/moonshotCatalog.js'

export class MoonshotProvider extends OpenAIProvider {
  readonly name = 'moonshot'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.moonshot.ai/v1',
      extraHeaders: config.extraHeaders,
    })
    this.optimizePayload = false
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) {
        const data = (await response.json()) as { data?: Array<{ id?: string; name?: string }> }
        const apiModels = (data.data ?? [])
          .flatMap(model => {
            if (typeof model.id !== 'string' || !isMoonshotChatModelId(model.id)) {
              return []
            }
            return [toMoonshotModelInfo({ id: model.id, name: model.name })]
          })
        if (apiModels.length > 0) return apiModels
      }
    } catch {
      // API unreachable or token cannot list models; use curated fallback.
    }

    return MOONSHOT_MODELS.map(cloneMoonshotModelInfo)
  }

  resolveModel(claudeModel: string): string {
    return normalizeMoonshotModelId(super.resolveModel(claudeModel))
  }
}
