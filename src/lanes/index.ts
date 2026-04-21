/**
 * Lane Architecture — Entry Point
 *
 * Bootstraps all lanes and the dispatcher. Call initLanes() once at
 * startup after provider auth is resolved.
 *
 * After init, the dispatcher auto-routes every model to its native lane.
 * No env vars, no config files needed. User picks a model, it works.
 */

export {
  registerLane,
  getLane,
  getAllLanes,
  dispatch,
  resolveRoute,
  getLaneStatus,
} from './dispatcher.js'

export type {
  Lane,
  LaneRunContext,
  LaneRunResult,
  NormalizedUsage,
  LaneToolRegistration,
  SystemPromptParts,
  SharedTool,
  ToolResult,
  LaneEvent,
} from './types.js'

export { shouldUseNativeLane, runNativeLane } from './bridge.js'
export { LaneBackedProvider } from './provider-bridge.js'

import { initGeminiLane } from './gemini/index.js'
import { initCodexLane } from './codex/index.js'
import { initOpenAICompatLane } from './openai-compat/index.js'
import { initQwenLane } from './qwen/index.js'
import { initClaudeLane } from './claude/index.js'
import { initKiroLane } from './kiro/index.js'
import { initCursorLane } from './cursor/index.js'

/**
 * Initialize all lanes with available auth credentials.
 *
 * Auth resolution: each lane reads from the opts parameter first,
 * then falls back to environment variables, then to stored credentials
 * from /login. If no auth is available, the lane registers but marks
 * itself unhealthy — models that need it fall through to the existing
 * shim path until the user authenticates.
 *
 * Call this once at startup.
 */
export function initLanes(opts?: {
  // Gemini
  geminiApiKey?: string
  geminiOAuthToken?: string
  /** Dual-OAuth: token for the Gemini CLI executor (free tier). */
  geminiCliOAuthToken?: string
  /** Dual-OAuth: token for the Antigravity executor (3.x pro/flash). */
  geminiAntigravityOAuthToken?: string
  // OpenAI / Codex
  openaiApiKey?: string
  openaiBaseUrl?: string
  // DeepSeek
  deepseekApiKey?: string
  // Groq
  groqApiKey?: string
  // Mistral
  mistralApiKey?: string
  // NVIDIA NIM
  nimApiKey?: string
  // Ollama
  ollamaBaseUrl?: string
  // OpenRouter
  openrouterApiKey?: string
  // Qwen (DashScope)
  qwenApiKey?: string
  // Phase 4 — OAuth-backed compat providers. `apiKey` here is the OAuth
  // access token (iFlow is special: chat uses a derived apiKey pulled
  // from the userinfo endpoint, see oauth_services.ts::getIFlowApiKey).
  clineApiKey?: string
  iflowApiKey?: string
  kilocodeApiKey?: string
  /** GitHub Copilot internal token (NOT the GH OAuth access token — see
   *  oauth_services.ts::completeCopilotOAuth). */
  copilotApiKey?: string
  /** Kiro OAuth access token (AWS SSO OIDC). */
  kiroApiKey?: string
  /** Kiro profileArn (optional — social-login users have one, Builder-ID
   *  users don't; the lane falls back to a public default when unset). */
  kiroProfileArn?: string
  /** Cursor access token (manual paste from Cursor IDE state.vscdb). */
  cursorApiKey?: string
  /** Cursor machineId (optional — derived from the token when absent). */
  cursorMachineId?: string
}): void {
  // ── Claude lane (registration-only: Anthropic traffic uses
  //    services/api/claude.ts directly — this lane exists for /lane
  //    and /models UX symmetry + smallFastModel lookup). ──
  initClaudeLane()

  // ── Gemini lane (Gemini models) ──
  initGeminiLane({
    apiKey: opts?.geminiApiKey,
    oauthToken: opts?.geminiOAuthToken,
    cliOAuthToken: opts?.geminiCliOAuthToken,
    antigravityOAuthToken: opts?.geminiAntigravityOAuthToken,
  })

  // ── Codex lane (OpenAI GPT-5, Codex, o-series) ──
  initCodexLane({
    apiKey: opts?.openaiApiKey,
    baseUrl: opts?.openaiBaseUrl,
  })

  // ── Qwen lane (native OAuth + DashScope) ──
  // Must register BEFORE openai-compat so the dispatcher picks the
  // dedicated Qwen lane first for qwen-* / coder-model ids. Openai-compat
  // keeps no qwen provider after Phase 2B.
  initQwenLane({
    apiKey: opts?.qwenApiKey,
  })

  // ── Kiro lane (AWS CodeWhisperer via EventStream binary frames) ──
  // Registered before openai-compat so its dispatcher-scoped
  // supportsModel() claim on `claude-sonnet-4.5` / `deepseek-3.x` etc.
  // wins over any compat-side fallback. In practice the LaneBackedProvider
  // path routes by provider name, not model heuristic, so ordering is a
  // belt-and-suspenders guard for the future Phase-2 dispatch path.
  initKiroLane({
    accessToken: opts?.kiroApiKey,
    profileArn: opts?.kiroProfileArn,
  })

  // ── Cursor lane (ConnectRPC protobuf to api2.cursor.sh) ──
  // Dotted catalog ids (`claude-4.5-sonnet`, `gpt-5.2-codex`) don't
  // collide with Anthropic/OpenAI canonical ids, so the dispatcher's
  // per-provider routing (not model-heuristic) is what matters here.
  initCursorLane({
    accessToken: opts?.cursorApiKey,
    machineId: opts?.cursorMachineId,
  })

  // ── OpenAI-compat lane (DeepSeek, Groq, Mistral, NIM, Ollama,
  //    OpenRouter, Cline, iFlow, KiloCode) ──
  initOpenAICompatLane({
    deepseek: opts?.deepseekApiKey ? { apiKey: opts.deepseekApiKey } : undefined,
    groq: opts?.groqApiKey ? { apiKey: opts.groqApiKey } : undefined,
    mistral: opts?.mistralApiKey ? { apiKey: opts.mistralApiKey } : undefined,
    nim: opts?.nimApiKey ? { apiKey: opts.nimApiKey } : undefined,
    ollama: opts?.ollamaBaseUrl ? { baseUrl: opts.ollamaBaseUrl } : undefined,
    openrouter: opts?.openrouterApiKey ? { apiKey: opts.openrouterApiKey } : undefined,
    cline: opts?.clineApiKey ? { apiKey: opts.clineApiKey } : undefined,
    iflow: opts?.iflowApiKey ? { apiKey: opts.iflowApiKey } : undefined,
    kilocode: opts?.kilocodeApiKey ? { apiKey: opts.kilocodeApiKey } : undefined,
    copilot: opts?.copilotApiKey ? { apiKey: opts.copilotApiKey } : undefined,
  })
}
