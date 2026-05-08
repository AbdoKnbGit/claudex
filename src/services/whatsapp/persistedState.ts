import { existsSync, readFileSync, writeFileSync } from 'fs'
import { ensureWhatsAppDirs, getStateFile } from './paths.js'

type PersistedState = {
  enabled: boolean
}

const DEFAULT: PersistedState = { enabled: false }

export function readPersistedState(): PersistedState {
  try {
    const file = getStateFile()
    if (!existsSync(file)) return DEFAULT
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { ...DEFAULT, ...parsed }
  } catch {
    return DEFAULT
  }
}

export function writePersistedState(s: PersistedState): void {
  ensureWhatsAppDirs()
  writeFileSync(getStateFile(), JSON.stringify(s, null, 2))
}

export function setPersistedEnabled(enabled: boolean): void {
  const cur = readPersistedState()
  writePersistedState({ ...cur, enabled })
}
