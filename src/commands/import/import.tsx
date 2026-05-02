import { randomUUID, type UUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import * as path from 'path'
import * as React from 'react'
import { useCallback, useState } from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Spinner } from '../../components/Spinner.js'
import { Box, Text } from '../../ink.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type {
  Entry,
  LogOption,
  SerializedMessage,
  TranscriptMessage,
} from '../../types/logs.js'
import { logError } from '../../utils/log.js'
import { parseJSONL } from '../../utils/json.js'
import {
  getFirstMeaningfulUserMessageTextContent,
  getProjectDir,
  getTranscriptPathForSession,
  isTranscriptMessage,
  saveCustomTitle,
} from '../../utils/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'

type TranscriptEntry = TranscriptMessage & {
  forkedFrom?: {
    sessionId: string
    messageUuid: UUID
  }
}

type ParsedImport = {
  sourceSessionId: UUID | null
  messageCount: number
  firstPrompt: string
}

function expandHome(p: string): string {
  if (p.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (home) return path.join(home, p.slice(1))
  }
  return p
}

function deriveFirstPrompt<T extends SerializedMessage>(
  transcript: T[],
): string {
  // Latest meaningful prompt — the import preserves the source's full
  // history, so the FIRST prompt is the source's original opener and gives
  // no clue about what the conversation became. The LAST prompt is what the
  // sharer was working on when they gave you the file.
  const reversed = [...transcript].reverse()
  const text =
    getFirstMeaningfulUserMessageTextContent(reversed) ??
    getFirstMeaningfulUserMessageTextContent(transcript)
  if (!text) return 'Imported conversation'
  return (
    text.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Imported conversation'
  )
}

function autoSuffix(label: string): string {
  const now = new Date()
  const hh = now.getHours().toString().padStart(2, '0')
  const mm = now.getMinutes().toString().padStart(2, '0')
  return `(${label} · ${hh}:${mm})`
}

async function inspectSource(filePath: string): Promise<ParsedImport | null> {
  try {
    const buf = await readFile(filePath)
    if (buf.length === 0) return null
    const entries = parseJSONL<Entry>(buf)
    const transcript = entries.filter(
      (e): e is TranscriptMessage => isTranscriptMessage(e) && !e.isSidechain,
    )
    if (transcript.length === 0) return null
    return {
      sourceSessionId: (transcript[0]?.sessionId as UUID | undefined) ?? null,
      messageCount: transcript.length,
      firstPrompt: deriveFirstPrompt(transcript),
    }
  } catch {
    return null
  }
}

/**
 * Read the source JSONL, rewrite sessionId + parentUuid chain, stamp
 * `forkedFrom` so /tree links the import under the source session, and
 * write into the current project's projects dir.
 *
 * cwd is rewritten to the importer's cwd. Without this, file-history /
 * tool-result reconstruction would point at directories that exist only on
 * the source machine.
 */
async function performImport(sourcePath: string): Promise<{
  sessionId: UUID
  importPath: string
  serializedMessages: SerializedMessage[]
  firstPrompt: string
  effectiveTitle: string
}> {
  const buf = await readFile(sourcePath)
  const entries = parseJSONL<Entry>(buf)
  const transcript = entries.filter(
    (e): e is TranscriptMessage => isTranscriptMessage(e) && !e.isSidechain,
  )
  if (transcript.length === 0) {
    throw new Error('Not a valid tau session JSONL (no transcript messages)')
  }

  const importSessionId = randomUUID() as UUID
  const sourceSessionId = transcript[0]!.sessionId as UUID
  const importerCwd = getOriginalCwd()
  const projectDir = getProjectDir(importerCwd)
  const importPath = getTranscriptPathForSession(importSessionId)

  await mkdir(projectDir, { recursive: true, mode: 0o700 })

  let parentUuid: UUID | null = null
  const lines: string[] = []
  const serializedMessages: SerializedMessage[] = []
  for (const entry of transcript) {
    const rewritten: TranscriptEntry = {
      ...entry,
      sessionId: importSessionId,
      cwd: importerCwd,
      parentUuid,
      isSidechain: false,
      forkedFrom: {
        sessionId: sourceSessionId,
        messageUuid: entry.uuid,
      },
    }
    const serialized: SerializedMessage = {
      ...entry,
      sessionId: importSessionId,
      cwd: importerCwd,
    }
    serializedMessages.push(serialized)
    lines.push(jsonStringify(rewritten))
    if (entry.type !== 'progress') {
      parentUuid = entry.uuid
    }
  }

  await writeFile(importPath, lines.join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })

  const firstPrompt = deriveFirstPrompt(serializedMessages)
  const effectiveTitle = `${firstPrompt} ${autoSuffix('Imported')}`
  await saveCustomTitle(importSessionId, effectiveTitle, importPath)

  logEvent('tengu_conversation_forked', {
    message_count: serializedMessages.length,
    has_custom_title: false,
  })

  return {
    sessionId: importSessionId,
    importPath,
    serializedMessages,
    firstPrompt,
    effectiveTitle,
  }
}

type ImportPromptProps = {
  sourcePath: string
  preview: ParsedImport
  onConfirm: () => void
  onCancel: () => void
}

function ImportConfirmDialog({
  sourcePath,
  preview,
  onConfirm,
  onCancel,
}: ImportPromptProps): React.ReactNode {
  const options = [
    { label: 'Import and switch into it', value: 'yes' },
    { label: 'Cancel', value: 'no' },
  ]
  return (
    <Dialog
      title="Import session?"
      subtitle={`Source: ${sourcePath}`}
      color="permission"
      onCancel={onCancel}
    >
      <Box flexDirection="column">
        <Text dimColor>
          {preview.messageCount} messages · "{preview.firstPrompt}"
        </Text>
        <Text dimColor>
          A copy will be written to this project. The original file is not
          modified. The current session stays as-is and you can /resume back
          to it.
        </Text>
        <Box marginTop={1}>
          <Select
            options={options}
            onChange={(value: string) =>
              value === 'yes' ? onConfirm() : onCancel()
            }
            onCancel={onCancel}
          />
        </Box>
      </Box>
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const rawArg = args?.trim()
  if (!rawArg) {
    onDone('Usage: /import <path-to-session.jsonl>')
    return null
  }

  const sourcePath = path.resolve(expandHome(rawArg))
  if (!existsSync(sourcePath)) {
    onDone(`File not found: ${sourcePath}`)
    return null
  }

  const preview = await inspectSource(sourcePath)
  if (!preview) {
    onDone(`Not a valid tau session JSONL: ${sourcePath}`)
    return null
  }

  return <ImportFlow path={sourcePath} preview={preview} onDone={onDone} context={context} />
}

type FlowProps = {
  path: string
  preview: ParsedImport
  onDone: LocalJSXCommandOnDone
  context: LocalJSXCommandContext
}

function ImportFlow({ path: sourcePath, preview, onDone, context }: FlowProps): React.ReactNode {
  const [stage, setStage] = useState<'confirm' | 'importing'>('confirm')

  const runImport = useCallback(async () => {
    setStage('importing')
    try {
      const result = await performImport(sourcePath)
      const log: LogOption = {
        date: new Date().toISOString().split('T')[0]!,
        messages: result.serializedMessages,
        fullPath: result.importPath,
        value: Date.now(),
        created: new Date(),
        modified: new Date(),
        firstPrompt: result.firstPrompt,
        messageCount: result.serializedMessages.length,
        isSidechain: false,
        sessionId: result.sessionId,
        customTitle: result.effectiveTitle,
      }
      if (context.resume) {
        await context.resume(result.sessionId, log, 'fork')
        onDone(
          `Imported as "${result.effectiveTitle}". You can /resume back to your previous session at any time.`,
          { display: 'system' },
        )
      } else {
        onDone(
          `Imported as "${result.effectiveTitle}". Resume with: /resume ${result.sessionId}`,
        )
      }
    } catch (error) {
      logError(error as Error)
      onDone(`Failed to import: ${(error as Error).message}`)
    }
  }, [sourcePath, onDone, context])

  if (stage === 'importing') {
    return (
      <Box>
        <Spinner />
        <Text> Importing session…</Text>
      </Box>
    )
  }

  return (
    <ImportConfirmDialog
      sourcePath={sourcePath}
      preview={preview}
      onConfirm={runImport}
      onCancel={() => onDone('Import cancelled')}
    />
  )
}
