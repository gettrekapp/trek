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

export type WindowTarget =
  | { kind: 'file'; path: string }
  | { kind: 'server'; serverEntryId: string; projectId: string }

/** File paths are compared as given; callers normalize them (realpath) first. */
export function sameTarget(a: WindowTarget, b: WindowTarget): boolean {
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'server' && b.kind === 'server') return a.serverEntryId === b.serverEntryId && a.projectId === b.projectId
  return false
}

export interface OpenWindowEntry {
  target: WindowTarget
  bounds?: WindowBounds
}

function targetKey(t: WindowTarget): string {
  return t.kind === 'file' ? `file\0${t.path}` : `server\0${t.serverEntryId}\0${t.projectId}`
}

function readTarget(item: Record<string, unknown>): WindowTarget | null {
  const str = (v: unknown): v is string => typeof v === 'string' && v !== ''
  if (item.kind === 'server') {
    return str(item.serverEntryId) && str(item.projectId) ? { kind: 'server', serverEntryId: item.serverEntryId, projectId: item.projectId } : null
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

/** File windows keep the legacy shape so an older Trek can still read the file. */
export function serializeOpenWindow(entry: OpenWindowEntry): Record<string, unknown> {
  const bounds = entry.bounds ? { bounds: entry.bounds } : {}
  return entry.target.kind === 'file'
    ? { filePath: entry.target.path, ...bounds }
    : { kind: 'server', serverEntryId: entry.target.serverEntryId, projectId: entry.target.projectId, ...bounds }
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
