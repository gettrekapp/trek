// The v2 welcome's capabilities (PROTOCOL.md, "Welcome").
import { CAPABILITY } from '../../src/shared/protocolV2.ts'

/**
 * What this server always has. `docker`, `env` and `stacks` say it serves those methods; whether
 * the machine has docker or colima installed is each call's answer (`env.check`, TOOL_ERROR).
 * (`linear` and `voice` are the Linear and voice plugins' legacy capabilities since plugin system
 * phases 2 and 1, listed while they are registered.) `review` (5c-2): the Changes tab's sources and
 * draft line comments. `move` (5d): `move.*`, a worktree's
 * move to or from another server. `promote` (5e): `worktree.promote`, `worktree.demote`,
 * `promote.listen`, `promote.claim` and `promote.answer`, and promote_to_primary's
 * `promote.request` / `promote.settled`. `push` (6b): `push.setGrant`, `push.clearGrant` and
 * `push.status`, a phone's relay grant for background push. `automations`: `automation.*` and `Project.automations`.
 * `history`: `history.list` and the
 * `history.added` event, the worktree history.
 */
export const STATIC_CAPABILITIES: readonly string[] = [
  CAPABILITY.topicEnd,
  CAPABILITY.decisions,
  CAPABILITY.dequeue,
  CAPABILITY.agents,
  CAPABILITY.docker,
  CAPABILITY.env,
  CAPABILITY.stacks,
  CAPABILITY.skills,
  CAPABILITY.review,
  CAPABILITY.move,
  CAPABILITY.promote,
  CAPABILITY.push,
  CAPABILITY.automations,
  CAPABILITY.history
]

/**
 * `mcp` while the MCP listener is up, then the features this server always has, then `pairing`
 * (6a: `pairing.create`, and a phone's `pairingCode` at hello) on any server but the local one (a
 * phone can't reach this machine's loopback), then `prWatch` while gh is signed in on its machine
 * (5c-1), then `local` on the local server. `plugins`: the registered plugins' legacy capabilities
 * (`voice`), listed after the static ones, for clients older than plugins.
 */
export function welcomeCapabilities(mcp: boolean, local = false, prWatch = false, plugins: readonly string[] = []): string[] {
  return [
    ...(mcp ? [CAPABILITY.mcp] : []),
    ...STATIC_CAPABILITIES,
    ...plugins.filter((c) => !STATIC_CAPABILITIES.includes(c)),
    ...(local ? [] : [CAPABILITY.pairing]),
    ...(prWatch ? [CAPABILITY.prWatch] : []),
    ...(local ? [CAPABILITY.local] : [])
  ]
}
