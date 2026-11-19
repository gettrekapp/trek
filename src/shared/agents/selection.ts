// The neutral rules of an agent selection (plugins A1): which agent a new session runs, the effort
// it gets, the Global panel's fallback, a launch's session id. They ask a lookup about the agents,
// never a fixed table, so the server goes by the agents its plugins offer. Pure; the clients take
// them over from the static table in plugins A2.
import { DEFAULT_AGENT_ID, type AgentCapabilities, type AgentModel } from '../plugins/agents.ts'

/** Which agent, model and effort a session runs; unset fields mean "the agent's own default". */
export interface AgentSelection {
  provider: string
  model?: string
  effort?: string
}

/** What the rules read of an agent. */
export interface AgentFacts {
  capabilities: AgentCapabilities
  models: readonly AgentModel[]
  efforts: readonly string[]
}

/** The agents a server has. */
export interface AgentLookup {
  /** Whether it has an agent with this id */
  has(id: string): boolean
  /** An agent's facts; an unknown id's are the default agent's, as a launch resolves it */
  facts(id: string | undefined): AgentFacts
}

const defaultAgent = (): AgentSelection => ({ provider: DEFAULT_AGENT_ID })

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionValue(value: unknown): string | undefined {
  const clean = text(value)
  return clean && !clean.startsWith('-') ? clean : undefined
}

/**
 * A saved or sent selection, made safe: undefined when there is none, the default agent when its id
 * is not one the server has (hand-edited, or from a newer Trek), blank model and effort dropped. No
 * model or effort id starts with a dash; one that does could pass as a CLI flag, so it is dropped.
 */
export function sanitizeAgentSelection(value: unknown, has: (id: string) => boolean): AgentSelection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.provider !== 'string' || !has(record.provider)) return defaultAgent()
  const model = optionValue(record.model)
  const effort = optionValue(record.effort)
  return { provider: record.provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

export interface NewSessionSources {
  pick?: AgentSelection
  sessionType?: AgentSelection
  projectDefault?: AgentSelection
  appDefault?: AgentSelection
}

/** The first selection that is set wins as a whole — fields never mix across sources. */
export function resolveNewSessionLlm(sources: NewSessionSources): AgentSelection {
  return sources.pick ?? sources.sessionType ?? sources.projectDefault ?? sources.appDefault ?? defaultAgent()
}

/** The Global panel needs Trek's MCP tools: fall back past agents without them, to the default agent. */
export function resolveGlobalAgent(
  projectGlobal: AgentSelection | undefined,
  sessionDefault: AgentSelection | undefined,
  agents: Pick<AgentLookup, 'facts'>
): AgentSelection {
  for (const candidate of [projectGlobal, sessionDefault]) {
    if (candidate && agents.facts(candidate.provider).capabilities.mcp) return candidate
  }
  return defaultAgent()
}

/** Effort levels on offer for a selection's model. */
export function effortsOf(selection: AgentSelection, agents: Pick<AgentLookup, 'facts'>): readonly string[] {
  const agent = agents.facts(selection.provider)
  if (!agent.capabilities.effort) return []
  if (!selection.model) return agent.efforts
  const known = agent.models.find((m) => m.id === selection.model)
  return known ? (known.efforts ?? []) : agent.efforts
}

/** The effort to pass, or undefined when the chosen model doesn't take it. */
export function effectiveEffortOf(selection: AgentSelection, agents: Pick<AgentLookup, 'facts'>): string | undefined {
  return selection.effort && effortsOf(selection, agents).includes(selection.effort) ? selection.effort : undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The session id a launch uses and whether it resumes. An agent whose id Trek presets gets it on
 * the command line unquoted, so a saved id that isn't a UUID is never used: that session starts
 * over with a fresh id. A discovered id (Codex's) is quoted; an agent without resume always starts fresh.
 */
export function sessionLaunch(
  capabilities: Pick<AgentCapabilities, 'presetSessionId' | 'resume'>,
  saved: string | undefined,
  freshId: () => string
): { sessionId: string; resume: boolean } {
  if (!saved || (capabilities.presetSessionId && !UUID.test(saved))) {
    return { sessionId: freshId(), resume: false }
  }
  return { sessionId: saved, resume: capabilities.resume }
}
