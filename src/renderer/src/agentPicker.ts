// What an agent picker lists (plugins A2): the agents a new session can use that the caller offers,
// and a saved choice that is not among them. Pure: LlmPicker renders it; scripts/agentPicker.test.mjs runs it.
import { expectedDefault, type AgentCatalog, type ClientAgent } from '../../shared/agents/catalog.ts'
import { DEFAULT_AGENT_ID } from '../../shared/plugins/agents.ts'
import type { AgentSelection } from '../../shared/agents/selection.ts'

export interface PickerAgent {
  id: string
  label: string
}

/**
 * The agents on in the project that `offer` lets through, in the server's order; then the chosen one
 * when it is not among them, marked, so a saved choice (a session type's, an automation's, a
 * default) stays shown and can be changed.
 */
export function pickerAgents(value: AgentSelection, catalog: AgentCatalog, offer?: (agent: ClientAgent) => boolean): PickerAgent[] {
  const list = catalog.offered.filter((a) => !offer || offer(a)).map((a) => ({ id: a.id, label: a.label }))
  if (list.some((a) => a.id === value.provider)) return list
  const agent = catalog.get(value.provider)
  const why = !agent ? 'not on this server' : !agent.on ? 'off for this project' : 'not offered here'
  return [...list, { id: value.provider, label: `${catalog.label(value.provider)} (${why})` }]
}

/**
 * Whether a one-off pick can start a session: its agent is offered (on in the project; an id the
 * server doesn't list is not, though `isOn` counts it on) and it has a model where it needs one.
 */
export function canStartPick(value: AgentSelection, catalog: AgentCatalog): boolean {
  return catalog.offered.some((a) => a.id === value.provider) && !needsModel(value, catalog)
}

/** Whether a pick needs a model before it can start: an agent whose models come from an endpoint has no default one. */
export function needsModel(value: AgentSelection, catalog: AgentCatalog): boolean {
  const from = catalog.get(value.provider)?.modelsFrom
  return (from === 'server' || from === 'typed') && !value.model
}

/**
 * The selection to switch to once an agent's models are listed: its first model, when none is
 * chosen. Only when the user picked this very agent in this picker (`pickedHere`, the id last
 * picked there), or the picker holds a one-off pick (`eager`: the New session menu's). A saved
 * choice (a session type's, a default) that is merely shown, or set from outside, is left as it
 * is, so showing it saves nothing.
 */
export function firstModelPick(
  current: AgentSelection,
  agentId: string,
  models: readonly { id: string }[],
  when: { pickedHere: string | null; eager: boolean }
): AgentSelection | null {
  if (when.pickedHere !== agentId && !when.eager) return null
  if (current.provider !== agentId || current.model || !models[0]) return null
  return { provider: agentId, model: models[0].id, ...(current.effort ? { effort: current.effort } : {}) }
}

/** Where a session type's own agent starts when "Use the default agent" is unticked: the default its sessions get now (the project's, else the server's, past one that is off). */
export function typeAgentStart(projectDefault: AgentSelection | undefined, serverDefault: AgentSelection | undefined, catalog: AgentCatalog): AgentSelection {
  return expectedDefault({ llmDefault: projectDefault }, serverDefault ?? { provider: DEFAULT_AGENT_ID }, catalog, false)
}
