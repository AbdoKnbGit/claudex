import { getClient } from './client.js'

type WhatsAppPermissionResponse = {
  behavior: 'allow' | 'deny'
  fromJid: string
}

type PendingPermission = {
  jid: string
  handler: (response: WhatsAppPermissionResponse) => void
}

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

const pendingPermissions = new Map<string, PendingPermission>()

export function onWhatsAppPermissionResponse(
  requestId: string,
  jid: string,
  handler: (response: WhatsAppPermissionResponse) => void,
): () => void {
  const key = requestId.toLowerCase()
  pendingPermissions.set(key, { jid, handler })
  return () => {
    pendingPermissions.delete(key)
  }
}

export function tryConsumeWhatsAppPermissionReply(
  jid: string,
  text: string,
): boolean {
  const match = PERMISSION_REPLY_RE.exec(text)
  if (!match) return false

  const key = match[2]!.toLowerCase()
  const pending = pendingPermissions.get(key)
  if (!pending || pending.jid !== jid) return false

  pendingPermissions.delete(key)
  pending.handler({
    behavior: match[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
    fromJid: jid,
  })
  return true
}

export async function sendWhatsAppPermissionRequest({
  jid,
  requestId,
  toolName,
  description,
  inputPreview,
}: {
  jid: string
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}): Promise<void> {
  const lines = [
    `Permission required (${requestId})`,
    `Tool: ${toolName}`,
    description,
    inputPreview ? `Input: ${inputPreview}` : undefined,
    `Reply "yes ${requestId}" to allow or "no ${requestId}" to deny.`,
  ].filter((line): line is string => Boolean(line))

  await getClient().sendText(jid, lines.join('\n\n'))
}

export type { WhatsAppPermissionResponse }
