import chalk from 'chalk'
import * as React from 'react'
import { ProviderModelPicker } from '../../components/ProviderModelPicker.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  getAPIProvider,
  PROVIDER_DISPLAY_NAMES,
  setActiveProvider,
} from '../../utils/model/providers.js'
import {
  BROWSABLE_MODEL_PROVIDERS,
  filterProviderModels,
  getDefaultBrowsableProvider,
  getProviderBrowseLabel,
  loadProviderModels,
  parseProviderModelQuery,
  resolveProviderModelSelection,
  type BrowsableModelProvider,
} from '../../utils/model/providerCatalog.js'
import { getProviderModelDisplayName } from '../../utils/model/display.js'

function renderSearchBadges(tags?: readonly string[]): string {
  if (!tags || tags.length === 0) {
    return ''
  }

  const badges: string[] = []
  if (tags.includes('recommended')) {
    badges.push(chalk.green('[RECOMMENDED]'))
  }
  if (tags.includes('free')) {
    badges.push(chalk.green('[FREE]'))
  }

  return badges.length > 0 ? ` ${badges.join(' ')}` : ''
}

function ModelsPickerWrapper({
  onDone,
  lockedProvider,
}: {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  lockedProvider?: BrowsableModelProvider
}) {
  const setAppState = useSetAppState()
  const currentProvider = getAPIProvider()
  const initialProvider = lockedProvider ?? getDefaultBrowsableProvider(currentProvider)

  function handleSelect(provider: BrowsableModelProvider, modelId: string) {
    const selection = resolveProviderModelSelection(provider, modelId)

    if (currentProvider !== provider) {
      setActiveProvider(provider)
    }

    setAppState(prev => ({
      ...prev,
      mainLoopModel: selection.modelId,
      mainLoopModelForSession: null,
      ...(provider === 'firstParty'
        ? { effortValue: selection.effort }
        : selection.effort
          ? { effortValue: selection.effort }
          : {}),
    }))

    const providerNote = currentProvider !== provider
      ? ` (switched to ${chalk.bold(PROVIDER_DISPLAY_NAMES[provider])})`
      : ''

    const displayModel =
      getProviderModelDisplayName(provider, selection.modelId)
      ?? selection.modelId
    const effortNote = selection.effort
      ? ` with ${chalk.bold(selection.effort)} effort`
      : ''

    onDone(`Set model to ${chalk.bold(displayModel)}${effortNote}${providerNote}`)
  }

  function handleCancel() {
    onDone('Model selection cancelled', { display: 'system' })
  }

  return (
    <ProviderModelPicker
      initialProvider={initialProvider}
      lockedProvider={lockedProvider}
      onSelect={handleSelect}
      onCancel={handleCancel}
    />
  )
}

function isCursorProviderOnlyArgs(rawArgs: string): boolean {
  const normalized = rawArgs.trim().toLowerCase()
  return normalized === 'cursor' || normalized === 'cursor:'
}

async function showSearchResults(
  rawArgs: string,
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
) {
  const fallbackProvider = getDefaultBrowsableProvider(getAPIProvider())
  const { provider, query } = parseProviderModelQuery(rawArgs, fallbackProvider)

  let models
  try {
    models = await loadProviderModels(provider)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onDone(
      `Unable to load models from ${chalk.bold(getProviderBrowseLabel(provider))}: ${message}`,
      { display: 'system' },
    )
    return
  }

  const results = filterProviderModels(models, query)

  if (results.length === 0) {
    onDone(
      `No ${getProviderBrowseLabel(provider)} models match "${chalk.bold(query)}". Try ${chalk.cyan('/models')} to browse providers and models interactively.`,
      { display: 'system' },
    )
    return
  }

  const lines = [
    `${chalk.bold(getProviderBrowseLabel(provider))} - ${chalk.bold(String(results.length))} model${results.length === 1 ? '' : 's'}${query ? ` matching "${chalk.bold(query)}"` : ''}`,
    '',
    ...results.slice(0, 20).map(
      model =>
        `  ${chalk.cyan(model.id)}${model.name && model.name !== model.id ? ` - ${model.name}` : ''}${renderSearchBadges(model.tags)}`,
    ),
  ]

  if (results.length > 20) {
    lines.push(
      `  ... and ${results.length - 20} more. Use /models to browse interactively.`,
    )
  }

  lines.push('')
  lines.push(chalk.dim('Use /models to open the provider-aware picker.'))

  onDone(lines.join('\n'), { display: 'system' })
}

function showHelp(
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
) {
  const providerList = BROWSABLE_MODEL_PROVIDERS.map(
    provider => `  ${chalk.bold(getProviderBrowseLabel(provider))}`,
  ).join('\n')

  const lines = [
    `${chalk.bold('/models')} - provider-aware model browser`,
    '',
    chalk.bold('Usage:'),
    `  ${chalk.cyan('/models')}                    Pick a provider, then browse its models`,
    `  ${chalk.cyan('/models <query>')}            Search the active provider's models`,
    `  ${chalk.cyan('/models <provider>:<query>')} Search a specific provider`,
    `  ${chalk.cyan('/models cursor')}             Browse Cursor models and variants`,
    `  ${chalk.cyan('/models <provider>')}         List models from one provider`,
    '',
    chalk.bold('Browsable Providers:'),
    providerList,
    '',
    chalk.bold('Examples:'),
    `  ${chalk.cyan('/models')}                      Open provider + model picker`,
    `  ${chalk.cyan('/models qwen')}                 Search the active provider`,
    `  ${chalk.cyan('/models openrouter:qwen')}      Search OpenRouter models`,
    `  ${chalk.cyan('/models groq')}                 Show Groq models`,
    '',
    chalk.dim('The browser fetches live models when the selected provider supports it.'),
    chalk.dim('If a provider is not configured yet, run /provider or /login for Anthropic.'),
  ]

  onDone(lines.join('\n'), { display: 'system' })
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const trimmedArgs = args?.trim() || ''

  if (['help', '-h', '--help', '?'].includes(trimmedArgs.toLowerCase())) {
    showHelp(onDone)
    return
  }

  if (trimmedArgs) {
    if (isCursorProviderOnlyArgs(trimmedArgs)) {
      return <ModelsPickerWrapper onDone={onDone} lockedProvider="cursor" />
    }
    await showSearchResults(trimmedArgs, onDone)
    return
  }

  return <ModelsPickerWrapper onDone={onDone} />
}
