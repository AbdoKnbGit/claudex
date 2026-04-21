/**
 * Transformer registry. Adding a new provider = add a file in this
 * directory + one line here.
 */

import { deepseekTransformer } from './deepseek.js'
import { groqTransformer } from './groq.js'
import { mistralTransformer } from './mistral.js'
import { nimTransformer } from './nim.js'
import { ollamaTransformer } from './ollama.js'
import { openrouterTransformer } from './openrouter.js'
import { clineTransformer } from './cline.js'
import { iflowTransformer } from './iflow.js'
import { kilocodeTransformer } from './kilocode.js'
import { genericTransformer } from './generic.js'
import type { Transformer, ProviderId } from './base.js'

export const TRANSFORMERS: Record<ProviderId, Transformer> = {
  deepseek: deepseekTransformer,
  groq: groqTransformer,
  mistral: mistralTransformer,
  nim: nimTransformer,
  ollama: ollamaTransformer,
  openrouter: openrouterTransformer,
  cline: clineTransformer,
  iflow: iflowTransformer,
  kilocode: kilocodeTransformer,
  generic: genericTransformer,
}

export function getTransformer(provider: ProviderId): Transformer {
  return TRANSFORMERS[provider] ?? genericTransformer
}

export {
  deepseekTransformer, groqTransformer, mistralTransformer, nimTransformer,
  ollamaTransformer, openrouterTransformer, genericTransformer,
  clineTransformer, iflowTransformer, kilocodeTransformer,
}
export type { Transformer, ProviderId, TransformContext } from './base.js'
export type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'
