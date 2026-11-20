// The window's agents (plugins A2): its server's `server.agents` answer as a catalog
// (src/shared/agents/catalog.ts), one per answer, for components (useAgentCatalog) and for code
// outside React (agentCatalogNow). Before the answer, and from a server without `agents`, it is the
// old-server snapshot.
import { agentCatalog, type AgentCatalog } from '../../shared/agents/catalog.ts'
import type { ServerAgents } from '../../shared/protocolV2.ts'
import { useAppStore } from './store'

const NO_ANSWER = agentCatalog(null)
const catalogs = new WeakMap<ServerAgents, AgentCatalog>()

/** An answer's catalog: the same object for the same answer, so components' memos hold. */
export function catalogOf(server: ServerAgents | null): AgentCatalog {
  if (!server) return NO_ANSWER
  let catalog = catalogs.get(server)
  if (!catalog) catalogs.set(server, (catalog = agentCatalog(server)))
  return catalog
}

/** The window's catalog now, outside React (notifications, quick buttons). */
export const agentCatalogNow = (): AgentCatalog => catalogOf(useAppStore.getState().serverAgents)

/** The window's catalog, re-rendering when the server's answer changes. */
export function useAgentCatalog(): AgentCatalog {
  return catalogOf(useAppStore((s) => s.serverAgents))
}
