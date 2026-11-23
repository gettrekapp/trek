// The camp's snapshot (campsite parts 2, 3a, 3b and 3c), one store per host shared by every
// component: one `state` request (naming the window's project, so the server reconciles its trails)
// and one event feed while anything listens; reloaded when the connection comes back. null until the
// first answer (or if the server half is missing). Buying (build, recruit, gear) and pinning answer
// the new snapshot; a refusal reloads the state and rethrows, its message saying why. A member's
// journal and a project's trail history are asked for on their own (the snapshot carries neither).
// `seen` and `awaySeen` keep the away card; `seen` also tells the server the window's time zone and
// Seasons setting (part 3d-2: they gate the wildlife). Real chores (part 4): each session's latest
// tool call, from the `state` answer (its project's, with their ages) and the `tool` events, stamped
// with this window's clock when heard; kept beside the snapshot (a pushed state has none). Agents in
// the camp (part 5): the window's project's noticeboard notes, asked for on their own (`loadNotes`;
// the newest answer wins) and added to by `note` events once loaded; a trail log comes with its
// project's open trails' reports. No React.
import { agentTool } from '../../../src/shared/plugins/agents.ts'
import type { ClientPluginHost } from '../../../src/shared/plugins/client.ts'
import type { CampSnapshot, PinRef } from '../shared/camp.ts'
import type { GearSlot } from '../shared/catalog.ts'
import type { JournalEntry } from '../shared/journal.ts'
import { NOTES_MAX, isNote, isReport, type Note, type TrailReport } from '../shared/notes.ts'
import type { Hemisphere } from '../shared/world.ts'
import type { HikerTool } from '../shared/pose.ts'
import type { Offer } from '../shared/shop.ts'
import type { TrailRecord } from '../shared/trails.ts'

type CampHost = Pick<ClientPluginHost, 'request' | 'onEvent' | 'onChanged'> & Partial<Pick<ClientPluginHost, 'projectId'>>
/** The window's project's notes (part 5), oldest first: not asked for yet, being read (the last list kept), read, or the last read failed */
export interface NotesState {
  status: 'idle' | 'loading' | 'ready' | 'failed'
  list: readonly Note[]
}
/** A project's trail history and its open trails' reports by worktree (part 5; an older server: none) */
export interface TrailLog {
  log: TrailRecord[]
  reports: Record<string, TrailReport>
}
export interface CampStore {
  subscribe(listener: () => void): () => void
  snapshot(): CampSnapshot | null
  /** Each session's latest tool call (part 4) by terminalId; a new object when one changes */
  tools(): Readonly<Record<string, HikerTool>>
  /** Builds a building's next tier at its offered price */
  build(offer: Offer): Promise<void>
  /** Hires one of today's walk-ins at `cost` wood */
  recruit(candidate: string, cost: number): Promise<void>
  /** Buys a member's next item in `slot` (its tier) at `cost` wood */
  gear(crewId: string, slot: GearSlot, tier: number, cost: number): Promise<void>
  /** Pins a member to a session type or an agent (null: any session) */
  pin(crewId: string, pin: PinRef | null): Promise<void>
  /** A member's journal, oldest first (a refusal rethrows; nothing is reloaded) */
  journal(crewId: string): Promise<JournalEntry[]>
  /** A project's ended trails, oldest first, and its open trails' reports (a refusal rethrows; nothing is reloaded) */
  trailLog(projectId: string): Promise<TrailLog>
  /** The window's project's notes (part 5): a new object when they change */
  notes(): NotesState
  /** Asks for the window's project's notes again (none without a project) */
  loadNotes(): void
  /** A visible window saw the camp, with its time zone and Seasons setting (an older server without it is ignored) */
  seen(clock: { tz: string; seasons: Hemisphere }): void
  /** The away card was dismissed */
  awaySeen(): Promise<void>
}
const stores = new WeakMap<CampHost, CampStore>()

/** A tool call as heard at `at` (this window's ms), or null when it is not one */
function heardTool(value: unknown, at: number): HikerTool | null {
  const tool = agentTool(value)
  return tool && { ...tool, at }
}

/** The `state` answer's tools (by session, with their ages), placed on this window's clock; none from an older server */
function toolsFrom(value: unknown, now: number): Record<string, HikerTool> {
  const out: Record<string, HikerTool> = {}
  if (!value || typeof value !== 'object') return out
  for (const [terminalId, entry] of Object.entries(value as Record<string, unknown>)) {
    const age = (entry as { age?: unknown } | null)?.age
    const tool = heardTool(entry, now - (typeof age === 'number' && Number.isFinite(age) && age > 0 ? age : 0))
    if (tool) out[terminalId] = tool
  }
  return out
}

export function campStore(host: CampHost): CampStore {
  let store = stores.get(host)
  if (!store) stores.set(host, (store = createStore(host)))
  return store
}

function createStore(host: CampHost): CampStore {
  let state: CampSnapshot | null = null
  let tools: Readonly<Record<string, HikerTool>> = {}
  let notes: NotesState = { status: 'idle', list: [] }
  // Each notes request's number: only the newest answer lands
  let notesAsked = 0
  const setNotes = (next: NotesState): void => {
    notes = next
    notify()
  }
  const listeners = new Set<() => void>()
  let offs: (() => void)[] = []
  // Bumped by every event and purchase, so a load answer older than it is dropped
  let version = 0
  // Bumped by every tool event (not `version`: they come every few seconds, and a load must still land); each session's last one
  let toolSeq = 0
  const toolSeqOf = new Map<string, number>()
  const notify = (): void => {
    for (const l of listeners) l()
  }
  const set = (next: CampSnapshot | null): void => {
    state = next
    notify()
  }
  const load = (): void => {
    const asked = version
    const askedTools = toolSeq
    host.request<CampSnapshot & { tools?: unknown }>('state', host.projectId === undefined ? {} : { projectId: host.projectId }).then(
      (answer) => {
        // The window's project's tools ride on the answer only (an older server has none)
        let snap: CampSnapshot = answer
        let ages: unknown
        if (answer && typeof answer === 'object' && 'tools' in answer) {
          const { tools: given, ...rest } = answer
          ages = given
          snap = rest
        }
        // The answer's tools, less the sessions a tool event has spoken for since it was asked
        const next = toolsFrom(ages, Date.now())
        for (const [terminalId, seq] of toolSeqOf) {
          if (seq <= askedTools) continue
          if (Object.hasOwn(tools, terminalId)) next[terminalId] = tools[terminalId]
          else delete next[terminalId]
        }
        tools = next
        if (asked === version) set(snap)
        else notify()
      },
      () => {
        // An older server, or the plugin's server half missing: no counts
      }
    )
  }
  const buy = async (method: 'build' | 'recruit' | 'gear' | 'pin', params: Record<string, unknown>): Promise<void> => {
    let snap: CampSnapshot
    try {
      snap = await host.request<CampSnapshot>(method, params)
    } catch (err) {
      // Whatever the camp is now (the day turned, another window bought it), then the reason
      load()
      throw err
    }
    version++
    set(snap)
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        offs = [
          host.onEvent<CampSnapshot>('state', (snap) => {
            version++
            set(snap)
          }),
          host.onEvent<{ terminalId?: unknown; tool?: unknown }>('tool', (data) => {
            const terminalId = data?.terminalId
            if (typeof terminalId !== 'string') return
            toolSeqOf.set(terminalId, ++toolSeq)
            const tool = heardTool(data.tool, Date.now())
            const next = { ...tools }
            if (tool) next[terminalId] = tool
            else delete next[terminalId]
            tools = next
            notify()
          }),
          host.onEvent<{ projectId?: unknown; note?: unknown }>('note', (data) => {
            // This project's, once its notes are read (else the next read brings it)
            if (data?.projectId !== host.projectId || !isNote(data.note) || notes.status !== 'ready') return
            const note = data.note
            if (notes.list.some((n) => n.id === note.id)) return
            setNotes({ status: 'ready', list: [...notes.list, note].slice(-NOTES_MAX) })
          }),
          host.onChanged(load)
        ]
        load()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          for (const off of offs) off()
          offs = []
        }
      }
    },
    snapshot: () => state,
    tools: () => tools,
    build: (offer) => buy('build', { id: offer.id, tier: offer.tier, cost: { wood: offer.cost.wood, markers: offer.cost.markers } }),
    recruit: (candidate, cost) => buy('recruit', { candidate, cost: { wood: cost } }),
    gear: (crewId, slot, tier, cost) => buy('gear', { crewId, slot, tier, cost: { wood: cost } }),
    pin: (crewId, pin) => buy('pin', { crewId, pin: pin && { kind: pin.kind, id: pin.id } }),
    journal: async (crewId) => (await host.request<{ journal: JournalEntry[] }>('journal', { crewId })).journal,
    trailLog: async (projectId) => {
      const r = await host.request<{ log?: unknown; reports?: unknown }>('trailLog', { projectId })
      // An older server (no such request answers otherwise) or a bad reply: a failure, so Retry shows
      if (!r || !Array.isArray(r.log)) throw new Error('The trail log came back in a shape this version cannot read')
      // The reports (part 5): those this version can read; none from an older server
      const reports: Record<string, TrailReport> = {}
      if (r.reports && typeof r.reports === 'object') for (const [worktreeId, report] of Object.entries(r.reports)) if (isReport(report)) reports[worktreeId] = report
      return { log: r.log as TrailRecord[], reports }
    },
    notes: () => notes,
    loadNotes: () => {
      if (host.projectId === undefined) return
      const asked = ++notesAsked
      setNotes({ status: 'loading', list: notes.list })
      host.request<{ notes?: unknown }>('notes', { projectId: host.projectId }).then(
        (r) => {
          if (asked !== notesAsked) return
          // A bad reply is a failure (Retry); bad notes in a good one are left out
          if (!r || !Array.isArray(r.notes)) setNotes({ status: 'failed', list: notes.list })
          else setNotes({ status: 'ready', list: r.notes.filter(isNote) })
        },
        () => {
          if (asked === notesAsked) setNotes({ status: 'failed', list: notes.list })
        }
      )
    },
    seen: (clock) => {
      host.request('seen', { ...(host.projectId === undefined ? {} : { projectId: host.projectId }), tz: clock.tz, seasons: clock.seasons }).catch(() => {
        // An older server: no away card
      })
    },
    awaySeen: async () => {
      try {
        await host.request('awaySeen')
      } finally {
        // The push drops the card too; this is at once
        load()
      }
    }
  }
}
