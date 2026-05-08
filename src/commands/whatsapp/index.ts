import type { Command } from '../../commands.js'

const whatsapp = {
  type: 'local-jsx',
  name: 'whatsapp',
  description: 'Chat with Tau via WhatsApp (on/off/login)',
  argumentHint: '[on|off|login|status]',
  isSensitive: false,
  load: () => import('./whatsapp.js'),
} satisfies Command

export default whatsapp
