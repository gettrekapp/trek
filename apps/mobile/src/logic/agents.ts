// The agents the phone offers (plugins A2): the server's list (server.agents) through the clients'
// catalog (src/shared/agents/catalog.ts): what a New session list offers, and why a session type
// can't start now. Pure.
import { agentCatalog, agentNote, type AgentInfo, type ServerAgents, type SessionType } from '../shared.ts'

/** The agents a New session list offers: installed on the server and on in the project. */
export function startableAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.installed && a.on !== false)
}

/**
 * Why a session type can't start now (its agent is off in the project, or not on the server); null, also before the server's list.
 * An agent turned off says where it is turned on (the desktop app's Settings → Plugins; the phone has no Plugins screen and no
 * agent to pick for a session type), as the phone's ticket and PR notes do; the rest is the clients' shared agentNote.
 */
export function sessionTypeNote(type: Pick<SessionType, 'llm'>, server: ServerAgents | null): string | null {
  if (!server) return null
  const catalog = agentCatalog(server)
  const agent = type.llm ? catalog.get(type.llm.provider) : undefined
  if (agent && !agent.on) return `${agent.label} is turned off for this project. Turn it on in the desktop app's Settings → Plugins.`
  return agentNote(type.llm, catalog)
}
