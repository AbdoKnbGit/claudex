import * as React from 'react'
import { type ReactNode, useEffect, useState } from 'react'
import { Box, Text } from '../ink.js'
import type { SandboxViolationEvent } from '../utils/sandbox/sandbox-adapter.js'
import { SandboxManager } from '../utils/sandbox/sandbox-adapter.js'
import { getPlatform } from 'src/utils/platform.js'

type SandboxViolationStoreLike = {
  subscribe(
    callback: (allViolations: SandboxViolationEvent[]) => void,
  ): (() => void) | void
  getTotalCount(): number
}

function formatTime(date: Date): string {
  const h = date.getHours() % 12 || 12
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  const ampm = date.getHours() < 12 ? 'am' : 'pm'
  return `${h}:${m}:${s}${ampm}`
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

export function SandboxViolationExpandedView(): ReactNode {
  const [violations, setViolations] = useState<SandboxViolationEvent[]>([])
  const [totalCount, setTotalCount] = useState(0)

  useEffect(() => {
    const store = getSandboxViolationStoreSafe()
    if (!store) {
      return
    }

    setTotalCount(store.getTotalCount())

    const unsubscribe = store.subscribe(allViolations => {
      setViolations(allViolations.slice(-10))
      setTotalCount(store.getTotalCount())
    })

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe()
      }
    }
  }, [])

  if (!SandboxManager.isSandboxingEnabled() || getPlatform() === 'linux') {
    return null
  }

  if (totalCount === 0) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box marginLeft={0}>
        <Text color="permission">
          Sandbox blocked {totalCount} total{' '}
          {totalCount === 1 ? 'operation' : 'operations'}
        </Text>
      </Box>
      {violations.map((violation, index) => (
        <Box key={`${violation.timestamp.getTime()}-${index}`} paddingLeft={2}>
          <Text dimColor>
            {formatTime(violation.timestamp)}
            {violation.command ? ` ${violation.command}:` : ''} {violation.line}
          </Text>
        </Box>
      ))}
      <Box paddingLeft={2}>
        <Text dimColor>
          ... showing last {Math.min(10, violations.length)} of {totalCount}
        </Text>
      </Box>
    </Box>
  )
}
