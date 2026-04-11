import * as React from 'react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'

type SandboxViolationStoreLike = {
  subscribe(callback: () => void): (() => void) | void
  getTotalCount(): number
}

function getSandboxViolationStoreSafe(): SandboxViolationStoreLike | null {
  const store = SandboxManager.getSandboxViolationStore() as
    | Partial<SandboxViolationStoreLike>
    | undefined

  if (
    !store ||
    typeof store.subscribe !== 'function' ||
    typeof store.getTotalCount !== 'function'
  ) {
    return null
  }

  return store as SandboxViolationStoreLike
}

export function SandboxPromptFooterHint(): ReactNode {
  const [recentViolationCount, setRecentViolationCount] = useState(0)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const detailsShortcut = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )

  useEffect(() => {
    if (!SandboxManager.isSandboxingEnabled()) {
      return
    }

    const store = getSandboxViolationStoreSafe()
    if (!store) {
      return
    }

    let lastCount = store.getTotalCount()
    const unsubscribe = store.subscribe(() => {
      const currentCount = store.getTotalCount()
      const newViolations = currentCount - lastCount

      if (newViolations > 0) {
        setRecentViolationCount(newViolations)
        lastCount = currentCount

        if (timerRef.current) {
          clearTimeout(timerRef.current)
        }

        timerRef.current = setTimeout(() => {
          setRecentViolationCount(0)
        }, 5000)
      }
    })

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe()
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  if (!SandboxManager.isSandboxingEnabled() || recentViolationCount === 0) {
    return null
  }

  return (
    <Box paddingX={0} paddingY={0}>
      <Text color="inactive" wrap="truncate">
        Sandbox blocked {recentViolationCount}{' '}
        {recentViolationCount === 1 ? 'operation' : 'operations'} -{' '}
        {detailsShortcut} for details - /sandbox to disable
      </Text>
    </Box>
  )
}
