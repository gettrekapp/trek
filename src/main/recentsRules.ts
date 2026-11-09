// Recent projects of both kinds, as stored in recent-projects.json. Pure.
import type { RecentEntry } from '../shared/types.ts'
import { isTargetId } from './windowRules.ts'

export type { RecentEntry }

export const MAX_RECENTS = 8

export function parseRecents(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return []
  const out: RecentEntry[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item) out.push({ kind: 'file', path: item })
    else if (item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'server') {
      const r = item as Record<string, unknown>
      // Labels may be empty (a server without a configured name); the ids may not, nor be over-long.
      const ids = [r.serverEntryId, r.projectId].every(isTargetId)
      const labels = [r.name, r.serverName].every((v) => typeof v === 'string')
      if (ids && labels) {
        out.push({ kind: 'server', serverEntryId: r.serverEntryId as string, projectId: r.projectId as string, name: r.name as string, serverName: r.serverName as string })
      }
    }
  }
  return out
}

function sameEntry(a: RecentEntry, b: RecentEntry): boolean {
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'server' && b.kind === 'server') return a.serverEntryId === b.serverEntryId && a.projectId === b.projectId
  return false
}

export function addRecentEntry(list: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...list.filter((e) => !sameEntry(e, entry))].slice(0, MAX_RECENTS)
}

/** File entries stay plain strings on disk, so an older Trek can still read them. */
export function serializeRecents(list: readonly RecentEntry[]): unknown[] {
  return list.map((e) => (e.kind === 'file' ? e.path : e))
}

/** Drops file entries listed in `missingFiles`; server entries are never dropped here. */
export function keepRecents(list: readonly RecentEntry[], missingFiles: ReadonlySet<string>): RecentEntry[] {
  return list.filter((e) => e.kind !== 'file' || !missingFiles.has(e.path))
}

/**
 * Keeps each file of `paths` listed: one not listed yet goes at the end while there is room (4e:
 * a window on a .trekproj never imported is not restored, and its file stays on the start screen
 * to import). Listed entries never move or go.
 */
export function keepFileRecents(list: readonly RecentEntry[], paths: readonly string[]): RecentEntry[] {
  const out = [...list]
  for (const path of paths) {
    const entry: RecentEntry = { kind: 'file', path }
    if (out.length < MAX_RECENTS && !out.some((e) => sameEntry(e, entry))) out.push(entry)
  }
  return out
}

export function removeRecentEntry(list: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return list.filter((e) => !sameEntry(e, entry))
}

/** An entry named over IPC, for removal: only the identifying fields matter, and they are validated. */
export function parseRecentRef(raw: unknown): RecentEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'file') return typeof r.path === 'string' && r.path ? { kind: 'file', path: r.path } : null
  if (r.kind === 'server') {
    const { serverEntryId, projectId } = r
    if (typeof serverEntryId !== 'string' || !serverEntryId || typeof projectId !== 'string' || !projectId) return null
    return { kind: 'server', serverEntryId, projectId, name: '', serverName: '' }
  }
  return null
}
