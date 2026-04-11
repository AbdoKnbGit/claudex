import chalk from 'chalk'
import * as React from 'react'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  modelSupportsThinking,
} from '../../utils/thinking.js'
import {
  getAPIProvider,
  isThirdPartyProvider,
} from '../../utils/model/providers.js'

/**
 * Static whitelist of third-party models known to support a
 * thinking/reasoning parameter. When thinking is enabled for a model
 * NOT in this list, the request is sent normally without the thinking
 * param — no crash, no error.
 */
const THIRD_PARTY_THINKING_MODELS: Record<string, string[]> = {
  deepseek: ['deepseek-reasoner'],
  nim: ['moonshotai/kimi-k2-thinking', 'kimi-k2-thinking'],
  openrouter: [
    'anthropic/claude-opus-4-6',
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-sonnet-4-5',
    'deepseek/deepseek-r1',
    'deepseek/deepseek-reasoner',
  ],
  groq: ['deepseek-r1-distill-llama-70b', 'deepseek-r1-distill-qwen-32b'],
}

function currentModelSupportsThinking(model: string): boolean {
  const provider = getAPIProvider()
  if (!isThirdPartyProvider(provider)) {
    return modelSupportsThinking(model)
  }
  const models = THIRD_PARTY_THINKING_MODELS[provider]
  if (!models) return false
  return models.some(m => model.includes(m))
}

function showHelp(
  onDone: (result?: string, options?: { display?: 'system' }) => void,
) {
  const lines = [
    `${chalk.bold('/thinking')} - Toggle thinking mode`,
    '',
    chalk.bold('Usage:'),
    `  ${chalk.cyan('/thinking')}       Toggle thinking on/off`,
    `  ${chalk.cyan('/thinking on')}    Enable thinking`,
    `  ${chalk.cyan('/thinking off')}   Disable thinking`,
    '',
    chalk.bold('Decision matrix:'),
    `  ${chalk.dim('thinking=on  + model supports it')}    ${chalk.green('->')} Thinking enabled`,
    `  ${chalk.dim('thinking=on  + model lacks support')}  ${chalk.yellow('->')} Sent normally (param omitted)`,
    `  ${chalk.dim('thinking=off + any model')}            ${chalk.blue('->')} No thinking param sent`,
    '',
    chalk.dim('Thinking allows the model to reason step-by-step before answering.'),
    chalk.dim('Supported: Claude 4+ (1P), DeepSeek Reasoner, Kimi K2 Thinking.'),
  ]
  onDone(lines.join('\n'), { display: 'system' })
}

function parseTargetState(
  args: string,
  currentEnabled: boolean,
): boolean | null {
  switch (args) {
    case 'on':
    case 'true':
    case '1':
      return true
    case 'off':
    case 'false':
    case '0':
      return false
    case '':
      return !currentEnabled
    default:
      return null // invalid
  }
}

function ApplyThinkingAndClose({
  newEnabled,
  onDone,
}: {
  newEnabled: boolean
  onDone: (result?: string) => void
}) {
  const setAppState = useSetAppState()
  const model = useMainLoopModel()

  React.useEffect(() => {
    setAppState(prev => ({ ...prev, thinkingEnabled: newEnabled }))

    const supportsIt = currentModelSupportsThinking(model)
    const stateLabel = newEnabled ? chalk.green('ON') : chalk.red('OFF')
    const modelLabel = chalk.bold(model || 'unknown')

    const lines = [`Thinking mode: ${stateLabel}`]

    if (newEnabled && !supportsIt) {
      lines.push(
        chalk.yellow(
          `Note: ${modelLabel} does not support thinking. Requests will be sent normally.`,
        ),
      )
      const provider = getAPIProvider()
      if (isThirdPartyProvider(provider)) {
        lines.push(
          chalk.dim(
            'Thinking-capable models: DeepSeek Reasoner, Kimi K2 Thinking, Claude 4+ (via OpenRouter).',
          ),
        )
      }
    } else if (newEnabled && supportsIt) {
      lines.push(
        chalk.dim(
          `${modelLabel} supports thinking — the model will reason step-by-step.`,
        ),
      )
    }

    onDone(lines.join('\n'))
  }, [setAppState, newEnabled, model, onDone])

  return null
}

function ShowCurrentThinking({
  onDone,
}: {
  onDone: (result?: string) => void
}) {
  const thinkingEnabled = useAppState((s: any) => s.thinkingEnabled)
  const model = useMainLoopModel()
  const supportsIt = currentModelSupportsThinking(model)

  const stateLabel = thinkingEnabled ? chalk.green('ON') : chalk.red('OFF')
  const supportLabel = supportsIt
    ? chalk.green('supported')
    : chalk.yellow('not supported')

  onDone(
    `Thinking: ${stateLabel} | Current model (${chalk.bold(model)}): ${supportLabel}`,
  )
  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const trimmedArgs = args?.trim().toLowerCase() || ''

  if (['help', '-h', '--help', '?'].includes(trimmedArgs)) {
    showHelp(onDone)
    return
  }

  if (trimmedArgs === 'status') {
    return <ShowCurrentThinking onDone={onDone} />
  }

  // We need access to current thinkingEnabled to toggle, so use a React component
  return <ThinkingToggler args={trimmedArgs} onDone={onDone} />
}

function ThinkingToggler({
  args,
  onDone,
}: {
  args: string
  onDone: (result?: string, options?: { display?: 'system' }) => void
}) {
  const currentEnabled = (useAppState((s: any) => s.thinkingEnabled) ?? true) as boolean

  const newEnabled = parseTargetState(args, currentEnabled)
  if (newEnabled === null) {
    onDone(
      `Unknown argument "${args}". Use ${chalk.cyan('/thinking on')}, ${chalk.cyan('/thinking off')}, or ${chalk.cyan('/thinking')} to toggle.`,
    )
    return null
  }

  return <ApplyThinkingAndClose newEnabled={newEnabled} onDone={onDone} />
}
