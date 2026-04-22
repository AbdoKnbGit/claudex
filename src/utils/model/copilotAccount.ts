import { getStoredCopilotPlanInfo } from '../../services/api/auth/oauth_services.js'

export interface CopilotErrorPayload {
  message?: string
  code?: string
  param?: string
  type?: string
}

const COPILOT_FREE_SKUS = new Set([
  'free_limited_copilot',
])

// Keep this aligned with the curated Copilot catalog in the compat lane.
// These are the entries from that catalog that GitHub currently marks as
// available on Copilot Free.
const COPILOT_FREE_ALLOWED_MODELS = new Set([
  'claude-haiku-4.5',
  'gpt-4.1',
  'gpt-5-mini',
])

export function isCopilotFreePlan(): boolean {
  const sku = getStoredCopilotPlanInfo()?.sku?.toLowerCase()
  if (!sku) return false
  return COPILOT_FREE_SKUS.has(sku) || sku.includes('free')
}

export function isCopilotModelAllowedForCurrentPlan(model: string): boolean {
  if (!isCopilotFreePlan()) return true
  return COPILOT_FREE_ALLOWED_MODELS.has(model.trim().toLowerCase())
}

export function getCopilotSuggestedModelsForCurrentPlan(): string[] {
  if (isCopilotFreePlan()) {
    return ['gpt-5-mini', 'gpt-4.1', 'claude-haiku-4.5']
  }
  return ['gpt-5-mini', 'gpt-4.1']
}

export function formatCopilotModelUnsupportedMessage(model: string): string {
  const planLabel = isCopilotFreePlan()
    ? 'your GitHub Copilot Free account'
    : 'your GitHub Copilot account'
  const suggestions = getCopilotSuggestedModelsForCurrentPlan()
    .map(id => `'${id}'`)
    .join(', ')

  return (
    `Model '${model}' is not available on ${planLabel}. ` +
    `Try ${suggestions} instead.`
  )
}

export function formatCopilotQuotaExceededMessage(): string {
  const suggestions = getCopilotSuggestedModelsForCurrentPlan()
    .map(id => `'${id}'`)
    .join(', ')

  return (
    'GitHub Copilot rejected this request because the current account has no ' +
    `quota left for this model. Try ${suggestions} or check GitHub Copilot usage/billing.`
  )
}

export function parseCopilotErrorPayload(raw: unknown): CopilotErrorPayload | null {
  if (!raw) return null

  if (typeof raw === 'string') {
    try {
      return parseCopilotErrorPayload(JSON.parse(raw))
    } catch {
      const lowered = raw.toLowerCase()
      if (
        lowered.includes('model_not_supported')
        || lowered.includes('requested model is not supported')
      ) {
        return { code: 'model_not_supported', message: raw }
      }
      if (lowered.includes('quota_exceeded') || lowered.includes('you have no quota')) {
        return { code: 'quota_exceeded', message: raw }
      }
      return null
    }
  }

  if (typeof raw !== 'object') return null

  const record = raw as Record<string, unknown>
  const nested = (
    record.error && typeof record.error === 'object'
      ? record.error as Record<string, unknown>
      : record
  )

  return {
    message: typeof nested.message === 'string' ? nested.message : undefined,
    code: typeof nested.code === 'string' ? nested.code : undefined,
    param: typeof nested.param === 'string' ? nested.param : undefined,
    type: typeof nested.type === 'string' ? nested.type : undefined,
  }
}

export function isCopilotModelUnsupportedError(raw: unknown): boolean {
  const parsed = parseCopilotErrorPayload(raw)
  if (!parsed) return false
  return (
    parsed.code === 'model_not_supported'
    || /requested model is not supported/i.test(parsed.message ?? '')
  )
}

export function isCopilotQuotaExceededError(raw: unknown): boolean {
  const parsed = parseCopilotErrorPayload(raw)
  if (!parsed) return false
  return (
    parsed.code === 'quota_exceeded'
    || /you have no quota/i.test(parsed.message ?? '')
  )
}
