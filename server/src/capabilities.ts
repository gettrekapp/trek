// The v2 welcome's capabilities (PROTOCOL.md, "Welcome").
import { CAPABILITY } from '../../src/shared/protocolV2.ts'

/**
 * What this server always has. `docker`, `env` and `stacks` say it serves those methods; whether
 * the machine has docker or colima installed is each call's answer (`env.check`, TOOL_ERROR).
 * `linear` and `voice` say it serves `linear.*` and `voice.*`; whether it has a key is
 * `linear.status`'s and `voice.settings`' answer. `review` (5c-2): the Changes tab's sources and
 * draft line comments.
 */
export const STATIC_CAPABILITIES: readonly string[] = [
  CAPABILITY.topicEnd,
  CAPABILITY.decisions,
  CAPABILITY.dequeue,
  CAPABILITY.agents,
  CAPABILITY.docker,
  CAPABILITY.env,
  CAPABILITY.stacks,
  CAPABILITY.linear,
  CAPABILITY.voice,
  CAPABILITY.skills,
  CAPABILITY.review
]

/**
 * `mcp` while the MCP listener is up, then the features this server always has, then `prWatch`
 * while gh is signed in on its machine (5c-1), then `local` on the local server.
 */
export function welcomeCapabilities(mcp: boolean, local = false, prWatch = false): string[] {
  return [
    ...(mcp ? [CAPABILITY.mcp] : []),
    ...STATIC_CAPABILITIES,
    ...(prWatch ? [CAPABILITY.prWatch] : []),
    ...(local ? [CAPABILITY.local] : [])
  ]
}
