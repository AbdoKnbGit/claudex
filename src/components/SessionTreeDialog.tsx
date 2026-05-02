import type { UUID } from 'crypto'
import figures from 'figures'
import React, { useCallback, useMemo, useState } from 'react'
import type { ExitState } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- this dialog owns its own arrow + typing search loop
import { Box, Text, useInput } from '../ink.js'
import type { LogOption } from '../types/logs.js'
import { formatRelativeTimeAgo } from '../utils/format.js'
import {
  type FlatTreeNode,
  flattenForest,
  renderTreePrefix,
  type SessionTreeNode,
} from '../utils/sessionTree.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'

type Props = {
  forest: SessionTreeNode[]
  /** Session ID currently active in the REPL — gets a "← active" marker. */
  activeSessionId?: string
  onSelect: (sessionId: UUID, log: LogOption) => void
  onCancel: () => void
}

const MAX_VISIBLE_ROWS = 14

/**
 * A title is "garbage" if it leads with junk that the user wouldn't
 * recognize: a `<lowercase-tag>` (local-command-caveat, system-reminder,
 * ide-context, etc.) or a `Caveat:` prefix. These come from older /branch
 * runs that titled themselves with the slash-command wrapper instead of
 * the user's first real prompt. firstPrompt (extracted by tau's lite-load
 * path) skips the same junk, so it's the better fallback.
 */
function looksLikeJunkTitle(title: string | undefined): boolean {
  if (!title) return true
  const trimmed = title.trim()
  if (trimmed.length === 0) return true
  if (trimmed.startsWith('<')) return true
  if (trimmed.toLowerCase().startsWith('caveat:')) return true
  return false
}

function displayTitle(log: {
  customTitle?: string
  firstPrompt?: string
}): string {
  const custom = log.customTitle?.trim()
  if (custom && !looksLikeJunkTitle(custom)) return custom
  const first = log.firstPrompt?.trim()
  if (first && !looksLikeJunkTitle(first)) {
    // Preserve the suffix (e.g. " (Branch 2)") if the saved title had it,
    // since that's how the user distinguishes siblings at a glance.
    if (custom) {
      const suffixMatch = custom.match(/\s\((Branch|Clone|Imported)[^)]*\)$/)
      if (suffixMatch) return `${first}${suffixMatch[0]}`
    }
    return first
  }
  return custom || first || '(untitled)'
}

function rowText(row: FlatTreeNode): string {
  const log = row.node.log
  const tag = log.tag ?? ''
  return `${displayTitle(log)} ${tag} ${row.node.sessionId}`.toLowerCase()
}

function isPrintable(ch: string): boolean {
  const code = ch.charCodeAt(0)
  // Printable ASCII range plus everything above 0x7F (Unicode letters etc).
  return (code >= 32 && code !== 127) || code > 127
}

export function SessionTreeDialog({
  forest,
  activeSessionId,
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const [query, setQuery] = useState('')

  const allRows = useMemo(() => flattenForest(forest), [forest])

  // Filter by query — keep ancestors of any matching row so the tree stays
  // structurally valid (a child shouldn't render without its parent above it).
  const filteredRows = useMemo(() => {
    if (!query.trim()) return allRows
    const needle = query.trim().toLowerCase()
    const keepIds = new Set<string>()
    for (const row of allRows) {
      if (rowText(row).includes(needle)) keepIds.add(row.node.sessionId)
    }
    const ancestors = new Set<string>()
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i]!
      if (!keepIds.has(row.node.sessionId)) continue
      let targetDepth = row.depth - 1
      for (let j = i - 1; j >= 0 && targetDepth >= 0; j--) {
        const candidate = allRows[j]!
        if (candidate.depth === targetDepth) {
          ancestors.add(candidate.node.sessionId)
          targetDepth--
        }
      }
    }
    return allRows.filter(
      r => keepIds.has(r.node.sessionId) || ancestors.has(r.node.sessionId),
    )
  }, [allRows, query])

  const initialIndex = useMemo(() => {
    if (!activeSessionId) return 0
    const idx = filteredRows.findIndex(
      r => r.node.sessionId === activeSessionId,
    )
    return idx >= 0 ? idx : 0
  }, [filteredRows, activeSessionId])
  const [cursor, setCursor] = useState(initialIndex)
  const safeCursor = Math.max(0, Math.min(cursor, filteredRows.length - 1))

  const handleConfirm = useCallback(() => {
    const row = filteredRows[safeCursor]
    if (!row) return
    onSelect(row.node.sessionId as UUID, row.node.log)
  }, [filteredRows, safeCursor, onSelect])

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor(c => (c <= 0 ? filteredRows.length - 1 : c - 1))
      return
    }
    if (key.downArrow) {
      setCursor(c => (c >= filteredRows.length - 1 ? 0 : c + 1))
      return
    }
    if (key.return) {
      handleConfirm()
      return
    }
    if (key.pageUp) {
      setCursor(c => Math.max(0, c - MAX_VISIBLE_ROWS))
      return
    }
    if (key.pageDown) {
      setCursor(c => Math.min(filteredRows.length - 1, c + MAX_VISIBLE_ROWS))
      return
    }
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1))
      setCursor(0)
      return
    }
    if (input && !key.ctrl && !key.meta && !key.escape) {
      let printable = ''
      for (const ch of input) {
        if (isPrintable(ch)) printable += ch
      }
      if (printable.length === 0) return
      setQuery(q => q + printable)
      setCursor(0)
    }
  })

  const startRow = Math.max(
    0,
    Math.min(
      safeCursor - Math.floor(MAX_VISIBLE_ROWS / 2),
      filteredRows.length - MAX_VISIBLE_ROWS,
    ),
  )
  const endRow = Math.min(startRow + MAX_VISIBLE_ROWS, filteredRows.length)

  const renderRow = (row: FlatTreeNode, isCursor: boolean): React.ReactNode => {
    const log = row.node.log
    const title = displayTitle(log)
    const meta = `${log.messageCount} msgs · ${formatRelativeTimeAgo(log.modified, { style: 'short' })}`
    const isActive = row.node.sessionId === activeSessionId
    const prefix = renderTreePrefix(row)
    const cursorMark = isCursor ? `${figures.pointer} ` : '  '
    const activeMark = isActive ? '  ← active' : ''
    const overhead =
      cursorMark.length + prefix.length + meta.length + activeMark.length + 5
    const maxTitle = Math.max(10, columns - overhead)
    const safeTitle =
      title.length > maxTitle ? `${title.slice(0, maxTitle - 1)}…` : title
    return (
      <Box key={row.node.sessionId}>
        <Text color={isCursor ? 'cyan' : undefined}>{cursorMark}</Text>
        <Text dimColor>{prefix}</Text>
        <Text bold={isCursor} color={isActive ? 'green' : undefined}>
          {safeTitle}
        </Text>
        <Text dimColor>{`  [${meta}]`}</Text>
        {isActive && <Text color="green">{activeMark}</Text>}
      </Box>
    )
  }

  function renderInputGuide(exitState: ExitState): React.ReactNode {
    if (exitState.pending) {
      return <Text>Press {exitState.keyName} again to exit</Text>
    }
    return (
      <Byline>
        <KeyboardShortcutHint shortcut="↑/↓" action="navigate" />
        <KeyboardShortcutHint shortcut="Enter" action="resume" />
        <KeyboardShortcutHint shortcut="type" action="search" />
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Confirmation"
          fallback="Esc"
          description="cancel"
        />
      </Byline>
    )
  }

  const subtitle =
    filteredRows.length === allRows.length
      ? `${allRows.length} session${allRows.length === 1 ? '' : 's'} in this project`
      : `${filteredRows.length} of ${allRows.length} sessions match "${query}"`

  return (
    <Dialog
      title="Session Tree"
      subtitle={subtitle}
      color="permission"
      onCancel={onCancel}
      inputGuide={renderInputGuide}
    >
      {filteredRows.length === 0 ? (
        <Text dimColor>No sessions match "{query}"</Text>
      ) : (
        <Box flexDirection="column">
          {filteredRows
            .slice(startRow, endRow)
            .map((row, i) => renderRow(row, startRow + i === safeCursor))}
          {filteredRows.length > MAX_VISIBLE_ROWS && (
            <Text dimColor>
              {' '}
              ({safeCursor + 1}/{filteredRows.length})
            </Text>
          )}
        </Box>
      )}
    </Dialog>
  )
}
