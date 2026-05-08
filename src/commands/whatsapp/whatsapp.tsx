import { toString as qrToString } from 'qrcode'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text, useInput } from '../../ink.js'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  getClient,
  type ClientStatus,
} from '../../services/whatsapp/client.js'
import {
  getStatus,
  isOn,
  turnOff,
  turnOn,
} from '../../services/whatsapp/lifecycle.js'
import { getAuthDir } from '../../services/whatsapp/paths.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

function isPaired(): boolean {
  return existsSync(join(getAuthDir(), 'creds.json'))
}

export const call: LocalJSXCommandCall = async (
  onDone,
  _context,
  args = '',
) => {
  const trimmed = args.trim()
  const sub = (trimmed.split(/\s+/)[0] ?? '').toLowerCase()

  if (sub === 'status') {
    const s = getStatus()
    const paired = isPaired() ? 'paired' : 'not paired'
    onDone(`whatsapp: ${isOn() ? 'on' : 'off'} · ${s} · ${paired}`)
    return null
  }

  if (sub === 'off') {
    turnOff()
    onDone('whatsapp: off')
    return null
  }

  if (sub === 'on') {
    if (!isPaired()) return <Pairing onDone={onDone} />
    return <TurnOn onDone={onDone} />
  }

  if (sub === 'login') {
    return <Pairing onDone={onDone} />
  }

  return <Menu onDone={onDone} />
}

// ─── Menu ────────────────────────────────────────────────────────────

type MenuItem = 'login' | 'on' | 'off' | 'cancel'

function Menu({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const [chosen, setChosen] = useState<MenuItem | null>(null)
  const [idx, setIdx] = useState(0)
  const paired = isPaired()
  const on = isOn()
  const status = getStatus()

  const items: { id: MenuItem; label: string }[] = []
  if (!paired) {
    items.push({ id: 'login', label: 'Login (scan QR with your phone)' })
  } else {
    if (on) items.push({ id: 'off', label: 'Turn off' })
    else items.push({ id: 'on', label: 'Turn on' })
    items.push({ id: 'login', label: 'Re-login (re-pair this device)' })
  }
  items.push({ id: 'cancel', label: 'Cancel' })

  useInput((_input, key) => {
    if (chosen) return
    if (key.escape) {
      onDone('')
      return
    }
    if (key.upArrow) {
      setIdx(i => (i > 0 ? i - 1 : items.length - 1))
      return
    }
    if (key.downArrow) {
      setIdx(i => (i < items.length - 1 ? i + 1 : 0))
      return
    }
    if (key.return) {
      const item = items[idx]
      if (item) setChosen(item.id)
    }
  })

  if (chosen === 'cancel') {
    onDone('')
    return null
  }
  if (chosen === 'off') {
    turnOff()
    onDone('whatsapp: off')
    return null
  }
  if (chosen === 'on') {
    return <TurnOn onDone={onDone} />
  }
  if (chosen === 'login') {
    return <Pairing onDone={onDone} />
  }

  return (
    <Dialog title="WhatsApp" onCancel={() => onDone('')} color="permission">
      <Box flexDirection="column" paddingLeft={1}>
        <Text dimColor>
          Status: <Text color="suggestion">{on ? 'on' : 'off'}</Text> ·{' '}
          {status} · {paired ? 'paired' : 'not paired'}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {items.map((it, i) => (
            <Text key={it.id} color={i === idx ? 'permission' : undefined}>
              {i === idx ? '› ' : '  '}
              {it.label}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑/↓ to move · Enter to select · Esc to cancel</Text>
        </Box>
      </Box>
    </Dialog>
  )
}

// ─── Turn on ─────────────────────────────────────────────────────────

function TurnOn({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const [status, setStatus] = useState<ClientStatus>(getStatus())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unsub = getClient().onStatus(setStatus)
    void turnOn().catch(err => setError(String(err)))
    return () => {
      unsub()
    }
  }, [])

  useEffect(() => {
    if (status === 'connected') {
      const t = setTimeout(() => onDone('whatsapp: connected'), 600)
      return () => clearTimeout(t)
    }
  }, [status, onDone])

  useInput((_input, key) => {
    if (key.escape) onDone('')
  })

  return (
    <Dialog title="WhatsApp · turning on" onCancel={() => onDone('')} color="permission">
      <Box flexDirection="column" paddingLeft={1}>
        <Text>
          Status: <Text color="suggestion">{status}</Text>
        </Text>
        {error && (
          <Box marginTop={1}>
            <Text color="error">Error: {error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Esc to close (it keeps trying in the background)</Text>
        </Box>
      </Box>
    </Dialog>
  )
}

// ─── Pairing (QR only) ───────────────────────────────────────────────

function Pairing({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const [qrAscii, setQrAscii] = useState('')
  const [status, setStatus] = useState<ClientStatus>(getStatus())
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const client = getClient()
    const unsubStatus = client.onStatus(setStatus)
    const unsubQR = client.onQR(qr => {
      qrToString(qr, { type: 'utf8', errorCorrectionLevel: 'L' })
        .then(ascii => {
          if (!ascii || ascii.length === 0) {
            setError('QR rendered empty (terminal too narrow?)')
            return
          }
          setQrAscii(ascii)
        })
        .catch(err => {
          setError(`QR render failed: ${err?.message ?? err}`)
        })
    })
    client
      .startPairing(undefined)
      .then(({ error: e }) => {
        if (e) setError(e)
      })
      .catch(err => setError(String(err?.message ?? err)))
    return () => {
      unsubStatus()
      unsubQR()
    }
  }, [])

  useEffect(() => {
    if (status === 'connected' && !done) {
      setDone(true)
      ;(async () => {
        await turnOn().catch(() => {})
        setTimeout(() => onDone('whatsapp: paired'), 800)
      })()
    }
  }, [status, done, onDone])

  useEffect(() => {
    if (status === 'logged-out' && !done) {
      setError(
        'WhatsApp rejected the connection. Likely rate-limit — wait ~1h then try /whatsapp login again.',
      )
    }
  }, [status, done])

  useInput((_input, key) => {
    if (key.escape) {
      getClient().stop()
      onDone('')
    }
  })

  if (done) {
    return (
      <Dialog title="WhatsApp · paired" onCancel={() => onDone('')} color="permission">
        <Box flexDirection="column" paddingLeft={1}>
          <Text color="success">Paired successfully.</Text>
          <Text dimColor>Closing…</Text>
        </Box>
      </Dialog>
    )
  }

  const lines = qrAscii.split('\n').filter(l => l.length > 0)
  return (
    <Dialog
      title="WhatsApp · scan this QR with your phone"
      onCancel={() => onDone('')}
      color="permission"
    >
      <Box flexDirection="column" paddingLeft={1}>
        <Text dimColor>
          On your phone: WhatsApp → Linked Devices → Link a Device → scan.
        </Text>
        <Box marginTop={1} flexDirection="column">
          {lines.length === 0 ? (
            <Text dimColor>Generating QR…</Text>
          ) : (
            lines.map((line, i) => <Text key={i}>{line}</Text>)
          )}
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="error">{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Status: {status} · Esc to cancel</Text>
        </Box>
      </Box>
    </Dialog>
  )
}
