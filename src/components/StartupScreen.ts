/**
 * Tau startup screen: dark terminal base with ember red and brown glow.
 * Called once at CLI startup before the Ink UI renders.
 */

declare const MACRO: { VERSION: string }

const ESC = '\x1b['
const RESET = `${ESC}0m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`

type RGB = [number, number, number]
const rgb = (r: number, g: number, b: number): string =>
  `${ESC}38;2;${r};${g};${b}m`
const bg = (r: number, g: number, b: number): string =>
  `${ESC}48;2;${r};${g};${b}m`

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

function paintLineDiagonal(
  text: string,
  stops: readonly RGB[],
  lineT: number,
): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const horizontal = text.length > 1 ? i / (text.length - 1) : 0
    const t = lineT * 0.42 + horizontal * 0.58
    const [r, g, b] = gradAt(stops, t)
    out += `${bg(...BASE)}${rgb(r, g, b)}${text[i]}`
  }
  return out + RESET
}

const BASE: RGB = [9, 5, 4]
const TAU_GLOW: readonly RGB[] = [
  [255, 96, 72],
  [238, 58, 48],
  [184, 70, 42],
  [112, 54, 36],
  [190, 75, 42],
  [255, 122, 76],
]

const ACCENT: RGB = [255, 86, 66]
const CREAM: RGB = [246, 238, 226]
const DIMCOL: RGB = [143, 102, 84]
const BORDER: RGB = [111, 50, 36]
const AMBER: RGB = [225, 136, 70]

const LOGO: readonly string[] = [
  '       ████████╗ █████╗ ██╗   ██╗',
  '       ╚══██╔══╝██╔══██╗██║   ██║',
  '          ██║   ███████║██║   ██║',
  '          ██║   ██╔══██║██║   ██║',
  '          ██║   ██║  ██║╚██████╔╝',
  '          ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ',
]

function boxRow(content: string, width: number, rawLen: number): string {
  const pad = Math.max(0, width - 2 - rawLen)
  return `${rgb(...BORDER)}\u2502${RESET}${content}${' '.repeat(pad)}${rgb(...BORDER)}\u2502${RESET}`
}

export function printStartupScreen(): void {
  if (process.env.CI || !process.stdout.isTTY) return
  if (process.argv.includes('-p') || process.argv.includes('--print')) return
  if (process.env.NO_COLOR || process.env.TERM === 'dumb') return

  const W = 58
  const out: string[] = []

  out.push('')

  for (let i = 0; i < LOGO.length; i++) {
    const lineT = LOGO.length > 1 ? i / (LOGO.length - 1) : 0
    out.push(paintLineDiagonal(LOGO[i]!, TAU_GLOW, lineT))
  }

  out.push('')

  const ember = `${rgb(...ACCENT)}\u25c6${RESET}`
  const dot = `${rgb(...BORDER)}\u2022${RESET}`
  const taglineParts = [
    `${rgb(...ACCENT)}Tau${RESET}`,
    `${rgb(...AMBER)}dark terminal${RESET}`,
    `${rgb(188, 82, 50)}multi-provider${RESET}`,
    `${rgb(...CREAM)}AI coding CLI${RESET}`,
  ]
  out.push(
    `  ${ember} ${BOLD}${taglineParts[0]}${RESET} ${dot} ` +
      `${BOLD}${taglineParts[1]}${RESET} ${dot} ` +
      `${BOLD}${taglineParts[2]} ${taglineParts[3]}${RESET} ${ember}`,
  )

  out.push('')
  out.push(`${rgb(...BORDER)}\u2554${'\u2550'.repeat(W - 2)}\u2557${RESET}`)

  const leftContent =
    ` ${rgb(...ACCENT)}\u25cf${RESET} ${rgb(...CREAM)}Ready${RESET} ` +
    `${DIM}${rgb(...DIMCOL)}- type${RESET} ${rgb(...AMBER)}/help${RESET} ` +
    `${DIM}${rgb(...DIMCOL)}to begin${RESET}`
  const leftLen = ' \u25cf Ready - type /help to begin'.length
  out.push(boxRow(leftContent, W, leftLen))

  out.push(`${rgb(...BORDER)}\u255a${'\u2550'.repeat(W - 2)}\u255d${RESET}`)
  out.push(
    `  ${DIM}${rgb(...DIMCOL)}tau${RESET} ` +
      `${rgb(...ACCENT)}v${rgb(...AMBER)}${MACRO.VERSION}${RESET}`,
  )
  out.push('')

  process.stdout.write(out.join('\n') + '\n')
}
