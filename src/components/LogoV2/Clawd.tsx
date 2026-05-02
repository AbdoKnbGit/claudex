import * as React from 'react'
import { Box, Text } from '../../ink.js'

export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right'

type Props = {
  pose?: ClawdPose
  shimmerStep?: number
  tentacleFrame?: number
}

const TAU_AURA = [
  'rgb(255,94,48)',
  'rgb(238,72,42)',
  'rgb(210,58,44)',
  'rgb(144,55,39)',
  'rgb(255,132,64)',
] as const

type TauAuraColor = (typeof TAU_AURA)[number]

const TAU_SIGIL = [
  ' ╔████████╗  ',
  ' ╚═══██╔══╝ ',
  '     ██║     ',
  '     ██║     ',
  '     ██║  ██╗',
  '     ╚█████╔╝',
  '      ╚════╝ ',
] as const

function auraColor(index: number, shimmerStep: number): TauAuraColor {
  return TAU_AURA[(index + shimmerStep) % TAU_AURA.length]!
}

function auraText(text: string, shimmerStep: number): React.ReactNode {
  return Array.from(text).map((char, index) => {
    if (char === '█') {
      return (
        <Text key={`${index}-${char}`} bold color="rgb(255,102,72)">
          {char}
        </Text>
      )
    }
    return (
      <Text key={`${index}-${char}`} color={auraColor(index, shimmerStep)}>
        {char}
      </Text>
    )
  })
}

/**
 * Compact Tau sigil. The exported name stays Clawd so existing layout and
 * animation wiring can migrate without touching every caller in this pass.
 */
export function Clawd({
  pose = 'default',
  shimmerStep = 0,
  tentacleFrame = 0,
}: Props): React.ReactNode {
  const posePulse = pose === 'arms-up' ? 2 : pose === 'look-left' ? 1 : 0
  const shift = shimmerStep + tentacleFrame + posePulse

  return (
    <Box flexDirection="column" alignItems="center" width={13} flexShrink={0}>
      {TAU_SIGIL.map((line, index) => (
        <Text key={line}>{auraText(line, shift + index)}</Text>
      ))}
    </Box>
  )
}
