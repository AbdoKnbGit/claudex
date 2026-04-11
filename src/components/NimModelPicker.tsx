/**
 * NimModelPicker — searchable TUI for browsing and selecting NVIDIA NIM models.
 *
 * On mount, fetches the live model list from the NIM API so only actually-available
 * models are shown. Falls back to the static catalog if the API call fails.
 *
 * Features:
 *   - Type to search/filter models by name, ID, or provider
 *   - Arrow keys to navigate results
 *   - Models grouped by provider with icons
 *   - Enter to select, Esc to cancel
 *   - Shows total model count and match count
 */

import * as React from 'react'
import { useState, useMemo, useEffect } from 'react'
import { Box, Text, useInput } from '../ink.js'
import {
  filterProviderGroups,
  fetchLiveNimModels,
  hasLiveModels,
  getLiveModelIds,
  buildLiveProviderGroups,
  NIM_PROVIDER_GROUPS,
  type NimModelEntry,
  type NimProviderGroup,
} from '../utils/model/nim_catalog.js'
import { loadProviderKey } from '../services/api/auth/api_key_manager.js'

type Props = {
  onSelect: (modelId: string) => void
  onCancel: () => void
}

/** Max visible models in the scrollable list */
const MAX_VISIBLE = 16

export function NimModelPicker({ onSelect, onCancel }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [liveGroups, setLiveGroups] = useState<NimProviderGroup[] | null>(null)
  const [modelCount, setModelCount] = useState(0)

  // Fetch live models on mount
  useEffect(() => {
    let cancelled = false

    async function loadModels() {
      try {
        // Get API key from stored credentials or env
        const apiKey = loadProviderKey('nim') ?? process.env.NIM_API_KEY ?? ''
        const liveIds = await fetchLiveNimModels(apiKey)

        if (cancelled) return

        if (liveIds.size > 0) {
          const groups = buildLiveProviderGroups(liveIds)
          setLiveGroups(groups)
          setModelCount(liveIds.size)
        } else {
          // Fallback to static catalog
          setLiveGroups(NIM_PROVIDER_GROUPS)
          setModelCount(NIM_PROVIDER_GROUPS.reduce((n, g) => n + g.models.length, 0))
        }
      } catch {
        if (!cancelled) {
          setLiveGroups(NIM_PROVIDER_GROUPS)
          setModelCount(NIM_PROVIDER_GROUPS.reduce((n, g) => n + g.models.length, 0))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadModels()
    return () => { cancelled = true }
  }, [])

  const sourceGroups = liveGroups ?? NIM_PROVIDER_GROUPS

  // Filter models based on search query
  const filteredGroups = useMemo(
    () => filterProviderGroups(query, sourceGroups),
    [query, sourceGroups],
  )

  // Flatten filtered groups into a selectable list with group headers
  const flatList = useMemo(() => {
    const items: Array<
      | { type: 'header'; group: string; icon: string; count: number }
      | { type: 'model'; model: NimModelEntry }
    > = []
    for (const group of filteredGroups) {
      items.push({
        type: 'header',
        group: group.name,
        icon: group.icon,
        count: group.models.length,
      })
      for (const model of group.models) {
        items.push({ type: 'model', model })
      }
    }
    return items
  }, [filteredGroups])

  // Only model entries are selectable
  const selectableIndices = useMemo(
    () => flatList.map((item, i) => (item.type === 'model' ? i : -1)).filter(i => i >= 0),
    [flatList],
  )

  const totalMatches = selectableIndices.length

  // Clamp selected index when results change
  const clampedSelected = Math.min(selectedIndex, Math.max(0, totalMatches - 1))
  if (clampedSelected !== selectedIndex && totalMatches > 0) {
    setTimeout(() => setSelectedIndex(clampedSelected), 0)
  }

  const currentFlatIndex = selectableIndices[clampedSelected] ?? -1

  // Compute scroll window
  const scrollOffset = useMemo(() => {
    if (currentFlatIndex < 0) return 0
    const halfWindow = Math.floor(MAX_VISIBLE / 2)
    const start = Math.max(0, currentFlatIndex - halfWindow)
    return Math.min(start, Math.max(0, flatList.length - MAX_VISIBLE))
  }, [currentFlatIndex, flatList.length])

  const visibleItems = flatList.slice(scrollOffset, scrollOffset + MAX_VISIBLE)

  useInput((input: string, key: {
    upArrow?: boolean
    downArrow?: boolean
    return?: boolean
    escape?: boolean
    backspace?: boolean
    delete?: boolean
    tab?: boolean
    pageUp?: boolean
    pageDown?: boolean
  }) => {
    if (key.escape) {
      onCancel()
      return
    }

    if (loading) return // Don't process input while loading

    if (key.return) {
      const item = flatList[currentFlatIndex]
      if (item && item.type === 'model') {
        onSelect(item.model.id)
      }
      return
    }

    if (key.upArrow) {
      setSelectedIndex(i => (i > 0 ? i - 1 : totalMatches - 1))
      return
    }

    if (key.downArrow) {
      setSelectedIndex(i => (i < totalMatches - 1 ? i + 1 : 0))
      return
    }

    if (key.pageUp) {
      setSelectedIndex(i => Math.max(0, i - 10))
      return
    }

    if (key.pageDown) {
      setSelectedIndex(i => Math.min(totalMatches - 1, i + 10))
      return
    }

    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1))
      setSelectedIndex(0)
      return
    }

    if (key.tab) return

    // Regular character input
    if (input && input.length === 1 && input >= ' ') {
      setQuery(q => q + input)
      setSelectedIndex(0)
    }
  })

  // Loading state
  if (loading) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold color="claude">
            NVIDIA NIM Model Catalog
          </Text>
        </Box>
        <Text color="warning">Fetching available models from NIM API...</Text>
        <Text dimColor>Press Esc to cancel</Text>
      </Box>
    )
  }

  const isLive = hasLiveModels()

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="claude">
          NVIDIA NIM Model Catalog
        </Text>
        <Text dimColor>
          {' '}({modelCount} {isLive ? 'available' : 'cataloged'} models)
        </Text>
        {isLive && (
          <Text color="success"> [LIVE]</Text>
        )}
      </Box>

      {/* Search bar */}
      <Box>
        <Text color="claude">Search: </Text>
        <Text bold>{query || ''}</Text>
        <Text color="claude">_</Text>
        {query && (
          <Text dimColor>
            {' '}({totalMatches} match{totalMatches !== 1 ? 'es' : ''})
          </Text>
        )}
      </Box>

      {/* Results */}
      <Box flexDirection="column" marginTop={1}>
        {totalMatches === 0 && (
          <Text dimColor>No models match "{query}". Try a different search.</Text>
        )}

        {visibleItems.map((item, vi) => {
          const realIndex = scrollOffset + vi
          if (item.type === 'header') {
            return (
              <Box key={`h-${item.group}`} marginTop={vi > 0 ? 1 : 0}>
                <Text bold color="warning">
                  {item.icon} {item.group}
                </Text>
                <Text dimColor> ({item.count})</Text>
              </Box>
            )
          }

          const isSelected = realIndex === currentFlatIndex
          return (
            <Box key={item.model.id}>
              <Text
                bold={isSelected}
                color={isSelected ? 'claude' : undefined}
                dimColor={!isSelected}
              >
                {isSelected ? '> ' : '  '}
                {item.model.id}
              </Text>
              {isSelected && (
                <Text dimColor> - {item.model.name}</Text>
              )}
            </Box>
          )
        })}

        {flatList.length > MAX_VISIBLE && (
          <Box marginTop={0}>
            <Text dimColor>
              {scrollOffset > 0 ? '...' : '   '}
              {' '}
              {scrollOffset + MAX_VISIBLE < flatList.length ? '(scroll for more)' : ''}
            </Text>
          </Box>
        )}
      </Box>

      {/* Help */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          Type to search | Up/Down to navigate | PgUp/PgDn to jump | Enter to select | Esc to cancel
        </Text>
        <Text dimColor>
          Tip: type model name directly with /model {'<'}id{'>'} (e.g. /model meta/llama-3.3-70b-instruct)
        </Text>
      </Box>
    </Box>
  )
}
