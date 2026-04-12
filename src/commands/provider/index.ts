import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'provider',
  description: 'Connect or disconnect AI providers (OpenAI, Gemini, OpenRouter, …)',
  isEnabled: () => true,
  load: () => import('./provider.js'),
} satisfies Command
