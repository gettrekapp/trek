// The agent selection types core and the clients share. Since plugins A1 an agent is a plugin's
// (src/shared/plugins/agents.ts) and its id any string a server's plugins offer; since plugins A2
// its facts reach a client from the server (src/shared/agents/catalog.ts). Safe for `node --test`,
// the server and the phone.
import type { AgentSelection } from '../agents/selection.ts'
export type { LaunchArg, LaunchSpec } from '../plugins/agents.ts'

/** An agent's id */
export type LlmProviderId = string

/** Which agent, model and effort a session runs. Unset fields mean "the agent's own default". */
export type LlmSelection = AgentSelection
