import { claude } from './claude.ts'
import { codex } from './codex.ts'
import { gemini } from './gemini.ts'
import { grok } from './grok.ts'
import { local } from './local.ts'
import { PROVIDER_IDS } from './types.ts'
import type { LlmProvider, LlmProviderId } from './types'

const PROVIDERS: Record<LlmProviderId, LlmProvider> = { claude, codex, gemini, grok, local }

export const PROVIDER_LIST: LlmProvider[] = PROVIDER_IDS.map((id) => PROVIDERS[id])

export function isProviderId(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

/** The adapter for an id; anything unknown is Claude, like a session saved before providers existed. */
export function getProvider(id: string | undefined): LlmProvider {
  return isProviderId(id) ? PROVIDERS[id] : claude
}
