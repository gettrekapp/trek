// The static agent table of the clients (the renderer, the web client, the phone, desktop main)
// until plugins A2, built from the agent plugins' shared halves. A server's sessions go by its
// plugins' agents (server/src/agents/registry.ts); its validation leaves this table later in plugins A1.
import { claudeAgent } from './claude.ts'
import { codexAgent } from './codex.ts'
import { geminiAgent } from './gemini.ts'
import { grokAgent } from './grok.ts'
import { localAgent } from './local.ts'
import type { LlmProvider, LlmProviderId } from './types'

export const PROVIDER_LIST: LlmProvider[] = [claudeAgent, codexAgent, geminiAgent, grokAgent, localAgent]
const PROVIDERS = new Map<string, LlmProvider>(PROVIDER_LIST.map((p) => [p.id, p]))

export function isProviderId(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && PROVIDERS.has(value)
}

/** The adapter for an id; anything unknown is Claude, like a session saved before providers existed. */
export function getProvider(id: string | undefined): LlmProvider {
  return (id === undefined ? undefined : PROVIDERS.get(id)) ?? claudeAgent
}
