/**
 * Top-level on/off lifecycle: starts the Baileys client, hooks the inbound
 * router, persists state. The React mirror hook (useWhatsAppMirror) handles
 * the outbound side once messages start flowing.
 */

import {
  getClient,
  installCryptoErrorHandler,
  type ClientStatus,
} from './client.js'
import { setPersistedEnabled } from './persistedState.js'
import { startInboundRouter, stopInboundRouter } from './router.js'

let started = false

export async function turnOn(): Promise<void> {
  if (started) return
  started = true
  installCryptoErrorHandler()
  startInboundRouter()
  setPersistedEnabled(true)
  // If pairing just established a connection, don't churn it by reconnecting.
  if (!getClient().isConnected()) {
    await getClient().start()
  }
}

export function turnOff(): void {
  if (!started) {
    setPersistedEnabled(false)
    return
  }
  started = false
  stopInboundRouter()
  getClient().stop()
  setPersistedEnabled(false)
}

export function isOn(): boolean {
  return started
}

export function getStatus(): ClientStatus {
  return getClient().getStatus()
}
