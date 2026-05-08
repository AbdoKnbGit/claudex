import { readFileSync, renameSync, writeFileSync } from 'fs'
import { getAccessFile } from './paths.js'

export type AccessConfig = {
  allowFrom: string[]
  allowGroups: boolean
  allowedGroups: string[]
  requireAllowFromInGroups: boolean
}

export function defaultAccess(): AccessConfig {
  return {
    allowFrom: [],
    allowGroups: false,
    allowedGroups: [],
    requireAllowFromInGroups: false,
  }
}

export function loadAccess(): AccessConfig {
  const file = getAccessFile()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { ...defaultAccess(), ...parsed }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* ignore */
    }
    return defaultAccess()
  }
}

export function saveAccess(cfg: AccessConfig): void {
  writeFileSync(getAccessFile(), JSON.stringify(cfg, null, 2))
}

export function toJid(phone: string): string {
  if (phone.includes('@')) return phone
  return `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`
}

export function isAllowed(jid: string, participant?: string): boolean {
  const access = loadAccess()
  const isGroup = jid.endsWith('@g.us')
  if (isGroup) {
    if (!access.allowGroups) return false
    if (
      access.allowedGroups.length > 0 &&
      !access.allowedGroups.includes(jid)
    ) {
      return false
    }
    if (access.requireAllowFromInGroups && participant) {
      return access.allowFrom.some(
        a => toJid(a) === participant || a === participant,
      )
    }
    return true
  }
  if (access.allowFrom.length === 0) return true
  return access.allowFrom.some(a => toJid(a) === jid || a === jid)
}
