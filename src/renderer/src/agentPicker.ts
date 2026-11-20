// What an agent picker lists (plugins A2): the agents a new session can use that the caller offers,
// and a saved choice that is not among them. Pure: LlmPicker renders it; scripts/agentPicker.test.mjs runs it.
import type { AgentCatalog, ClientAgent } from '../../shared/agents/catalog.ts'
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

/** Whether a pick needs a model before it can start: an agent whose models come from an endpoint has no default one. */
export function needsModel(value: AgentSelection, catalog: AgentCatalog): boolean {
  const from = catalog.get(value.provider)?.modelsFrom
  return (from === 'server' || from === 'typed') && !value.model
}

/**
 * The selection to switch to once an agent's models are listed: its first model, when none is
 * chosen. Only when the user picked the agent in this picker (`pickedHere`), or the picker holds a
 * one-off pick (`eager`: the New session menu's); a saved choice (a session type's, a default)
 * that is merely shown is left as it is, so showing it saves nothing.
 */
export function firstModelPick(
  current: AgentSelection,
  agentId: string,
  models: readonly { id: string }[],
  when: { pickedHere: boolean; eager: boolean }
): AgentSelection | null {
  if (!when.pickedHere && !when.eager) return null
  if (current.provider !== agentId || current.model || !models[0]) return null
  return { provider: agentId, model: models[0].id, ...(current.effort ? { effort: current.effort } : {}) }
}
