// What a server window's New session menu offers. Until the server says which
// agents it can launch (3c-3), this machine's agents and llmSettings are no
// guide: the server runs the session with its own. So the menu offers
// - Default: no `llm`, the server resolves it (the project's llmDefault, else
//   the server's own default);
// - each other agent the project's settings on the server already name
//   (llmDefault, globalLlm, the session types' agents), known to be wanted;
// - the project's session types, which are the server's.
// Pure.
import { describeLlm } from '../../../shared/providers/selection.ts'
import type { LlmSelection } from '../../../shared/providers/types'
import type { SessionType } from '../../../shared/types'

export interface V2ProjectLlms {
  llmDefault?: LlmSelection
  globalLlm?: LlmSelection
  sessionTypes?: SessionType[]
}

export interface V2SessionChoices {
  /** The Default entry's description */
  defaultLabel: string
  /** Other agents to start a session with, once each, in settings order */
  picks: LlmSelection[]
}

export const SERVER_DEFAULT_LABEL = "The server's default agent"

export function v2SessionChoices(settings: V2ProjectLlms): V2SessionChoices {
  const defaultLabel = settings.llmDefault ? describeLlm(settings.llmDefault) : SERVER_DEFAULT_LABEL
  const seen = new Set([defaultLabel])
  const picks: LlmSelection[] = []
  for (const llm of [settings.globalLlm, ...(settings.sessionTypes ?? []).map((t) => t.llm)]) {
    if (!llm) continue
    const label = describeLlm(llm)
    if (seen.has(label)) continue
    seen.add(label)
    picks.push(llm)
  }
  return { defaultLabel, picks }
}

/** The Global panel's agent, for its bar: the project's globalLlm, else its default, else the server's. */
export function v2GlobalLabel(settings: V2ProjectLlms): string {
  const llm = settings.globalLlm ?? settings.llmDefault
  return llm ? describeLlm(llm) : 'server default'
}
