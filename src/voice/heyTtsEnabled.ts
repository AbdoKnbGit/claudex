import { isEnvTruthy } from '../utils/envUtils.js'

export const HEY_TTS_ENV = 'TAU_HEY_TTS'
const LEGACY_HEY_TTS_ENV = 'CLAUDEX_HEY_TTS'

export function isHeyTtsEnabled(): boolean {
  return isEnvTruthy(
    process.env[HEY_TTS_ENV] ?? process.env[LEGACY_HEY_TTS_ENV],
  )
}
