/**
 * Claudex startup screen — block-text logo with a full-RGB rainbow gradient.
 * Called once at CLI startup before the Ink UI renders.
 * Writes directly to process.stdout so the user sees immediate visual feedback.
 *
 * The previous version used a blue-only gradient. We upgrade to a fluid
 * rainbow that sweeps horizontally across the letters AND vertically across
 * the rows, so every cell gets its own colour. On a wide-gamut terminal this
 * reads as "full RGB", not "blue".
 */

declare const MACRO: { VERSION: string }

const ESC = '\x1b['
const RESET = `${ESC}0m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`

type RGB = [number, number, number]
const rgb = (r: number, g: number, b: number): string =>
  `${ESC}38;2;${r};${g};${b}m`

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

function gradAt(stops: readonly RGB[], t: number): RGB {
  const c = Math.max(0, Math.min(1, t))
  const s = c * (stops.length - 1)
  const i = Math.floor(s)
  if (i >= stops.length - 1) return stops[stops.length - 1]!
  return lerp(stops[i]!, stops[i + 1]!, s - i)
}

/**
 * Paint a line with a diagonal rainbow:
 *  - lineT selects where this row sits in the vertical rainbow
 *  - each character advances the horizontal rainbow offset
 * The sum of the two is taken mod 1, so every cell samples a unique hue.
 */
function paintLineDiagonal(
  text: string,
  stops: readonly RGB[],
  lineT: number,
): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const horizontal = text.length > 1 ? i / (text.length - 1) : 0
    const t = ((lineT * 0.35) + (horizontal * 0.65)) % 1
    const [r, g, b] = gradAt(stops, t)
    out += `${rgb(r, g, b)}${text[i]}`
  }
  return out + RESET
}

// ─── Colours ──────────────────────────────────────────────────────────────────
//
// Full-spectrum rainbow, tuned for visibility on both dark and light terminals.
// The stops are roughly: red → orange → yellow → green → teal → blue → violet
// → magenta → back to red (the wraparound keeps the gradient seamless when we
// take the character offset modulo 1).

const RAINBOW: readonly RGB[] = [
  [255,  80,  95],  // coral red
  [255, 145,  60],  // orange
  [255, 210,  70],  // yellow
  [110, 230, 120],  // green
  [ 70, 210, 210],  // teal
  [ 80, 150, 255],  // sky blue
  [150, 110, 255],  // indigo
  [215,  95, 230],  // magenta
  [255,  80,  95],  // wrap → coral red
]

const ACCENT: RGB = [150, 220, 255]
const CREAM:  RGB = [235, 235, 245]
const DIMCOL: RGB = [120, 120, 145]
const BORDER: RGB = [ 90, 110, 170]

// ─── Block Text Logo ─────────────────────────────────────────────────────────
//
// 6-row block-text "CLAUDEX" in the ANSI Shadow figlet font. Each row is 57
// cells wide + 2 leading spaces = 59 cells of monospace output. Letters are
// concatenated with no inter-letter gap, same as the standard figlet output.

const LOGO: readonly string[] = [
  `   ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗██╗  ██╗`,
  `  ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝╚██╗██╔╝`,
  `  ██║     ██║     ███████║██║   ██║██║  ██║█████╗   ╚███╔╝ `,
  `  ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝   ██╔██╗ `,
  `  ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗██╔╝ ██╗`,
  `   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝`,
]

// ─── Box drawing ──────────────────────────────────────────────────────────────

function boxRow(content: string, width: number, rawLen: number): string {
  const pad = Math.max(0, width - 2 - rawLen)
  return `${rgb(...BORDER)}\u2502${RESET}${content}${' '.repeat(pad)}${rgb(...BORDER)}\u2502${RESET}`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function printStartupScreen(): void {
  // Skip in non-interactive / CI / print mode — nothing to show there.
  if (process.env.CI || !process.stdout.isTTY) return
  if (process.argv.includes('-p') || process.argv.includes('--print')) return

  // Respect NO_COLOR / dumb terminals — they can't render 24-bit colour so
  // a gradient degrades to nothing useful.
  if (process.env.NO_COLOR || process.env.TERM === 'dumb') return

  const W = 58
  const out: string[] = []

  out.push('')

  // Paint the logo with the diagonal rainbow sweep.
  const total = LOGO.length
  for (let i = 0; i < total; i++) {
    const lineT = total > 1 ? i / (total - 1) : 0
    out.push(paintLineDiagonal(LOGO[i]!, RAINBOW, lineT))
  }

  out.push('')

  // Tagline with sparkle accents and rainbow-tinted punctuation.
  const sparkle = `${rgb(...ACCENT)}\u2726${RESET}`
  const dot = `${rgb(215, 95, 230)}\u2022${RESET}`
  const taglineParts = [
    `${rgb(255, 145, 60)}multi-provider${RESET}`,
    `${rgb(110, 230, 120)}local`,
    `${rgb(70, 210, 210)}\u00b7`,
    `${rgb(80, 150, 255)}cloud`,
    `${rgb(150, 110, 255)}\u00b7`,
    `${rgb(215, 95, 230)}claude${RESET}`,
    `${rgb(255, 210, 70)}AI coding CLI${RESET}`,
  ]
  out.push(
    `  ${sparkle} ${BOLD}${taglineParts.slice(0, 1).join(' ')}${RESET} ${dot} ` +
      `${BOLD}${taglineParts.slice(1, 6).join(' ')}${RESET} ${dot} ` +
      `${BOLD}${taglineParts.slice(6).join(' ')}${RESET} ${sparkle}`,
  )

  out.push('')

  // Info box — "Ready" status line with version on the right.
  out.push(`${rgb(...BORDER)}\u2554${'\u2550'.repeat(W - 2)}\u2557${RESET}`)

  const leftContent =
    ` ${rgb(110, 230, 120)}\u25cf${RESET} ${rgb(...CREAM)}Ready${RESET} ` +
    `${DIM}${rgb(...DIMCOL)}\u2014 type${RESET} ${rgb(...ACCENT)}/help${RESET} ` +
    `${DIM}${rgb(...DIMCOL)}to begin${RESET}`
  const leftLen = ' \u25cf Ready \u2014 type /help to begin'.length
  out.push(boxRow(leftContent, W, leftLen))

  out.push(`${rgb(...BORDER)}\u255a${'\u2550'.repeat(W - 2)}\u255d${RESET}`)

  // Version footer, RGB-accented.
  out.push(
    `  ${DIM}${rgb(...DIMCOL)}claudex${RESET} ` +
      `${rgb(255, 145, 60)}v${rgb(255, 210, 70)}${MACRO.VERSION}${RESET}`,
  )

  out.push('')

  process.stdout.write(out.join('\n') + '\n')
}
