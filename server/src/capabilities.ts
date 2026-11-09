// The v2 welcome's capabilities (PROTOCOL.md, "Welcome").
import { CAPABILITY } from '../../src/shared/protocolV2.ts'

/**
 * What this server always has. `docker`, `env` and `stacks` say it serves those methods; whether
 * the machine has docker or colima installed is each call's answer (`env.check`, TOOL_ERROR).
 */
export const STATIC_CAPABILITIES: readonly string[] = [
  CAPABILITY.topicEnd,
  CAPABILITY.decisions,
  CAPABILITY.dequeue,
  CAPABILITY.agents,
  CAPABILITY.docker,
  CAPABILITY.env,
  CAPABILITY.stacks
]

/** `mcp` while the MCP listener is up, then the features this server always has, then `local` on the local server. */
export function welcomeCapabilities(mcp: boolean, local = false): string[] {
  return [...(mcp ? [CAPABILITY.mcp] : []), ...STATIC_CAPABILITIES, ...(local ? [CAPABILITY.local] : [])]
}
