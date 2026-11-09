export type OpenDecision = 'focus-existing' | 'new-window' | 'use-sender'

/** Where a project opens. Opening never replaces a project, so it never kills sessions. */
export function decideOpen(senderHasProject: boolean, fileAlreadyOpen: boolean): OpenDecision {
  if (fileAlreadyOpen) return 'focus-existing'
  return senderHasProject ? 'new-window' : 'use-sender'
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

function isBounds(value: unknown): value is WindowBounds {
  if (typeof value !== 'object' || value === null) return false
  const b = value as Record<string, unknown>
  return [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))
}

/**
 * What open-windows.json names. A window holds a server project; a `file` entry is what an older
 * Trek left (a window on a .trekproj): read so the import can map it, never reopened as one.
 */
export type WindowTarget =
  | { kind: 'file'; path: string }
  | { kind: 'server'; serverEntryId: string; projectId: string }

/** A window's project: a server entry's. */
export type ServerTarget = Extract<WindowTarget, { kind: 'server' }>

/** File paths are compared as given; callers normalize them (realpath) first. */
export function sameTarget(a: WindowTarget, b: WindowTarget): boolean {
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'server' && b.kind === 'server') return a.serverEntryId === b.serverEntryId && a.projectId === b.projectId
  return false
}

export interface OpenWindowEntry<T extends WindowTarget = WindowTarget> {
  target: T
  bounds?: WindowBounds
}

function targetKey(t: WindowTarget): string {
  return t.kind === 'file' ? `file\0${t.path}` : `server\0${t.serverEntryId}\0${t.projectId}`
}

/** The longest server entry id or project id accepted over IPC or from disk. */
export const MAX_TARGET_ID = 200

/** A server entry id or project id: a non-empty string of at most MAX_TARGET_ID characters. */
export function isTargetId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= MAX_TARGET_ID
}

function readTarget(item: Record<string, unknown>): WindowTarget | null {
  const str = (v: unknown): v is string => typeof v === 'string' && v !== ''
  if (item.kind === 'server') {
    return isTargetId(item.serverEntryId) && isTargetId(item.projectId) ? { kind: 'server', serverEntryId: item.serverEntryId, projectId: item.projectId } : null
  }
  if (item.kind === 'file') return str(item.path) ? { kind: 'file', path: item.path } : null
  return str(item.filePath) ? { kind: 'file', path: item.filePath } : null // legacy entry
}

/** Tolerates anything on disk: bad entries are dropped, and a target appears once. */
export function parseOpenWindows(raw: unknown): OpenWindowEntry[] {
  if (!Array.isArray(raw)) return []
  const entries = new Map<string, OpenWindowEntry>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const target = readTarget(item as Record<string, unknown>)
    if (!target || entries.has(targetKey(target))) continue
    const bounds = (item as { bounds?: unknown }).bounds
    entries.set(targetKey(target), isBounds(bounds) ? { target, bounds } : { target })
  }
  return [...entries.values()]
}

/** A window as open-windows.json stores it. */
export function serializeOpenWindow(entry: OpenWindowEntry<ServerTarget>): Record<string, unknown> {
  const bounds = entry.bounds ? { bounds: entry.bounds } : {}
  return { kind: 'server', serverEntryId: entry.target.serverEntryId, projectId: entry.target.projectId, ...bounds }
}

export function boundsOnScreen(bounds: WindowBounds, workAreas: WindowBounds[]): boolean {
  return workAreas.some(
    (area) =>
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
  )
}

/** What `window:takeInitial` hands a window: the server project to show, if any. */
export function initialFromTarget(target: ServerTarget | null): { serverEntryId: string; projectId: string } | null {
  return target ? { serverEntryId: target.serverEntryId, projectId: target.projectId } : null
}

/**
 * Where a "show this session" request (a click on a notification or a menu
 * entry) goes: to the window holding the project if its renderer is listening
 * (`send`), kept for that window's `window:takeInitial` while it is still
 * loading (`queue`), or to a new window for the project, which takes it with
 * its initial state (`open`).
 */
export function routeSelect(holder: { rendererReady: boolean } | undefined): 'send' | 'queue' | 'open' {
  if (!holder) return 'open'
  return holder.rendererReady ? 'send' : 'queue'
}

export const MAX_LABEL_LENGTH = 200

/** A display label from IPC: anything becomes a string, capped in length. */
export function capLabel(value: unknown): string {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value)
  return s.length > MAX_LABEL_LENGTH ? s.slice(0, MAX_LABEL_LENGTH) : s
}
