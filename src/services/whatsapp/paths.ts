import { existsSync, mkdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export function getWhatsAppDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(base, 'whatsapp')
}

export function getAuthDir(): string {
  return join(getWhatsAppDir(), 'auth')
}

export function getInboxDir(): string {
  return join(getWhatsAppDir(), 'inbox')
}

export function getAccessFile(): string {
  return join(getWhatsAppDir(), 'access.json')
}

export function getStateFile(): string {
  return join(getWhatsAppDir(), 'state.json')
}

export function ensureWhatsAppDirs(): void {
  mkdirSync(getAuthDir(), { recursive: true, mode: 0o700 })
  mkdirSync(getInboxDir(), { recursive: true })
}

/**
 * Wipe the auth directory and recreate it empty. Used at the start of every
 * pair flow so a half-finished previous attempt can never poison the next
 * one (the most common cause of Baileys returning 401 / logged-out before
 * the QR can be scanned).
 */
export function clearAuthDir(): void {
  const dir = getAuthDir()
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch {
    /* if rm fails the next mkdir might still succeed; don't block */
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}
