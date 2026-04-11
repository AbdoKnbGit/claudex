/**
 * /models command — Browse and search the full NVIDIA NIM model catalog.
 *
 * When run without arguments, opens the interactive searchable picker.
 * The picker fetches live models from the NIM API so only actually-available
 * models are shown (preventing 404 errors).
 *
 * When run with arguments, filters models by the given query.
 *
 * Usage:
 *   /models              — Open interactive model browser (fetches live models)
 *   /models llama        — Search for "llama" models
 *   /models meta         — Show all Meta models
 *   /models help         — Show help
 */

import chalk from 'chalk'
import * as React from 'react'
import { NimModelPicker } from '../../components/NimModelPicker.js'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { useSetAppState } from '../../state/AppState.js'
import { getAPIProvider, setActiveProvider } from '../../utils/model/providers.js'
import {
  searchNimModels,
  fetchLiveNimModels,
  buildLiveModelList,
  hasLiveModels,
  NIM_MODEL_COUNT,
  NIM_PROVIDER_GROUPS,
} from '../../utils/model/nim_catalog.js'
import { loadProviderKey } from '../../services/api/auth/api_key_manager.js'

function ModelsPickerWrapper({
  onDone,
}: {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}) {
  const setAppState = useSetAppState()
  const currentProvider = getAPIProvider()

  function handleSelect(modelId: string) {
    // If not already on NIM, switch to NIM
    if (currentProvider !== 'nim') {
      setActiveProvider('nim')
    }

    // Set the selected model
    setAppState(prev => ({
      ...prev,
      mainLoopModel: modelId,
      mainLoopModelForSession: null,
    }))

    const providerNote = currentProvider !== 'nim'
      ? ` (switched to ${chalk.bold('NVIDIA NIM')})`
      : ''

    onDone(
      `Set model to ${chalk.bold(modelId)}${providerNote}`,
    )
  }

  function handleCancel() {
    onDone(`Model selection cancelled`, { display: 'system' })
  }

  return <NimModelPicker onSelect={handleSelect} onCancel={handleCancel} />
}

async function showSearchResults(
  query: string,
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
) {
  // Try to fetch live models first for accurate results
  const apiKey = loadProviderKey('nim') ?? process.env.NIM_API_KEY ?? ''
  let liveModelList = undefined
  if (apiKey) {
    try {
      const liveIds = await fetchLiveNimModels(apiKey)
      if (liveIds.size > 0) {
        liveModelList = buildLiveModelList(liveIds)
      }
    } catch { /* fall back to static catalog */ }
  }

  const results = searchNimModels(query, liveModelList)
  const isLive = liveModelList !== undefined

  if (results.length === 0) {
    onDone(
      `No NIM models match "${chalk.bold(query)}". Try /models to browse all available models.`,
      { display: 'system' },
    )
    return
  }

  const liveTag = isLive ? chalk.green(' [LIVE]') : ''
  const lines = [
    `Found ${chalk.bold(String(results.length))} model${results.length !== 1 ? 's' : ''} matching "${chalk.bold(query)}":${liveTag}`,
    '',
    ...results.slice(0, 20).map(
      m => `  ${chalk.cyan(m.id)} — ${m.name} (${chalk.dim(m.provider)})`,
    ),
  ]

  if (results.length > 20) {
    lines.push(`  ... and ${results.length - 20} more. Use /models to browse interactively.`)
  }

  lines.push('')
  lines.push(chalk.dim(`Use /model <id> to set a model (e.g. /model ${results[0]!.id})`))

  onDone(lines.join('\n'), { display: 'system' })
}

function showHelp(
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
) {
  const providerList = NIM_PROVIDER_GROUPS.map(
    g => `  ${g.icon} ${chalk.bold(g.name)} (${g.models.length} models)`,
  ).join('\n')

  const lines = [
    `${chalk.bold('NVIDIA NIM Model Catalog')} — ${NIM_MODEL_COUNT} models in catalog`,
    '',
    chalk.bold('Usage:'),
    `  ${chalk.cyan('/models')}              Open interactive model browser (fetches live available models)`,
    `  ${chalk.cyan('/models <query>')}      Search models by name/provider/ID`,
    `  ${chalk.cyan('/model <model-id>')}    Set a specific model directly`,
    '',
    chalk.bold('Known Providers:'),
    providerList,
    '',
    chalk.bold('Examples:'),
    `  ${chalk.cyan('/models llama')}        Find all LLaMA models`,
    `  ${chalk.cyan('/models kimi')}         Find Kimi/Moonshot models`,
    `  ${chalk.cyan('/models nvidia')}       Find NVIDIA-native models`,
    `  ${chalk.cyan('/models qwen')}         Find Qwen/Alibaba models`,
    `  ${chalk.cyan('/model moonshotai/kimi-k2-thinking')}  Set model directly`,
    '',
    chalk.dim('Note: /models fetches live availability from the NIM API to prevent 404 errors.'),
    chalk.dim('Only models actually deployed on NIM at this moment will appear.'),
  ]

  onDone(lines.join('\n'), { display: 'system' })
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || ''

  // Help
  if (['help', '-h', '--help', '?'].includes(args.toLowerCase())) {
    showHelp(onDone)
    return
  }

  // Search mode (non-interactive, with live fetch)
  if (args) {
    await showSearchResults(args, onDone)
    return
  }

  // Interactive picker mode (fetches live models internally)
  return <ModelsPickerWrapper onDone={onDone} />
}
