import type { Command } from '../../commands.js'

const report = {
  type: 'local',
  name: 'report',
  description: 'Generate a readable final session report',
  argumentHint: '<markdown|html|pdf> [filename]',
  supportsNonInteractive: true,
  load: () => import('./report.js'),
} satisfies Command

export default report
