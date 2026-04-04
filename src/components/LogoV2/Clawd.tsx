import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { env } from '../../utils/env.js'

export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right'

type Props = {
  pose?: ClawdPose
}

/**
 * Claudex ghost mascot — a cute pixel ghost with a blue beanie hat.
 * Rendered with Unicode block characters in the terminal.
 *
 * Layout: 3 rows, ~9 cols wide
 *   Row 1: Beanie hat (blue) + top of head (green)
 *   Row 2: Eyes on body (green body, dark eyes)
 *   Row 3: Wavy ghost bottom (green)
 */

// Pose-specific segments for the ghost
type Segments = {
  /** Row 1: hat + head top */
  r1: string
  /** Row 2 left: body with eyes */
  r2L: string
  /** Row 2 eyes: the eye characters */
  r2E: string
  /** Row 2 right: body */
  r2R: string
  /** Row 3: wavy ghost bottom */
  r3: string
}

const POSES: Record<ClawdPose, Segments> = {
  default: {
    r1: ' \u2584\u2588\u2588\u2588\u2584 ',  // ▄███▄  (beanie)
    r2L: '\u2588',
    r2E: '\u25CF \u25CF',       // ● ●  (round eyes)
    r2R: '\u2588',
    r3: '\u2599\u259B \u259C\u259F',  // ▙▛ ▜▟  (wavy bottom)
  },
  'look-left': {
    r1: ' \u2584\u2588\u2588\u2588\u2584 ',
    r2L: '\u2588',
    r2E: '\u25CF\u25CF ',       // ●●   (eyes left)
    r2R: '\u2588',
    r3: '\u2599\u259B \u259C\u259F',
  },
  'look-right': {
    r1: ' \u2584\u2588\u2588\u2588\u2584 ',
    r2L: '\u2588',
    r2E: ' \u25CF\u25CF',       //  ●●  (eyes right)
    r2R: '\u2588',
    r3: '\u2599\u259B \u259C\u259F',
  },
  'arms-up': {
    r1: '\u2597\u2584\u2588\u2588\u2588\u2584\u2596',  // ▗▄███▄▖ (wider with raised sides)
    r2L: '\u2588',
    r2E: '\u25CF \u25CF',
    r2R: '\u2588',
    r3: ' \u2599\u259B\u259C\u259F ',  // wider wavy bottom
  },
}

export function Clawd({ pose = 'default' }: Props): React.ReactNode {
  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalClawd pose={pose} />
  }

  const p = POSES[pose]
  return (
    <Box flexDirection="column">
      {/* Row 1: Beanie hat - uses blue color for the hat portion */}
      <Text>
        <Text color="claudeBlue_FOR_SYSTEM_SPINNER">{p.r1}</Text>
      </Text>
      {/* Row 2: Body with eyes */}
      <Text>
        <Text color="clawd_body">{p.r2L}</Text>
        <Text color="clawd_background" backgroundColor="clawd_body">{p.r2E}</Text>
        <Text color="clawd_body">{p.r2R}</Text>
      </Text>
      {/* Row 3: Wavy ghost bottom */}
      <Text>
        <Text color="clawd_body">{p.r3}</Text>
      </Text>
    </Box>
  )
}

/**
 * Apple Terminal variant — simpler rendering without half-block tricks.
 */
function AppleTerminalClawd({ pose }: { pose: ClawdPose }): React.ReactNode {
  const eyes: Record<ClawdPose, string> = {
    default:    ' o   o ',
    'look-left':  'o   o  ',
    'look-right': '  o   o',
    'arms-up':   ' o   o ',
  }

  return (
    <Box flexDirection="column">
      <Text color="claudeBlue_FOR_SYSTEM_SPINNER">
        {' \u2584\u2588\u2588\u2588\u2584 '}
      </Text>
      <Text>
        <Text color="clawd_body" backgroundColor="clawd_body">{' '}</Text>
        <Text backgroundColor="clawd_body">{eyes[pose]}</Text>
        <Text color="clawd_body" backgroundColor="clawd_body">{' '}</Text>
      </Text>
      <Text color="clawd_body">
        {'\u2599\u259B \u259C\u259F'}
      </Text>
    </Box>
  )
}
