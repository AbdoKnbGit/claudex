import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import type { ModelInfo } from '../services/api/providers/base_provider.js'
import { validateProviderAuth } from '../utils/auth.js'
import {
  BROWSABLE_MODEL_PROVIDERS,
  filterProviderModels,
  getProviderBrowseLabel,
  loadProviderModels,
  type BrowsableModelProvider,
} from '../utils/model/providerCatalog.js'

type Props = {
  initialProvider: BrowsableModelProvider
  onSelect: (provider: BrowsableModelProvider, modelId: string) => void
  onCancel: () => void
}

type Step = 'provider' | 'models'

const MAX_VISIBLE_MODELS = 14

export function ProviderModelPicker({
  initialProvider,
  onSelect,
  onCancel,
}: Props) {
  const [step, setStep] = useState<Step>('provider')
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(() =>
    Math.max(0, BROWSABLE_MODEL_PROVIDERS.indexOf(initialProvider)),
  )
  const [selectedModelIndex, setSelectedModelIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])

  const selectedProvider =
    BROWSABLE_MODEL_PROVIDERS[selectedProviderIndex] ?? initialProvider

  useEffect(() => {
    if (step !== 'models') {
      return
    }

    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setModels([])
    setSelectedModelIndex(0)

    void loadProviderModels(selectedProvider)
      .then(loadedModels => {
        if (cancelled) {
          return
        }

        if (loadedModels.length === 0) {
          setLoadError(
            `No models were returned by ${getProviderBrowseLabel(selectedProvider)}.`,
          )
          return
        }

        setModels(loadedModels)
      })
      .catch(error => {
        if (cancelled) {
          return
        }

        setLoadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [selectedProvider, step])

  const filteredModels = useMemo(
    () => filterProviderModels(models, query),
    [models, query],
  )

  useEffect(() => {
    if (selectedModelIndex >= filteredModels.length) {
      setSelectedModelIndex(Math.max(0, filteredModels.length - 1))
    }
  }, [filteredModels.length, selectedModelIndex])

  const scrollOffset = useMemo(() => {
    const halfWindow = Math.floor(MAX_VISIBLE_MODELS / 2)
    const start = Math.max(0, selectedModelIndex - halfWindow)
    return Math.min(
      start,
      Math.max(0, filteredModels.length - MAX_VISIBLE_MODELS),
    )
  }, [filteredModels.length, selectedModelIndex])

  const visibleModels = filteredModels.slice(
    scrollOffset,
    scrollOffset + MAX_VISIBLE_MODELS,
  )

  useInput((input, key) => {
    if (key.escape) {
      if (step === 'models') {
        setStep('provider')
        setQuery('')
        setLoadError(null)
        return
      }

      onCancel()
      return
    }

    if (step === 'provider') {
      if (key.upArrow) {
        setSelectedProviderIndex(index =>
          index > 0 ? index - 1 : BROWSABLE_MODEL_PROVIDERS.length - 1,
        )
        return
      }

      if (key.downArrow) {
        setSelectedProviderIndex(index =>
          index < BROWSABLE_MODEL_PROVIDERS.length - 1 ? index + 1 : 0,
        )
        return
      }

      if (key.return) {
        setStep('models')
      }

      return
    }

    if (loading) {
      return
    }

    if (key.return) {
      const selectedModel = filteredModels[selectedModelIndex]
      if (selectedModel) {
        onSelect(selectedProvider, selectedModel.id)
      }
      return
    }

    if (key.upArrow) {
      setSelectedModelIndex(index =>
        index > 0 ? index - 1 : Math.max(0, filteredModels.length - 1),
      )
      return
    }

    if (key.downArrow) {
      setSelectedModelIndex(index =>
        index < filteredModels.length - 1 ? index + 1 : 0,
      )
      return
    }

    if (key.pageUp) {
      setSelectedModelIndex(index => Math.max(0, index - 10))
      return
    }

    if (key.pageDown) {
      setSelectedModelIndex(index =>
        Math.min(filteredModels.length - 1, index + 10),
      )
      return
    }

    if (key.backspace || key.delete) {
      setQuery(currentQuery => currentQuery.slice(0, -1))
      setSelectedModelIndex(0)
      return
    }

    if (key.tab) {
      return
    }

    if (input && input.length === 1 && input >= ' ') {
      setQuery(currentQuery => currentQuery + input)
      setSelectedModelIndex(0)
    }
  })

  if (step === 'provider') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold color="claude">
            Provider Model Browser
          </Text>
        </Box>

        <Text dimColor>
          Pick a provider first. The browser will fetch that provider's live
          model list.
        </Text>

        <Box marginTop={1} flexDirection="column">
          {BROWSABLE_MODEL_PROVIDERS.map((provider, index) => {
            const isSelected = index === selectedProviderIndex
            const authStatus = validateProviderAuth(provider)
            const status = authStatus.valid
              ? 'configured'
              : provider === 'ollama'
                ? 'local'
                : 'login required'

            return (
              <Box key={provider}>
                <Text
                  bold={isSelected}
                  color={isSelected ? 'claude' : undefined}
                  dimColor={!isSelected}
                >
                  {isSelected ? '> ' : '  '}
                  {getProviderBrowseLabel(provider)}
                </Text>
                <Text dimColor> [{status}]</Text>
              </Box>
            )
          })}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            Up/Down to navigate | Enter to load models | Esc to cancel
          </Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1}>
        <Text bold color="claude">
          {getProviderBrowseLabel(selectedProvider)}
        </Text>
        {!loading && models.length > 0 && (
          <Text dimColor> ({models.length} models)</Text>
        )}
      </Box>

      <Box>
        <Text color="claude">Search: </Text>
        <Text bold>{query}</Text>
        <Text color="claude">_</Text>
        {!loading && !loadError && (
          <Text dimColor>
            {' '}
            ({filteredModels.length} match{filteredModels.length === 1 ? '' : 'es'})
          </Text>
        )}
      </Box>

      {loading && (
        <Box marginTop={1} flexDirection="column">
          <Text color="warning">
            Fetching models from {getProviderBrowseLabel(selectedProvider)}...
          </Text>
          <Text dimColor>Esc to go back</Text>
        </Box>
      )}

      {!loading && loadError && (
        <Box marginTop={1} flexDirection="column">
          <Text color="error">{loadError}</Text>
          <Text dimColor>
            Run /login if this provider is not configured yet, then try again.
          </Text>
        </Box>
      )}

      {!loading && !loadError && (
        <Box marginTop={1} flexDirection="column">
          {filteredModels.length === 0 ? (
            <Text dimColor>No models match "{query}".</Text>
          ) : (
            visibleModels.map((model, index) => {
              const actualIndex = scrollOffset + index
              const isSelected = actualIndex === selectedModelIndex
              const label =
                model.name && model.name !== model.id
                  ? `${model.id} - ${model.name}`
                  : model.id

              return (
                <Box key={model.id}>
                  <Text
                    bold={isSelected}
                    color={isSelected ? 'claude' : undefined}
                    dimColor={!isSelected}
                  >
                    {isSelected ? '> ' : '  '}
                    {label}
                  </Text>
                </Box>
              )
            })
          )}

          {filteredModels.length > MAX_VISIBLE_MODELS && (
            <Box marginTop={1}>
              <Text dimColor>
                {scrollOffset > 0 ? '...' : '   '}
                {' '}
                {scrollOffset + MAX_VISIBLE_MODELS < filteredModels.length
                  ? '(scroll for more)'
                  : ''}
              </Text>
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          Type to filter | Up/Down to navigate | Enter to select | Esc to go back
        </Text>
      </Box>
    </Box>
  )
}
