import * as React from 'react'
import { Box, Text } from '../../ink.js'

export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right'

type Props = {
  pose?: ClawdPose
  shimmerStep?: number
  tentacleFrame?: number
}

type Face = {
  leftEye: string
  mouth: string
  rightEye: string
}

const FACES: Record<ClawdPose, Face> = {
  default: { leftEye: '◉', mouth: '‿', rightEye: '◉' },
  'look-left': { leftEye: '◐', mouth: '‿', rightEye: '◐' },
  'look-right': { leftEye: '◑', mouth: '‿', rightEye: '◑' },
  'arms-up': { leftEye: '◉', mouth: '◡', rightEye: '◉' },
}

const HAT_GRADIENT = [
  'rgb(95,160,255)',
  'rgb(130,205,255)',
  'rgb(155,185,255)',
  'rgb(185,150,255)',
] as const

const BODY_GRADIENT = [
  'rgb(105,235,215)',
  'rgb(120,225,175)',
  'rgb(155,235,135)',
  'rgb(215,225,120)',
  'rgb(120,205,255)',
] as const

type GradientColor =
  | (typeof HAT_GRADIENT)[number]
  | (typeof BODY_GRADIENT)[number]

const TENTACLE_PATHS = [
  '╰╮ ╭╯  ',
  ' ╰╮╭╯  ',
  '  ╰╯   ',
  ' ╭╯╰╮  ',
  '╭╯ ╰╮  ',
  '╰╮╰╮╭╯ ',
  ' ╭╯╭╯╰╮',
  '╰╮╭╮╯╰ ',
  ' ╭╯╰╯╮ ',
  '╰╮╭╯╰╮ ',
] as const

function gradientColor(
  colors: readonly GradientColor[],
  index: number,
  shimmerStep: number,
): GradientColor {
  return colors[(index + shimmerStep) % colors.length]!
}

function gradientText(
  text: string,
  colors: readonly GradientColor[],
  shimmerStep: number,
): React.ReactNode {
  return Array.from(text).map((char, index) => (
    <Text key={`${index}-${char}`} color={gradientColor(colors, index, shimmerStep)}>
      {char}
    </Text>
  ))
}

/**
 * Claudex mascot, refined from the original Clawd avatar.
 *
 * This keeps the old ghost/beanie identity, then adds gradient bands and a
 * moving octopus-style tentacle path for the CLI logo.
 */
export function Clawd({
  pose = 'default',
  shimmerStep = 0,
  tentacleFrame = 0,
}: Props): React.ReactNode {
  const face = FACES[pose]
  const crown = pose === 'arms-up' ? '▗▄▄▄▄▄▖' : ' ▗▄▄▄▖ '
  const hatShift = shimmerStep % HAT_GRADIENT.length
  const bodyShift = shimmerStep % BODY_GRADIENT.length
  const tentaclePath =
    TENTACLE_PATHS[tentacleFrame % TENTACLE_PATHS.length]!

  return (
    <Box flexDirection="column" alignItems="center" width={7} flexShrink={0}>
      <Text>{gradientText(crown, HAT_GRADIENT, hatShift)}</Text>
      <Text>
        {gradientText('▟█████▙', HAT_GRADIENT, hatShift + 1)}
      </Text>
      <Text>
        <Text color={gradientColor(HAT_GRADIENT, 0, hatShift)}>▐</Text>
        <Text color="white" backgroundColor="claudeBlue_FOR_SYSTEM_SPINNER">
          ▀▀▀▀▀
        </Text>
        <Text color={gradientColor(HAT_GRADIENT, 5, hatShift)}>▌</Text>
      </Text>
      <Text>
        <Text color={gradientColor(BODY_GRADIENT, 0, bodyShift)}>▐</Text>
        <Text color="clawd_background" backgroundColor="clawd_body">
          {face.leftEye}
        </Text>
        <Text backgroundColor="clawd_body"> </Text>
        <Text color="clawd_background" backgroundColor="clawd_body">
          {face.mouth}
        </Text>
        <Text backgroundColor="clawd_body"> </Text>
        <Text color="clawd_background" backgroundColor="clawd_body">
          {face.rightEye}
        </Text>
        <Text color={gradientColor(BODY_GRADIENT, 4, bodyShift)}>▌</Text>
      </Text>
      <Text>
        <Text color={gradientColor(BODY_GRADIENT, 1, bodyShift)}>▐</Text>
        <Text color="rgb(195,255,225)" backgroundColor="clawd_body">
          ▄
        </Text>
        <Text backgroundColor="clawd_body">   </Text>
        <Text color="rgb(80,185,155)" backgroundColor="clawd_body">
          ▄
        </Text>
        <Text color={gradientColor(BODY_GRADIENT, 5, bodyShift)}>▌</Text>
      </Text>
      <Text>{gradientText(tentaclePath, BODY_GRADIENT, bodyShift + 1)}</Text>
    </Box>
  )
}
