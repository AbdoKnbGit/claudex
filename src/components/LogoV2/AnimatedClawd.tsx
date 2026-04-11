import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box } from '../../ink.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { Clawd, type ClawdPose } from './Clawd.js'

type Frame = {
  pose: ClawdPose
  offset: number
}

/** Hold a pose for n frames (FRAME_MS each). */
function hold(pose: ClawdPose, offset: number, frames: number): Frame[] {
  return Array.from({ length: frames }, () => ({ pose, offset }))
}

// Ghost animations — smoother/longer frames for a more polished feel.
// Jump: crouch, spring up with arms-up. Twice.
const GHOST_JUMP: readonly Frame[] = [
  ...hold('default', 1, 3),     // crouch (linger)
  ...hold('arms-up', 0, 4),     // spring!
  ...hold('default', 0, 2),
  ...hold('default', 1, 3),     // crouch again
  ...hold('arms-up', 0, 4),     // spring!
  ...hold('default', 0, 2),
]

// Look around: smoothly glance right, pause, then left, pause, then back
const GHOST_LOOK: readonly Frame[] = [
  ...hold('default', 0, 2),
  ...hold('look-right', 0, 6),
  ...hold('default', 0, 2),
  ...hold('look-left', 0, 6),
  ...hold('default', 0, 2),
]

// Ghost float: gentle bobbing motion (unique to ghost mascot)
const GHOST_FLOAT: readonly Frame[] = [
  ...hold('default', 0, 4),
  ...hold('default', 1, 3),     // dip down slightly
  ...hold('default', 0, 4),
  ...hold('arms-up', 0, 3),     // bob up with arms
  ...hold('default', 0, 3),
]

const CLICK_ANIMATIONS: readonly (readonly Frame[])[] = [
  GHOST_JUMP,
  GHOST_LOOK,
  GHOST_FLOAT,
]

const IDLE: Frame = { pose: 'default', offset: 0 }
const FRAME_MS = 70
// Idle bob: every IDLE_BOB_MS, alternate between offset 0 and 1 so the ghost
// gently hovers when nothing else is happening. Long enough that it feels
// alive without being distracting.
const IDLE_BOB_MS = 1400
// Height accommodates the 5-row kawaii ghost plus one cell of headroom
// for the bob animation so the row above never clips.
const CLAWD_HEIGHT = 6

/**
 * Claudex ghost with click-triggered animations (jump, look-around, float)
 * plus a subtle idle hover when at rest.
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
  const [idleTick, setIdleTick] = useState(0)
  const animationRef = useRef<readonly Frame[]>(GHOST_JUMP)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Click-driven animation loop
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

  // Idle hover — gentle bob when no click animation is running
  useEffect(() => {
    if (reducedMotion || frameIndex >= 0) return
    idleTimerRef.current = setInterval(() => {
      setIdleTick((t) => (t + 1) % 2)
    }, IDLE_BOB_MS)
    return () => {
      if (idleTimerRef.current) clearInterval(idleTimerRef.current)
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
    // Idle hover: alternate offset 0 / 1 every IDLE_BOB_MS
    const bounceOffset = reducedMotion ? 0 : idleTick === 0 ? 0 : 1
    return { pose: IDLE.pose, bounceOffset, onClick }
  }
  const frame = animationRef.current[frameIndex]!
  return { pose: frame.pose, bounceOffset: frame.offset, onClick }
}
