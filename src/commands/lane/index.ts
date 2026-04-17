import type { Command } from '../../commands.js'

const lane = {
  type: 'local',
  name: 'lane',
  description: 'Inspect native-lane routing. Usage: /lane [status|why <model>|disable <name>|enable <name>]',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => import('./lane.js'),
} satisfies Command

export default lane
