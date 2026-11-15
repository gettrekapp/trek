// "Update" on a server's row, without Electron (appServers.ts gives it the list, main's
// connections and the message box): the server's update status is read now, the question is
// built from that answer, and the version sent is the one the question named. What main last
// heard is not used: `update.changed` comes when the update state changes, never when a
// terminal opens or closes, so a remembered status can say "no terminals" of a server that has
// three.
import { applyUpdateRefusal, serverUpdateConfirm, type ServerUpdateConfirm } from '../shared/serverUpdate.ts'
import type { ServerUpdates } from './serverUpdates.ts'

export const NOT_CONNECTED = 'Not connected to this server'

export interface ApplyServerUpdateDeps {
  /** The entry now: its name, main's connection to it (compared by identity) and whether that is connected. Undefined when it is not listed or has no connection. */
  entry(id: string): { name: string; link: unknown; connected: boolean } | undefined
  updates: Pick<ServerUpdates, 'refresh' | 'apply'>
  /** Shows the question; true when the user chose to install */
  ask(confirm: ServerUpdateConfirm): Promise<boolean>
}

/**
 * Asks first, then has the server install its latest release. Rejects with a sentence for the
 * row when there is nothing to ask (not connected, the server refused the read, nothing to
 * install, an install left to its machine, one already running). `started` is false when the
 * user cancelled. Nothing is sent to an entry that was removed or re-pointed meanwhile.
 */
export async function applyServerUpdate(id: string, deps: ApplyServerUpdateDeps): Promise<{ started: boolean }> {
  const entry = deps.entry(id)
  if (!entry || !entry.connected) throw new Error(NOT_CONNECTED)
  /** The answers are about this connection's server: one removed or re-pointed since is another. */
  const same = (): boolean => deps.entry(id)?.link === entry.link
  const status = await deps.updates.refresh(id)
  if (!same()) throw new Error(NOT_CONNECTED)
  const refusal = applyUpdateRefusal(status)
  if (refusal || !status.latest) throw new Error(refusal ?? 'No update is available for this server')
  if (!(await deps.ask(serverUpdateConfirm(entry.name, status)))) return { started: false }
  if (!same()) throw new Error(NOT_CONNECTED)
  await deps.updates.apply(id, status.latest)
  return { started: true }
}
