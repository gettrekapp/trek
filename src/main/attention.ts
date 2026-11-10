// Main's attention aggregator: the `attention` topic of every app-wide server
// main is connected to (serverLinks.ts), merged into one list that every window
// hears through `attention:changed`, and the new entries that deserve an OS
// notification. No Electron imports: notifications.ts raises the notifications,
// plays the sound and sends the broadcast; a test drives this with fakes.
//
// Notify once: an entry is new when its key is new or its moment moved: the
// decision's `at` for a decision, `since` for attention or done. Both are the
// server's own times, unchanged by a reconnect or a resubscribe, so a snapshot
// that repeats what was seen raises nothing. The first snapshot after a link
// is made (app start, a server added, a token or URL change) is the baseline:
// listed, never raised. What a server already had waiting is in the menu, not
// a burst of notifications. Later snapshots, a reconnect's included, raise
// only what was not seen before on that link: what came up while it was down.
import type { ConnectionStatus, MirrorListener } from '../shared/client/index.ts'
import type { AttentionEntry } from '../shared/model/types.ts'
import type { AttentionChanged, AttentionItem } from '../shared/types.ts'

/** What the aggregator needs of a RegisteredServer (serverLinks hands it one). */
export interface AttentionSource {
  connection: {
    readonly status: ConnectionStatus
    on(kind: 'status', listener: (change: { status: ConnectionStatus }) => void): () => void
  }
  mirror: { subscribe(topic: 'attention', listener: MirrorListener<'attention'>): () => void }
}

export type AttentionKind = 'decision' | 'attention' | 'done' | 'pullRequest'

/** A new entry: what it is, and the item as listed. */
export interface AttentionEvent {
  kind: AttentionKind
  item: AttentionItem
  /** The project's audioAlerts setting is on */
  audioAlerts: boolean
}

export interface AttentionDeps {
  /** The user's name for the entry, as the list has it now */
  serverName(id: string): string
  /** Every change to the merged list */
  changed(snapshot: AttentionChanged): void
  /** New entries, once each; never for a baseline snapshot */
  raised(events: AttentionEvent[]): void
}

export interface Attention {
  /** A new connection for the entry (a new URL included): subscribe; its first snapshot is the baseline */
  linked(id: string, source: AttentionSource): void
  /** The entry's connection is gone: unsubscribe and drop its items */
  unlinked(id: string): void
  /** The server list changed (a rename): re-label, broadcast if anything changed */
  relabel(): void
  snapshot(): AttentionChanged
  find(key: string): AttentionItem | undefined
  /** Unsubscribes everything; no more broadcasts (quit) */
  close(): void
}

/** What was seen of an entry: its moments, so the same moment is never raised twice. */
interface Seen {
  flagged: number | null
  decided: number | null
}

interface Linked {
  off: () => void
  offStatus: () => void
  /** Entries as of the last snapshot */
  entries: AttentionEntry[]
  /** The first snapshot has come: later ones may raise */
  baselined: boolean
  seen: Map<string, Seen>
  /** A topic error (or a malformed payload) since the last snapshot */
  failed: boolean
  /** The connection went down since the last snapshot: shown stale until the next one */
  down: boolean
}

export function attentionKey(serverEntryId: string, projectId: string, sessionId: string): string {
  return JSON.stringify([serverEntryId, projectId, sessionId])
}

/** An entry's key: its session's, or for a pull request notice (no session, 5c-1) its worktree's. */
const keyOfEntry = (serverEntryId: string, e: AttentionEntry): string =>
  attentionKey(serverEntryId, e.projectId, e.sessionId || `worktree:${e.worktreeId ?? ''}`)

const isFlagged = (status: unknown): boolean => status === 'attention' || status === 'done'

/** A server's entry with the fields this needs; anything else is skipped. */
function wellFormed(e: unknown): e is AttentionEntry {
  if (!e || typeof e !== 'object') return false
  const x = e as Record<string, unknown>
  if (typeof x.projectId !== 'string' || typeof x.sessionId !== 'string') return false
  if (x.worktreeId !== null && typeof x.worktreeId !== 'string') return false
  if (typeof x.title !== 'string' || typeof x.status !== 'string' || typeof x.since !== 'number') return false
  if (x.decision !== undefined) {
    const d = x.decision as Record<string, unknown> | null
    if (!d || typeof d.question !== 'string' || typeof d.at !== 'number') return false
  }
  if (x.pullRequest !== undefined) {
    const n = x.pullRequest as Record<string, unknown> | null
    if (!n || typeof n.text !== 'string' || typeof x.worktreeId !== 'string') return false
  } else if (x.sessionId === '') return false
  return true
}

/** The moment that makes an entry new, and its kind; null when it is listed for nothing new. */
export function newMoment(entry: AttentionEntry, prev: Seen | undefined): AttentionKind | null {
  if (entry.pullRequest) return entry.since !== (prev?.flagged ?? null) ? 'pullRequest' : null
  const decided = entry.decision?.at ?? null
  if (decided !== null && decided !== (prev?.decided ?? null)) return 'decision'
  const flagged = isFlagged(entry.status) ? entry.since : null
  if (flagged !== null && flagged !== (prev?.flagged ?? null)) return entry.status === 'done' ? 'done' : 'attention'
  return null
}

function seenOf(entry: AttentionEntry): Seen {
  if (entry.pullRequest) return { flagged: entry.since, decided: null }
  return { flagged: isFlagged(entry.status) ? entry.since : null, decided: entry.decision?.at ?? null }
}

/** Newest first: a decision by when it was asked, else by since. */
const momentOf = (item: AttentionItem): number => item.askedAt ?? item.since

export function createAttention(deps: AttentionDeps): Attention {
  const links = new Map<string, Linked>()
  let seq = 0
  let closed = false
  /** The last list sent, as JSON: relabel broadcasts only a real change */
  let lastSent = '[]'

  // Field by field: nothing from the server's entry is spread, so nothing else reaches a window.
  const item = (id: string, link: Linked, e: AttentionEntry): AttentionItem => {
    const out: AttentionItem = {
      key: keyOfEntry(id, e),
      serverEntryId: id,
      serverName: deps.serverName(id),
      projectId: e.projectId,
      projectName: typeof e.projectName === 'string' ? e.projectName : '',
      worktreeId: e.worktreeId,
      sessionId: e.sessionId,
      title: e.title,
      status: e.status,
      since: e.since
    }
    if (e.decision) {
      out.question = e.decision.question
      out.askedAt = e.decision.at
    }
    if (e.pullRequest) out.pullRequest = e.pullRequest.text
    if (link.failed || link.down) out.stale = true
    return out
  }

  const items = (): AttentionItem[] => {
    const out: AttentionItem[] = []
    for (const [id, link] of links) for (const e of link.entries) out.push(item(id, link, e))
    return out.sort((a, b) => momentOf(b) - momentOf(a))
  }

  const snapshot = (): AttentionChanged => ({ seq, items: items() })

  const emit = (): void => {
    if (closed) return
    seq++
    const next = snapshot()
    lastSent = JSON.stringify(next.items)
    deps.changed(next)
  }

  const update = (id: string, link: Linked, entries: AttentionEntry[]): void => {
    // Fresh data first: the events' items are built below and must not carry the old stale flag.
    link.failed = false
    link.down = false
    const events: AttentionEvent[] = []
    const seen = new Map<string, Seen>()
    for (const e of entries) {
      const key = keyOfEntry(id, e)
      const kind = link.baselined ? newMoment(e, link.seen.get(key)) : null
      if (kind) events.push({ kind, item: item(id, link, e), audioAlerts: e.audioAlerts === true })
      seen.set(key, seenOf(e))
    }
    // An entry gone from the list is forgotten, as the server forgets its since.
    link.seen = seen
    link.entries = entries
    link.baselined = true
    emit()
    if (events.length > 0) deps.raised(events)
  }

  const markFailed = (link: Linked): void => {
    if (link.failed) return
    link.failed = true
    if (link.entries.length > 0) emit()
  }

  const unlinked = (id: string): void => {
    const link = links.get(id)
    if (!link) return
    links.delete(id)
    link.off()
    link.offStatus()
    if (link.entries.length > 0) emit()
  }

  return {
    linked: (id, source) => {
      if (closed) return
      unlinked(id)
      const link: Linked = {
        off: () => {},
        offStatus: () => {},
        entries: [],
        baselined: false,
        seen: new Map(),
        failed: false,
        down: source.connection.status !== 'connected'
      }
      links.set(id, link)
      link.offStatus = source.connection.on('status', ({ status }) => {
        // Shown stale from the moment it goes down. Coming back clears nothing: the
        // resubscribe's snapshot does, so the items are never shown fresh before fresh data.
        if (status === 'connected' || link.down) return
        link.down = true
        if (links.get(id) === link && link.entries.length > 0) emit()
      })
      link.off = source.mirror.subscribe('attention', (u) => {
        if (links.get(id) !== link) return
        if ('error' in u) {
          // CLOSED: the link is going (unlinked follows).
          if (u.error.code === 'CLOSED') return
          // TOPIC_ENDED is final: the topic never comes back on this connection, so its entries go.
          if (u.error.code === 'TOPIC_ENDED') {
            const had = link.entries.length > 0
            link.entries = []
            link.seen = new Map()
            link.failed = false
            if (had) emit()
            return
          }
          // Anything else: keep the last entries, stale.
          markFailed(link)
          return
        }
        const raw = (u.snapshot as { entries?: unknown } | null)?.entries
        // A payload without an entries list says nothing: keep what was seen (and the seen
        // map, so nothing is raised again), shown stale, until a well-formed snapshot.
        if (!Array.isArray(raw)) {
          markFailed(link)
          return
        }
        update(id, link, raw.filter(wellFormed))
      })
    },
    unlinked,
    relabel: () => {
      if (closed || links.size === 0) return
      if (JSON.stringify(items()) !== lastSent) emit()
    },
    snapshot,
    find: (key) => items().find((i) => i.key === key),
    close: () => {
      closed = true
      for (const id of [...links.keys()]) unlinked(id)
    }
  }
}
