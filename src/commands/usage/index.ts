import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show provider usage and billing',
  load: () => import('./usage.js'),
} satisfies Command
