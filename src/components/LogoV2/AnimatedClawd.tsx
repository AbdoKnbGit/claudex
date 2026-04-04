import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box } from '../../ink.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { Clawd, type ClawdPose } from './Clawd.js'

type Frame = {
  pose: ClawdPose
  offset: number
}

/** Hold a pose for n frames (60ms each). */
function hold(pose: ClawdPose, offset: number, frames: number): Frame[] {
  return Array.from({ length: frames }, () => ({ pose, offset }))
}

// Ghost animations
// Jump: crouch (offset 1), spring up with arms-up. Twice.
const GHOST_JUMP: readonly Frame[] = [
  ...hold('default', 1, 2),     // crouch
  ...hold('arms-up', 0, 3),     // spring!
  ...hold('default', 0, 1),
  ...hold('default', 1, 2),     // crouch again
  ...hold('arms-up', 0, 3),     // spring!
  ...hold('default', 0, 1),
]

// Look around: glance right, then left, then back
const GHOST_LOOK: readonly Frame[] = [
  ...hold('look-right', 0, 5),
  ...hold('look-left', 0, 5),
  ...hold('default', 0, 1),
]

// Ghost float: gentle bobbing motion (unique to ghost mascot)
const GHOST_FLOAT: readonly Frame[] = [
  ...hold('default', 0, 3),
  ...hold('default', 1, 2),     // dip down slightly
  ...hold('default', 0, 3),
  ...hold('arms-up', 0, 2),     // bob up with arms
  ...hold('default', 0, 2),
]

const CLICK_ANIMATIONS: readonly (readonly Frame[])[] = [
  GHOST_JUMP,
  GHOST_LOOK,
  GHOST_FLOAT,
]

const IDLE: Frame = { pose: 'default', offset: 0 }
const FRAME_MS = 60
const CLAWD_HEIGHT = 3

/**
 * Claudex ghost with click-triggered animations (jump, look-around, float).
 * Container height is fixed at CLAWD_HEIGHT so surrounding layout never shifts.
 */
export function AnimatedClawd(): React.ReactNode {
  const { pose, bounceOffset, onClick } = useClawdAnimation()

  return (
    <Box height={CLAWD_HEIGHT} flexDirection="column" onClick={onClick}>
      <Box marginTop={bounceOffset} flexShrink={0}>
        <Clawd pose={pose} />
      </Box>
    </Box>
  )
}

function useClawdAnimation(): {
  pose: ClawdPose
  bounceOffset: number
  onClick: () => void
} {
  const [reducedMotion] = useState(
    () => getInitialSettings().prefersReducedMotion ?? false,
  )
  const [frameIndex, setFrameIndex] = useState(-1)
  const animationRef = useRef<readonly Frame[]>(GHOST_JUMP)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (frameIndex < 0 || reducedMotion) return
    const frames = animationRef.current
    if (frameIndex >= frames.length) {
      setFrameIndex(-1)
      return
    }
    timerRef.current = setTimeout(
      () => setFrameIndex((i) => i + 1),
      FRAME_MS,
    )
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [frameIndex, reducedMotion])

  const onClick = () => {
    if (reducedMotion || frameIndex >= 0) return
    // Pick a random animation
    const idx = Math.floor(Math.random() * CLICK_ANIMATIONS.length)
    animationRef.current = CLICK_ANIMATIONS[idx]!
    setFrameIndex(0)
  }

  if (frameIndex < 0 || frameIndex >= animationRef.current.length) {
    return { ...IDLE, onClick }
  }
  const frame = animationRef.current[frameIndex]!
  return { pose: frame.pose, bounceOffset: frame.offset, onClick }
}
