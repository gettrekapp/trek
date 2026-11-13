// The v2 welcome's capabilities (PROTOCOL.md, "Welcome").
import { CAPABILITY } from '../../src/shared/protocolV2.ts'

/**
 * What this server always has. `docker`, `env` and `stacks` say it serves those methods; whether
 * the machine has docker or colima installed is each call's answer (`env.check`, TOOL_ERROR).
 * `linear` says it serves `linear.*`; whether it has a key is `linear.status`'s answer. (`voice`
 * is the voice plugin's legacy capability since plugin system phase 1, listed while it is registered.) `review` (5c-2): the Changes tab's sources and
 * draft line comments. `move` (5d): `move.*`, a worktree's
 * move to or from another server. `promote` (5e): `worktree.promote`, `worktree.demote`,
 * `promote.listen`, `promote.claim` and `promote.answer`, and promote_to_primary's
 * `promote.request` / `promote.settled`. `push` (6b): `push.setGrant`, `push.clearGrant` and
 * `push.status`, a phone's relay grant for background push.
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
  CAPABILITY.skills,
  CAPABILITY.review,
  CAPABILITY.move,
  CAPABILITY.promote,
  CAPABILITY.push
]

/**
 * `mcp` while the MCP listener is up, then the features this server always has, then `pairing`
 * (6a: `pairing.create`, and a phone's `pairingCode` at hello) on any server but the local one (a
 * phone can't reach this machine's loopback), then `prWatch` while gh is signed in on its machine
 * (5c-1), then `local` on the local server. `plugins`: the registered plugins' legacy capabilities
 * (`voice`), listed after the static ones, for clients older than plugins.
 */
export function welcomeCapabilities(
  mcp: boolean,
  local = false,
  prWatch = false,
  plugins: readonly string[] = [],
  platform: NodeJS.Platform = process.platform
): string[] {
  // Windows (W1): no environments or dev stacks yet (machineHandlersFor).
  const windowsOff: readonly string[] = platform === 'win32' ? [CAPABILITY.env, CAPABILITY.stacks] : []
  return [
    ...(mcp ? [CAPABILITY.mcp] : []),
    ...STATIC_CAPABILITIES.filter((c) => !windowsOff.includes(c)),
    ...plugins.filter((c) => !STATIC_CAPABILITIES.includes(c)),
    ...(local ? [] : [CAPABILITY.pairing]),
    ...(prWatch ? [CAPABILITY.prWatch] : []),
    ...(local ? [CAPABILITY.local] : [])
  ]
}
