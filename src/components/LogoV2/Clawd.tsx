import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { env } from '../../utils/env.js'

export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right'

type Props = {
  pose?: ClawdPose
}

/**
 * Claudex ghost mascot — a 5-row kawaii pixel ghost with a blue beanie,
 * white headband, mint body, sparkly eyes, blush cheeks and a little smile.
 *
 * Layout: 5 rows × 7 cols
 *   Row 1: Beanie crown (blue)
 *   Row 2: Beanie body  (blue)
 *   Row 3: White headband (white on blue)
 *   Row 4: Face — eyes and mouth on a mint body (mint + dark features)
 *   Row 5: Wavy ghost bottom (mint)
 *
 * Each cell is a single monospace column. Rows are rendered as Ink <Text>
 * with nested <Text> children so per-character colors work everywhere.
 */

// Pose-specific face content. The structure is:
//   [leftBody, eyeL, gap, mouth, gap, eyeR, rightBody]
// so that swapping eye positions gives us look-left / look-right poses
// without changing the body silhouette.
type Face = {
  leftBody: string
  c1: string
  c2: string
  c3: string
  c4: string
  c5: string
  rightBody: string
}

// default look: two round kawaii eyes with a soft smile between them
const DEFAULT_FACE: Face = {
  leftBody: '\u2590',        // ▐  (mint body edge)
  c1: '\u25C9',              // ◉  (left eye, dark)
  c2: ' ',                   //    (mint interior)
  c3: '\u02D3',              // ˓  (mouth — swapped below)
  c4: ' ',                   //    (mint interior)
  c5: '\u25C9',              // ◉  (right eye, dark)
  rightBody: '\u258C',       // ▌  (mint body edge)
}

const POSE_FACES: Record<ClawdPose, Face> = {
  default: {
    ...DEFAULT_FACE,
    c3: '\u203F', // ‿  undertie — subtle smile
  },
  'look-left': {
    ...DEFAULT_FACE,
    // Shift both eyes one cell to the left: c1,c2 → eyes, c4,c5 → empty
    c1: '\u25C9',
    c2: '\u25C9',
    c3: '\u203F',
    c4: ' ',
    c5: ' ',
  },
  'look-right': {
    ...DEFAULT_FACE,
    c1: ' ',
    c2: ' ',
    c3: '\u203F',
    c4: '\u25C9',
    c5: '\u25C9',
  },
  'arms-up': {
    ...DEFAULT_FACE,
    // Excited pose — round sparkly eyes, wider open mouth
    c1: '\u25C9',
    c3: '\u25E1', // ◡  wider smile
    c5: '\u25C9',
  },
}

// Beanie / body silhouette — shared by all poses.
// arms-up uses a subtly wider beanie crown so the animation reads as
// "pop up" without needing new face geometry.
const ROW1_DEFAULT = ' \u2597\u2584\u2584\u2584\u2596 ' // ' ▗▄▄▄▖ '
const ROW1_WIDE    = '\u2597\u2584\u2584\u2584\u2584\u2584\u2596' // '▗▄▄▄▄▄▖'

const ROW2 = '\u259F\u2588\u2588\u2588\u2588\u2588\u2599' // ▟█████▙
const ROW3 = '\u2580\u2580\u2580\u2580\u2580\u2580\u2580' // ▀▀▀▀▀▀▀   (white headband)
// Wavy bottom — soft scalloped edge
const ROW5 = '\u2599\u2580\u2580\u2580\u2580\u2580\u259F' // ▙▀▀▀▀▀▟

export function Clawd({ pose = 'default' }: Props): React.ReactNode {
  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalClawd pose={pose} />
  }

  const face = POSE_FACES[pose]
  const row1 = pose === 'arms-up' ? ROW1_WIDE : ROW1_DEFAULT

  return (
    <Box flexDirection="column">
      {/* Row 1: beanie crown (blue) */}
      <Text>
        <Text color="claudeBlue_FOR_SYSTEM_SPINNER">{row1}</Text>
      </Text>
      {/* Row 2: beanie body (blue) */}
      <Text>
        <Text color="claudeBlue_FOR_SYSTEM_SPINNER">{ROW2}</Text>
      </Text>
      {/* Row 3: white headband */}
      <Text>
        <Text color="white" backgroundColor="claudeBlue_FOR_SYSTEM_SPINNER">
          {ROW3}
        </Text>
      </Text>
      {/* Row 4: face — mint body with dark features */}
      <Text>
        <Text color="clawd_body">{face.leftBody}</Text>
        <Text color="clawd_background" backgroundColor="clawd_body">
          {face.c1}
        </Text>
        <Text backgroundColor="clawd_body"> </Text>
        <Text color="clawd_background" backgroundColor="clawd_body">
          {face.c3}
        </Text>
        <Text backgroundColor="clawd_body"> </Text>
        <Text color="clawd_background" backgroundColor="clawd_body">
          {face.c5}
        </Text>
        <Text color="clawd_body">{face.rightBody}</Text>
      </Text>
      {/* Row 5: wavy ghost bottom (mint) */}
      <Text>
        <Text color="clawd_body">{ROW5}</Text>
      </Text>
    </Box>
  )
}

/**
 * Apple Terminal variant — some glyphs render oddly in Apple Terminal,
 * so we fall back to a simpler version that relies less on half-blocks
 * and sub-cell positioning.
 */
function AppleTerminalClawd({ pose }: { pose: ClawdPose }): React.ReactNode {
  const eyes: Record<ClawdPose, string> = {
    default:      ' \u25C9 \u203F \u25C9 ',
    'look-left':  ' \u25C9\u25C9\u203F   ',
    'look-right': '   \u203F\u25C9\u25C9 ',
    'arms-up':    ' \u25C9 \u25E1 \u25C9 ',
  }

  return (
    <Box flexDirection="column">
      <Text color="claudeBlue_FOR_SYSTEM_SPINNER">
        {' \u2584\u2584\u2584\u2584\u2584 '}
      </Text>
      <Text color="claudeBlue_FOR_SYSTEM_SPINNER">
        {'\u2588\u2588\u2588\u2588\u2588\u2588\u2588'}
      </Text>
      <Text color="white" backgroundColor="claudeBlue_FOR_SYSTEM_SPINNER">
        {'\u2580\u2580\u2580\u2580\u2580\u2580\u2580'}
      </Text>
      <Text>
        <Text color="clawd_body">{' '}</Text>
        <Text backgroundColor="clawd_body">{eyes[pose]}</Text>
        <Text color="clawd_body">{' '}</Text>
      </Text>
      <Text color="clawd_body">
        {'\u2580\u2580\u2580\u2580\u2580\u2580\u2580'}
      </Text>
    </Box>
  )
}
