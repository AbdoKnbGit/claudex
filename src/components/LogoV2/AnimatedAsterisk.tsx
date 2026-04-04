import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { TEARDROP_ASTERISK } from '../../constants/figures.js'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { toRGBColor } from '../Spinner/utils.js'

const SWEEP_DURATION_MS = 1500
const SWEEP_COUNT = 2
const TOTAL_ANIMATION_MS = SWEEP_DURATION_MS * SWEEP_COUNT

// Settled color: soft green matching Claudex theme
const SETTLED_COLOR = toRGBColor({ r: 140, g: 200, b: 140 })

/**
 * Claudex gradient: purple -> blue -> green
 * Maps a 0-1 progress value to an RGB color along the gradient.
 */
function claudexGradient(t: number): { r: number; g: number; b: number } {
  // 3-stop gradient: purple (0) -> blue (0.5) -> green (1.0)
  if (t < 0.5) {
    // Purple to Blue
    const p = t * 2 // 0..1 within this segment
    return {
      r: Math.round(180 * (1 - p) + 130 * p),   // 180 -> 130
      g: Math.round(120 * (1 - p) + 165 * p),   // 120 -> 165
      b: Math.round(220 * (1 - p) + 210 * p),   // 220 -> 210
    }
  } else {
    // Blue to Green
    const p = (t - 0.5) * 2 // 0..1 within this segment
    return {
      r: Math.round(130 * (1 - p) + 140 * p),   // 130 -> 140
      g: Math.round(165 * (1 - p) + 210 * p),   // 165 -> 210
      b: Math.round(210 * (1 - p) + 140 * p),   // 210 -> 140
    }
  }
}

export function AnimatedAsterisk({
  char = TEARDROP_ASTERISK,
}: {
  char?: string
}): React.ReactNode {
  const [reducedMotion] = useState(
    () => getInitialSettings().prefersReducedMotion ?? false,
  )
  const [done, setDone] = useState(reducedMotion)
  const startTimeRef = useRef<number | null>(null)
  const [ref, time] = useAnimationFrame(done ? null : 50)

  useEffect(() => {
    if (done) return
    const t = setTimeout(setDone, TOTAL_ANIMATION_MS, true)
    return () => clearTimeout(t)
  }, [done])

  if (done) {
    return (
      <Box ref={ref}>
        <Text color={SETTLED_COLOR}>{char}</Text>
      </Box>
    )
  }

  if (startTimeRef.current === null) {
    startTimeRef.current = time
  }
  const elapsed = time - startTimeRef.current
  // Cycle through the gradient: 0->1 per sweep
  const progress = (elapsed / SWEEP_DURATION_MS) % 1
  const rgb = claudexGradient(progress)

  return (
    <Box ref={ref}>
      <Text color={toRGBColor(rgb)}>{char}</Text>
    </Box>
  )
}
