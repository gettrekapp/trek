// Updating a remote trek-server from the app: what its row in the server list says, what the
// confirmation asks, and a refused request as a sentence. Pure: main keeps each server's
// UpdateStatus (src/main/serverUpdates.ts), the renderer draws serverUpdateRow(link), and main
// shows serverUpdateConfirm before it asks the server to install.
import { CAPABILITY, type UpdateStatus } from './protocolV2.ts'
import { compareVersions } from './versions.ts'
import type { AppServerLink } from './types.ts'

/** How long a server that said it is restarting to update may stay away before its row says disconnected again */
export const RESTART_GRACE_MS = 2 * 60 * 1000

const MAX_ERROR_CHARS = 200
const MAX_VERSION_CHARS = 40
const MAX_NAME_CHARS = 60

/** Why a row with a release has no button, and why the app does not ask such a server to install */
const LEFT_TO_ITS_MACHINE = 'This server is set to be updated on its own machine: run `trek-server update` there.'
const ALREADY_RUNNING = 'An update is already running on this server'

export type ServerUpdateAction = { kind: 'apply'; label: string; version: string } | { kind: 'check'; label: string }

export interface ServerUpdateRowView {
  tone: 'available' | 'progress' | 'attention' | 'error' | 'done'
  text: string
  /** Why there is no button */
  hint?: string
  action?: ServerUpdateAction
}

/** `text` on one line (runs of whitespace are one space), cut to `max` characters. */
function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The first line of `error` that says anything, cut to a reasonable length. A line that ends in a
 * colon only introduces the next one (a selfcheck's output after "… does not run on this machine,
 * so 1.0.0 stays:"), so that one is said with it.
 */
function oneLine(error: string): string {
  const lines = error.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const first = lines[0] ?? ''
  return cut(first.endsWith(':') && lines.length > 1 ? `${first} ${lines[1]}` : first, MAX_ERROR_CHARS)
}

/** A version as the row shows it: a server's string, so never trusted to be short. */
const shown = (version: string): string => cut(version, MAX_VERSION_CHARS)

function updates(link: AppServerLink): boolean {
  return !link.local && link.status === 'connected' && (link.capabilities ?? []).includes(CAPABILITY.update)
}

/**
 * "Check for Update" shows for a connected server that can update itself (never the Local
 * server) while it is doing nothing: a check during an install is refused.
 */
export function canCheckUpdate(link: AppServerLink): boolean {
  return updates(link) && !link.updateRestarting && (link.update?.state ?? 'idle') === 'idle'
}

/**
 * What the row says about updating this server; null when there is nothing to say.
 * `checked`: the user has just had it look for a release, so finding none is said too.
 */
export function serverUpdateRow(link: AppServerLink, opts: { checked?: boolean } = {}): ServerUpdateRowView | null {
  if (link.local) return null
  // The server said it was going down to update: say so while it is away. Once it answers
  // again (connected, or refusing this app's token or protocol), the row's status says more.
  if (link.updateRestarting && link.status !== 'connected' && link.status !== 'needs-auth' && link.status !== 'incompatible') {
    const into = link.updateRestarting.version
    return { tone: 'progress', text: into ? `Restarting into ${shown(into)}…` : 'Restarting to update…' }
  }
  if (!updates(link)) return null
  const status = link.update
  if (!status) return null
  // The release being installed is the latest one (update.apply takes no other). Nothing else
  // is named: the last result's version is another update's.
  const naming = status.latest ? ` ${shown(status.latest)}` : ''
  switch (status.state) {
    case 'checking':
      return { tone: 'progress', text: 'Checking for an update…' }
    case 'downloading': {
      const percent = typeof status.percent === 'number' && Number.isFinite(status.percent) ? ` ${Math.min(100, Math.max(0, Math.round(status.percent)))}%` : ''
      return { tone: 'progress', text: `Downloading${naming}…${percent}` }
    }
    case 'installing':
      return { tone: 'progress', text: `Installing${naming}…` }
    case 'restarting':
      return { tone: 'progress', text: status.latest ? `Restarting into ${shown(status.latest)}…` : 'Restarting to update…' }
    default:
      break
  }
  // Which version is installed is not in the status (`latest` may be a later release), so none is named.
  if (status.restartNeeded) return { tone: 'attention', text: 'An update is installed. Restart trek-server on that machine to finish.' }
  const last = status.lastResult
  // A failure is news until the server runs that version (or a later one), or a newer release is offered.
  const failed = last && !last.ok && compareVersions(status.current, last.to) < 0 && (!status.latest || status.latest === last.to)
  if (last && failed) {
    const text = `Update failed: ${oneLine(last.error ?? '') || 'no reason was recorded'}`
    if (!status.latest) return { tone: 'error', text, action: { kind: 'check', label: 'Check Again' } }
    // No Try Again the server would refuse.
    if (!status.remoteApply) return { tone: 'error', text, hint: LEFT_TO_ITS_MACHINE }
    return { tone: 'error', text, action: { kind: 'apply', label: 'Try Again', version: status.latest } }
  }
  if (status.latest) {
    const text = `Update available: ${shown(status.latest)}`
    if (!status.remoteApply) return { tone: 'available', text, hint: LEFT_TO_ITS_MACHINE }
    return { tone: 'available', text, action: { kind: 'apply', label: 'Update', version: status.latest } }
  }
  if (opts.checked) return { tone: 'done', text: `trek-server ${shown(status.current)} is the latest version` }
  if (last && last.ok && last.to === status.current) return { tone: 'done', text: `Updated to ${shown(last.to)}` }
  return null
}

export interface ServerUpdateConfirm {
  message: string
  detail: string
  buttons: [string, string]
}

/** The question before the app asks a server to install `status.latest`. The first button installs. */
export function serverUpdateConfirm(serverName: string, status: UpdateStatus): ServerUpdateConfirm {
  const sessions = Number.isInteger(status.sessions) && status.sessions > 0 ? status.sessions : 0
  // The Local server's restart question says the same of its terminals (src/main/localServer.ts).
  const terminals =
    sessions === 0
      ? 'It has no terminals open.'
      : `${sessions === 1 ? 'Its 1 terminal closes' : `Its ${sessions} terminals close`}; agent sessions resume when you open their worktrees again.`
  const restart = status.canRelaunch
    ? `The server restarts into the new version. ${terminals}`
    : `This server cannot restart itself (its Node is older than 22.15): the new version is installed, and it keeps running ${shown(status.current)} until you restart it on that machine.`
  return {
    message: `Update trek-server on “${cut(serverName, MAX_NAME_CHARS)}” to ${status.latest ? shown(status.latest) : 'the latest version'}?`,
    detail: `It is running ${shown(status.current)}. ${restart}`,
    buttons: ['Update', 'Cancel']
  }
}

/**
 * Why the app does not ask the server to install, from the status it last heard; null when it
 * may ask. The server decides again when asked (`update.apply`'s CONFLICT reasons).
 */
export function applyUpdateRefusal(status: UpdateStatus | undefined): string | null {
  if (!status?.latest) return 'No update is available for this server'
  if (!status.remoteApply) return LEFT_TO_ITS_MACHINE
  if (status.state !== 'idle') return ALREADY_RUNNING
  return null
}

/** What the client SDK says when a refusal carried no message of its own (connection.ts) */
const NO_MESSAGE = 'request failed'

const REFUSALS: Record<string, string> = {
  stale: 'A newer release appeared: check again',
  busy: ALREADY_RUNNING,
  disabled: LEFT_TO_ITS_MACHINE
}

/**
 * A failed `update.check` or `update.apply` (the client SDK's ClientError: `code`, `message`,
 * `details.reason`) as one sentence for the row: the server's own when it sent one, else one
 * for the reason it refused.
 */
export function updateErrorText(err: unknown): string {
  if (!err || typeof err !== 'object') return cut(String(err), MAX_ERROR_CHARS)
  const { code, message, details } = err as { code?: unknown; message?: unknown; details?: { reason?: unknown } | null }
  if (code === 'NOT_CONNECTED') return 'Not connected to this server'
  if (code === 'TIMEOUT') return 'The server did not answer in time'
  const text = typeof message === 'string' && message !== NO_MESSAGE ? oneLine(message) : ''
  if (text) return text
  if (code === 'CONFLICT') {
    const reason = details?.reason
    return (typeof reason === 'string' && REFUSALS[reason]) || 'The server refused the update'
  }
  if (code === 'NOT_FOUND') return 'This server does not update itself'
  return typeof code === 'string' && code ? code : 'The request failed'
}

const STATES: readonly UpdateStatus['state'][] = ['idle', 'checking', 'downloading', 'installing', 'restarting']

/**
 * A server's `update.status` answer or `update.changed` payload, field by field: what main
 * remembers and every window is sent holds nothing else the server put there. Undefined when
 * it is not a status (no running version, or no known state).
 */
export function parseUpdateStatus(raw: unknown): UpdateStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const state = STATES.find((s) => s === r.state)
  if (typeof r.current !== 'string' || !r.current || !state) return undefined
  const status: UpdateStatus = {
    current: r.current,
    state,
    sessions: typeof r.sessions === 'number' && Number.isInteger(r.sessions) && r.sessions > 0 ? r.sessions : 0,
    canRelaunch: r.canRelaunch === true,
    restartNeeded: r.restartNeeded === true,
    remoteApply: r.remoteApply === true
  }
  if (typeof r.latest === 'string' && r.latest) status.latest = r.latest
  if (typeof r.percent === 'number' && Number.isFinite(r.percent)) status.percent = r.percent
  if (typeof r.checkedAt === 'string') status.checkedAt = r.checkedAt
  const last = r.lastResult as Record<string, unknown> | null | undefined
  if (last && typeof last === 'object' && typeof last.ok === 'boolean' && typeof last.from === 'string' && typeof last.to === 'string' && typeof last.at === 'string') {
    status.lastResult = { ok: last.ok, from: last.from, to: last.to, at: last.at, ...(typeof last.error === 'string' ? { error: last.error } : {}) }
  }
  return status
}
