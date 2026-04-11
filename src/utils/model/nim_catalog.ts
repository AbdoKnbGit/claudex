/**
 * NIM Model Catalog — comprehensive list of all models available on NVIDIA NIM.
 *
 * Models are organized by provider/organization for easy browsing.
 * Used by the /models command to provide searchable model selection.
 *
 * Updated: April 2026
 */

export interface NimModelEntry {
  /** Full model ID as used in API calls (e.g. "meta/llama3-70b-instruct") */
  id: string
  /** Short display name */
  name: string
  /** Provider/organization that created the model */
  provider: string
}

export interface NimProviderGroup {
  /** Provider display name */
  name: string
  /** Icon/emoji for the provider */
  icon: string
  /** Models from this provider */
  models: NimModelEntry[]
}

export const NIM_PROVIDER_GROUPS: NimProviderGroup[] = [
  // ─── Meta ──────────────────────────────────────────────────────
  {
    name: 'Meta',
    icon: '\u{1F999}',  // 🦙
    models: [
      { id: 'meta/llama3-70b-instruct', name: 'LLaMA 3 70B Instruct', provider: 'Meta' },
      { id: 'meta/llama3-8b-instruct', name: 'LLaMA 3 8B Instruct', provider: 'Meta' },
      { id: 'meta/llama-3.1-405b-instruct', name: 'LLaMA 3.1 405B Instruct', provider: 'Meta' },
      { id: 'meta/llama-3.1-70b-instruct', name: 'LLaMA 3.1 70B Instruct', provider: 'Meta' },
      { id: 'meta/llama-3.1-8b-instruct', name: 'LLaMA 3.1 8B Instruct', provider: 'Meta' },
      { id: 'meta/llama-3.2-3b-instruct', name: 'LLaMA 3.2 3B Instruct', provider: 'Meta' },
      { id: 'meta/llama-3.2-11b-vision-instruct', name: 'LLaMA 3.2 11B Vision', provider: 'Meta' },
      { id: 'meta/llama-3.2-90b-vision-instruct', name: 'LLaMA 3.2 90B Vision', provider: 'Meta' },
      { id: 'meta/llama-3.2-1b-instruct', name: 'LLaMA 3.2 1B Instruct', provider: 'Meta' },
      { id: 'meta/llama-3.3-70b-instruct', name: 'LLaMA 3.3 70B Instruct', provider: 'Meta' },
      { id: 'meta/llama-4-maverick-17b-128e-instruct', name: 'LLaMA 4 Maverick 17B', provider: 'Meta' },
      { id: 'meta/llama-4-scout-17b-16e-instruct', name: 'LLaMA 4 Scout 17B', provider: 'Meta' },
    ],
  },

  // ─── Microsoft ─────────────────────────────────────────────────
  {
    name: 'Microsoft',
    icon: '\u{1FA9F}',  // 🪟
    models: [
      { id: 'microsoft/phi-3-small-8k-instruct', name: 'Phi-3 Small 8K', provider: 'Microsoft' },
      { id: 'microsoft/phi-3-small-128k-instruct', name: 'Phi-3 Small 128K', provider: 'Microsoft' },
      { id: 'microsoft/phi-3-medium-4k-instruct', name: 'Phi-3 Medium 4K', provider: 'Microsoft' },
      { id: 'microsoft/phi-3-mini-4k-instruct', name: 'Phi-3 Mini 4K', provider: 'Microsoft' },
      { id: 'microsoft/phi-3-mini-128k-instruct', name: 'Phi-3 Mini 128K', provider: 'Microsoft' },
      { id: 'microsoft/phi-3.5-mini-instruct', name: 'Phi-3.5 Mini', provider: 'Microsoft' },
      { id: 'microsoft/phi-3-medium-128k-instruct', name: 'Phi-3 Medium 128K', provider: 'Microsoft' },
      { id: 'microsoft/phi-4-mini-instruct', name: 'Phi-4 Mini', provider: 'Microsoft' },
      { id: 'microsoft/phi-4-multimodal-instruct', name: 'Phi-4 Multimodal', provider: 'Microsoft' },
      { id: 'microsoft/phi-4-mini-flash-reasoning', name: 'Phi-4 Mini Flash Reasoning', provider: 'Microsoft' },
    ],
  },

  // ─── Mistral AI ──────────────────────────────────��─────────────
  {
    name: 'Mistral AI',
    icon: '\u{1F534}',  // 🔴
    models: [
      { id: 'mistralai/mistral-7b-instruct-v0.3', name: 'Mistral 7B v0.3', provider: 'Mistral AI' },
      { id: 'mistralai/mixtral-8x22b-instruct-v0.1', name: 'Mixtral 8x22B', provider: 'Mistral AI' },
      { id: 'mistralai/mistral-7b-instruct-v0.2', name: 'Mistral 7B v0.2', provider: 'Mistral AI' },
      { id: 'mistralai/mixtral-8x7b-instruct-v0.1', name: 'Mixtral 8x7B', provider: 'Mistral AI' },
      { id: 'mistralai/mamba-codestral-7b-v0.1', name: 'Mamba Codestral 7B', provider: 'Mistral AI' },
      { id: 'mistralai/mistral-small-24b-instruct', name: 'Mistral Small 24B', provider: 'Mistral AI' },
      { id: 'mistralai/mistral-small-3.1-24b-instruct-2503', name: 'Mistral Small 3.1 24B', provider: 'Mistral AI' },
      { id: 'mistralai/mistral-medium-3-instruct', name: 'Mistral Medium 3', provider: 'Mistral AI' },
      { id: 'mistralai/magistral-small-2506', name: 'Magistral Small', provider: 'Mistral AI' },
      { id: 'mistralai/mistral-nemotron', name: 'Mistral NeMoTron', provider: 'Mistral AI' },
      { id: 'mistralai/mistral-large-3-675b-instruct-2512', name: 'Mistral Large 3 675B', provider: 'Mistral AI' },
      { id: 'mistralai/ministral-14b-instruct-2512', name: 'Ministral 14B', provider: 'Mistral AI' },
      { id: 'mistralai/mistral-small-4-119b-2603', name: 'Mistral Small 4 119B', provider: 'Mistral AI' },
      { id: 'mistralai/devstral-2-123b-instruct-2512', name: 'Devstral 2 123B', provider: 'Mistral AI' },
    ],
  },

  // ─── Google ───────────────────────────────��────────────────────
  {
    name: 'Google',
    icon: '\u{1F535}',  // 🔵
    models: [
      { id: 'google/gemma-7b', name: 'Gemma 7B', provider: 'Google' },
      { id: 'google/gemma-2-2b-it', name: 'Gemma 2 2B IT', provider: 'Google' },
      { id: 'google/gemma-2-27b-it', name: 'Gemma 2 27B IT', provider: 'Google' },
      { id: 'google/gemma-2-9b-it', name: 'Gemma 2 9B IT', provider: 'Google' },
      { id: 'google/gemma-3-1b-it', name: 'Gemma 3 1B IT', provider: 'Google' },
      { id: 'google/gemma-3n-e4b-it', name: 'Gemma 3N E4B IT', provider: 'Google' },
      { id: 'google/gemma-3n-e2b-it', name: 'Gemma 3N E2B IT', provider: 'Google' },
      { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B IT', provider: 'Google' },
    ],
  },

  // ─── NVIDIA ────────────────────────────────────────────────────
  {
    name: 'NVIDIA',
    icon: '\u{1F7E2}',  // 🟢
    models: [
      { id: 'nvidia/nemotron-4-mini-hindi-4b-instruct', name: 'Nemotron 4 Mini Hindi 4B', provider: 'NVIDIA' },
      { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', name: 'Nemotron Ultra 253B', provider: 'NVIDIA' },
      { id: 'nvidia/llama-3.3-nemotron-super-49b-v1', name: 'Nemotron Super 49B v1', provider: 'NVIDIA' },
      { id: 'nvidia/llama-3.1-nemotron-nano-8b-v1', name: 'Nemotron Nano 8B v1', provider: 'NVIDIA' },
      { id: 'nvidia/nvidia-nemotron-nano-9b-v2', name: 'Nemotron Nano 9B v2', provider: 'NVIDIA' },
      { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', name: 'Nemotron Super 49B v1.5', provider: 'NVIDIA' },
      { id: 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1', name: 'Nemotron Nano VL 8B', provider: 'NVIDIA' },
      { id: 'nvidia/llama-3.1-nemotron-nano-4b-v1.1', name: 'Nemotron Nano 4B v1.1', provider: 'NVIDIA' },
      { id: 'nvidia/nemotron-nano-12b-v2-vl', name: 'Nemotron Nano 12B v2 VL', provider: 'NVIDIA' },
      { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', provider: 'NVIDIA' },
      { id: 'nvidia/nemotron-3-nano-30b-a3b', name: 'Nemotron 3 Nano 30B', provider: 'NVIDIA' },
    ],
  },

  // ─── DeepSeek ──────────────────────────────────────────────────
  {
    name: 'DeepSeek',
    icon: '\u{1F537}',  // 🔷
    models: [
      { id: 'deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 Distill Qwen 32B', provider: 'DeepSeek' },
      { id: 'deepseek-ai/deepseek-r1-distill-qwen-14b', name: 'DeepSeek R1 Distill Qwen 14B', provider: 'DeepSeek' },
      { id: 'deepseek-ai/deepseek-r1-distill-qwen-7b', name: 'DeepSeek R1 Distill Qwen 7B', provider: 'DeepSeek' },
      { id: 'deepseek-ai/deepseek-r1-distill-llama-8b', name: 'DeepSeek R1 Distill LLaMA 8B', provider: 'DeepSeek' },
      { id: 'deepseek-ai/deepseek-v3.1-terminus', name: 'DeepSeek V3.1 Terminus', provider: 'DeepSeek' },
      { id: 'deepseek-ai/deepseek-v3.1', name: 'DeepSeek V3.1', provider: 'DeepSeek' },
      { id: 'deepseek-ai/deepseek-v3.2', name: 'DeepSeek V3.2', provider: 'DeepSeek' },
    ],
  },

  // ─── Qwen / Alibaba ───────────────────────────────────────────
  {
    name: 'Qwen / Alibaba',
    icon: '\u{1F7E3}',  // 🟣
    models: [
      { id: 'qwen/qwen2-7b-instruct', name: 'Qwen2 7B Instruct', provider: 'Qwen' },
      { id: 'qwen/qwen2.5-7b-instruct', name: 'Qwen2.5 7B Instruct', provider: 'Qwen' },
      { id: 'qwen/qwen2.5-coder-32b-instruct', name: 'Qwen2.5 Coder 32B', provider: 'Qwen' },
      { id: 'qwen/qwen2.5-coder-7b-instruct', name: 'Qwen2.5 Coder 7B', provider: 'Qwen' },
      { id: 'qwen/qwq-32b', name: 'QwQ 32B', provider: 'Qwen' },
      { id: 'qwen/qwen3-next-80b-a3b-instruct', name: 'Qwen3 Next 80B Instruct', provider: 'Qwen' },
      { id: 'qwen/qwen3-next-80b-a3b-thinking', name: 'Qwen3 Next 80B Thinking', provider: 'Qwen' },
      { id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B', provider: 'Qwen' },
      { id: 'qwen/qwen3.5-122b-a10b', name: 'Qwen3.5 122B', provider: 'Qwen' },
      { id: 'qwen/qwen3.5-397b-a17b', name: 'Qwen3.5 397B', provider: 'Qwen' },
    ],
  },

  // ─── OpenAI (open-source) ──────────────────────────���──────────
  {
    name: 'OpenAI',
    icon: '\u{26AA}',  // ⚪
    models: [
      { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B', provider: 'OpenAI' },
      { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B', provider: 'OpenAI' },
    ],
  },

  // ─── Moonshotai / Kimi ────────────────────────────────────────
  {
    name: 'Moonshotai / Kimi',
    icon: '\u{1F300}',  // 🌀
    models: [
      { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 Instruct', provider: 'Moonshotai' },
      { id: 'moonshotai/kimi-k2-thinking', name: 'Kimi K2 Thinking', provider: 'Moonshotai' },
      { id: 'moonshotai/kimi-k2-instruct-0905', name: 'Kimi K2 Instruct 0905', provider: 'Moonshotai' },
      { id: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5', provider: 'Moonshotai' },
    ],
  },

  // ─── Rakuten ─────────────────────────────────���────────────────
  {
    name: 'Rakuten',
    icon: '\u{2705}',  // ✅
    models: [
      { id: 'rakuten/rakutenai-7b-instruct', name: 'RakutenAI 7B Instruct', provider: 'Rakuten' },
      { id: 'rakuten/rakutenai-7b-chat', name: 'RakutenAI 7B Chat', provider: 'Rakuten' },
    ],
  },

  // ─── IBM ──────────────────────────────────────────────────────
  {
    name: 'IBM',
    icon: '\u{1F4BB}',  // 💻
    models: [
      { id: 'ibm/granite-3.3-8b-instruct', name: 'Granite 3.3 8B Instruct', provider: 'IBM' },
    ],
  },

  // ─── AI21 Labs ────────────────────────────────────────────────
  {
    name: 'AI21 Labs',
    icon: '\u{1F9EA}',  // 🧪
    models: [
      { id: 'ai21labs/jamba-1.5-mini-instruct', name: 'Jamba 1.5 Mini Instruct', provider: 'AI21 Labs' },
    ],
  },

  // ─── MediaTek ────────────────────────────���────────────────────
  {
    name: 'MediaTek',
    icon: '\u{1F4F1}',  // 📱
    models: [
      { id: 'mediatek/breeze-7b-instruct', name: 'Breeze 7B Instruct', provider: 'MediaTek' },
    ],
  },

  // ─── Institute of Science Tokyo ────────────────────────────���──
  {
    name: 'Institute of Science Tokyo',
    icon: '\u{1F3EB}',  // 🏫
    models: [
      { id: 'institute-of-science-tokyo/llama-3.1-swallow-70b-instruct-v0.1', name: 'Swallow 70B Instruct', provider: 'IST' },
      { id: 'institute-of-science-tokyo/llama-3.1-swallow-8b-instruct-v0.1', name: 'Swallow 8B Instruct', provider: 'IST' },
    ],
  },

  // ─── Others / Community ───────────────────────���───────────────
  {
    name: 'Others / Community',
    icon: '\u{1F310}',  // 🌐
    models: [
      { id: 'thudm/chatglm3-6b', name: 'ChatGLM3 6B', provider: 'THUDM' },
      { id: 'baichuan-inc/baichuan2-13b-chat', name: 'Baichuan2 13B Chat', provider: 'Baichuan' },
      { id: 'abacusai/dracarys-llama-3.1-70b-instruct', name: 'Dracarys LLaMA 70B', provider: 'AbacusAI' },
      { id: 'yentinglin/llama-3-taiwan-70b-instruct', name: 'LLaMA 3 Taiwan 70B', provider: 'YenTingLin' },
      { id: 'tokyotech-llm/llama-3-swallow-70b-instruct-v0.1', name: 'Swallow 70B (TokyoTech)', provider: 'TokyoTech' },
      { id: 'igenius/colosseum_355b_instruct_16k', name: 'Colosseum 355B', provider: 'iGenius' },
      { id: 'tiiuae/falcon3-7b-instruct', name: 'Falcon 3 7B Instruct', provider: 'TII UAE' },
      { id: 'igenius/italia_10b_instruct_16k', name: 'Italia 10B', provider: 'iGenius' },
      { id: 'marin/marin-8b-instruct', name: 'Marin 8B Instruct', provider: 'Marin' },
      { id: 'utter-project/eurollm-9b-instruct', name: 'EuroLLM 9B Instruct', provider: 'UTTER' },
      { id: 'gotocompany/gemma-2-9b-cpt-sahabatai-instruct', name: 'Gemma 2 9B SahabatAI', provider: 'GoTo' },
      { id: 'opengpt-x/teuken-7b-instruct-commercial-v0.4', name: 'Teuken 7B Instruct', provider: 'OpenGPT-X' },
      { id: 'sarvamai/sarvam-m', name: 'Sarvam M', provider: 'SarvamAI' },
      { id: 'stockmark/stockmark-2-100b-instruct', name: 'Stockmark 2 100B', provider: 'Stockmark' },
      { id: 'speakleash/bielik-11b-v2.6-instruct', name: 'Bielik 11B v2.6', provider: 'SpeakLeash' },
      { id: 'bytedance/seed-oss-36b-instruct', name: 'Seed OSS 36B', provider: 'ByteDance' },
      { id: 'z-ai/glm-5', name: 'GLM 5', provider: 'Z-AI' },
      { id: 'z-ai/glm-4.7', name: 'GLM 4.7', provider: 'Z-AI' },
      { id: 'stepfun-ai/step-3.5-flash', name: 'Step 3.5 Flash', provider: 'StepFun' },
      { id: 'minimaxai/minimax-m2.5', name: 'MiniMax M2.5', provider: 'MiniMax' },
    ],
  },
]

// ─── Flat list & search helpers ─────────────────────────────────

/** All NIM models from the static catalog */
export const ALL_NIM_MODELS: NimModelEntry[] = NIM_PROVIDER_GROUPS.flatMap(g => g.models)

/** Static catalog count */
export const NIM_MODEL_COUNT = ALL_NIM_MODELS.length

// ─── Live model fetching ────────────────────────────────────────
// Fetches actually-available models from the NIM API and caches them.
// Models not found on the API are excluded from the picker to prevent 404s.

let _liveModelIds: Set<string> | null = null
let _liveModelsFetched = false
let _liveFetchPromise: Promise<void> | null = null

/**
 * Fetch the list of currently available models from the NIM API.
 * Caches the result for the session. Returns empty set on failure.
 */
export async function fetchLiveNimModels(apiKey?: string): Promise<Set<string>> {
  if (_liveModelIds) return _liveModelIds

  // Avoid concurrent fetches
  if (_liveFetchPromise) {
    await _liveFetchPromise
    return _liveModelIds ?? new Set()
  }

  _liveFetchPromise = (async () => {
    try {
      const baseUrl = process.env.NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1'
      const key = apiKey || process.env.NIM_API_KEY || ''
      if (!key) {
        _liveModelIds = new Set()
        _liveModelsFetched = true
        return
      }

      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000), // 10 second timeout
      })

      if (!response.ok) {
        _liveModelIds = new Set()
        _liveModelsFetched = true
        return
      }

      const data = (await response.json()) as { data?: Array<{ id: string }> }
      const ids = (data.data ?? []).map(m => m.id)
      _liveModelIds = new Set(ids)
      _liveModelsFetched = true
    } catch {
      _liveModelIds = new Set()
      _liveModelsFetched = true
    }
  })()

  await _liveFetchPromise
  _liveFetchPromise = null
  return _liveModelIds ?? new Set()
}

/** Whether live models have been fetched (even if the fetch failed) */
export function hasLiveModels(): boolean {
  return _liveModelsFetched && _liveModelIds !== null && _liveModelIds.size > 0
}

/** Get the cached live model IDs, or null if not yet fetched */
export function getLiveModelIds(): Set<string> | null {
  return _liveModelIds
}

/** Reset the live model cache (e.g. after re-login) */
export function resetLiveModelCache(): void {
  _liveModelIds = null
  _liveModelsFetched = false
  _liveFetchPromise = null
}

/**
 * Build NimModelEntry list from live API model IDs.
 * Maps known models to their catalog metadata, and creates entries for unknown models.
 */
export function buildLiveModelList(liveIds: Set<string>): NimModelEntry[] {
  const catalogMap = new Map<string, NimModelEntry>()
  for (const m of ALL_NIM_MODELS) {
    catalogMap.set(m.id, m)
  }

  const result: NimModelEntry[] = []
  for (const id of liveIds) {
    const known = catalogMap.get(id)
    if (known) {
      result.push(known)
    } else {
      // Model exists on NIM but not in our static catalog — include it anyway
      const parts = id.split('/')
      const provider = parts[0] ?? 'unknown'
      const name = parts[1] ?? id
      result.push({ id, name, provider })
    }
  }

  return result.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Build provider groups from live model IDs.
 * Groups models by their org prefix (e.g. "meta/..." → Meta group).
 */
export function buildLiveProviderGroups(liveIds: Set<string>): NimProviderGroup[] {
  // Map of org prefix → known group info from static catalog
  const knownGroupMap = new Map<string, { name: string; icon: string }>()
  for (const group of NIM_PROVIDER_GROUPS) {
    for (const m of group.models) {
      const prefix = m.id.split('/')[0] ?? ''
      if (prefix && !knownGroupMap.has(prefix)) {
        knownGroupMap.set(prefix, { name: group.name, icon: group.icon })
      }
    }
  }

  // Group live models by org prefix
  const groupMap = new Map<string, NimModelEntry[]>()
  const catalogMap = new Map<string, NimModelEntry>()
  for (const m of ALL_NIM_MODELS) catalogMap.set(m.id, m)

  for (const id of liveIds) {
    const prefix = id.split('/')[0] ?? 'other'
    const known = catalogMap.get(id)
    const entry: NimModelEntry = known ?? {
      id,
      name: id.split('/')[1] ?? id,
      provider: prefix,
    }
    const list = groupMap.get(prefix) ?? []
    list.push(entry)
    groupMap.set(prefix, list)
  }

  // Convert to NimProviderGroup array, using known metadata when available
  const groups: NimProviderGroup[] = []
  for (const [prefix, models] of groupMap) {
    const known = knownGroupMap.get(prefix)
    groups.push({
      name: known?.name ?? prefix,
      icon: known?.icon ?? '\u{1F4E6}',  // 📦
      models: models.sort((a, b) => a.id.localeCompare(b.id)),
    })
  }

  return groups.sort((a, b) => a.name.localeCompare(b.name))
}

// ─── Search functions ───────────────────────────────────────────

/**
 * Search NIM models by query string.
 * If live models are available, searches only those; otherwise falls back to static catalog.
 */
export function searchNimModels(query: string, modelList?: NimModelEntry[]): NimModelEntry[] {
  const models = modelList ?? (hasLiveModels() ? buildLiveModelList(_liveModelIds!) : ALL_NIM_MODELS)

  if (!query.trim()) return models

  const q = query.toLowerCase().trim()
  const tokens = q.split(/\s+/)

  return models.filter(m => {
    const haystack = `${m.id} ${m.name} ${m.provider}`.toLowerCase()
    return tokens.every(t => haystack.includes(t))
  }).sort((a, b) => {
    const aIdMatch = a.id.toLowerCase().startsWith(q) ? 0 : 1
    const bIdMatch = b.id.toLowerCase().startsWith(q) ? 0 : 1
    if (aIdMatch !== bIdMatch) return aIdMatch - bIdMatch

    const aNameMatch = a.name.toLowerCase().startsWith(q) ? 0 : 1
    const bNameMatch = b.name.toLowerCase().startsWith(q) ? 0 : 1
    if (aNameMatch !== bNameMatch) return aNameMatch - bNameMatch

    return 0
  })
}

/**
 * Filter provider groups by query.
 * If live models are available, uses only live groups; otherwise falls back to static catalog.
 */
export function filterProviderGroups(query: string, groups?: NimProviderGroup[]): NimProviderGroup[] {
  const sourceGroups = groups
    ?? (hasLiveModels() ? buildLiveProviderGroups(_liveModelIds!) : NIM_PROVIDER_GROUPS)

  if (!query.trim()) return sourceGroups

  const q = query.toLowerCase().trim()
  const tokens = q.split(/\s+/)

  return sourceGroups
    .map(group => ({
      ...group,
      models: group.models.filter(m => {
        const haystack = `${m.id} ${m.name} ${m.provider}`.toLowerCase()
        return tokens.every(t => haystack.includes(t))
      }),
    }))
    .filter(group => group.models.length > 0)
}
