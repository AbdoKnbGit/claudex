import type { Command } from '../../commands.js'

const statistics = {
  type: 'local',
  name: 'statistics',
  description: 'Show current session statistics',
  supportsNonInteractive: true,
  load: () => import('./statistics.js'),
} satisfies Command

export default statistics
