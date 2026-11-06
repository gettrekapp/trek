// Recent projects of both kinds, as stored in recent-projects.json. Pure.
export const MAX_RECENTS = 8

export type RecentEntry =
  | { kind: 'file'; path: string }
  | { kind: 'server'; serverEntryId: string; projectId: string; name: string; serverName: string }

export function parseRecents(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return []
  const out: RecentEntry[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item) out.push({ kind: 'file', path: item })
    else if (item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'server') {
      const r = item as Record<string, unknown>
      if ([r.serverEntryId, r.projectId, r.name, r.serverName].every((v) => typeof v === 'string' && v !== '')) {
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
