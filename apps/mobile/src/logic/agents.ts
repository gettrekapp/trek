// The agents the phone offers (plugins A2): the server's list (server.agents) through the clients'
// catalog (src/shared/agents/catalog.ts): what a New session list offers, and why a session type
// can't start now. Pure.
import { agentCatalog, agentNote, type AgentInfo, type ServerAgents, type SessionType } from '../shared.ts'

/** The agents a New session list offers: installed on the server and on in the project. */
export function startableAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.installed && a.on !== false)
}

/** Why a session type can't start now (its agent is off in the project, or not on the server); null, also before the server's list. */
export function sessionTypeNote(type: Pick<SessionType, 'llm'>, server: ServerAgents | null): string | null {
  return server ? agentNote(type.llm, agentCatalog(server)) : null
}
