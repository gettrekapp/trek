// The v2 welcome's capabilities (PROTOCOL.md, "Welcome").
import { CAPABILITY } from '../../src/shared/protocolV2.ts'

/** What this server always has. */
export const STATIC_CAPABILITIES: readonly string[] = [CAPABILITY.topicEnd, CAPABILITY.decisions, CAPABILITY.dequeue]

/** `mcp` while the MCP listener is up, then the features this server always has. */
export function welcomeCapabilities(mcp: boolean): string[] {
  return [...(mcp ? [CAPABILITY.mcp] : []), ...STATIC_CAPABILITIES]
}
