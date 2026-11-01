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

export interface OpenWindowEntry {
  filePath: string
  bounds?: WindowBounds
}

function isBounds(value: unknown): value is WindowBounds {
  if (typeof value !== 'object' || value === null) return false
  const b = value as Record<string, unknown>
  return [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))
}

/** Tolerates anything on disk: bad entries are dropped, and a project appears once. */
export function parseOpenWindows(raw: unknown): OpenWindowEntry[] {
  if (!Array.isArray(raw)) return []
  const entries = new Map<string, OpenWindowEntry>()
  for (const item of raw) {
    const filePath = (item as { filePath?: unknown } | null)?.filePath
    if (typeof filePath !== 'string' || !filePath || entries.has(filePath)) continue
    const bounds = (item as { bounds?: unknown }).bounds
    entries.set(filePath, isBounds(bounds) ? { filePath, bounds } : { filePath })
  }
  return [...entries.values()]
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
