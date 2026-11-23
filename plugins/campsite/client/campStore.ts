// The camp's snapshot (campsite parts 2, 3a and 3b), one store per host shared by every component:
// one `state` request and one event feed while anything listens; reloaded when the connection comes
// back. null until the first answer (or if the server half is missing). Buying (build, recruit,
// gear) and pinning answer the new snapshot; a refusal reloads the state and rethrows, its message
// saying why. A member's journal is asked for on its own (the snapshot doesn't carry it). `seen` and
// `awaySeen` keep the away card. No React.
import type { ClientPluginHost } from '../../../src/shared/plugins/client.ts'
import type { CampSnapshot, PinRef } from '../shared/camp.ts'
import type { GearSlot } from '../shared/catalog.ts'
import type { JournalEntry } from '../shared/journal.ts'
import type { Offer } from '../shared/shop.ts'

type CampHost = Pick<ClientPluginHost, 'request' | 'onEvent' | 'onChanged'>
export interface CampStore {
  subscribe(listener: () => void): () => void
  snapshot(): CampSnapshot | null
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
  /** A visible window saw the camp (an older server without it is ignored) */
  seen(): void
  /** The away card was dismissed */
  awaySeen(): Promise<void>
}
const stores = new WeakMap<CampHost, CampStore>()

export function campStore(host: CampHost): CampStore {
  let store = stores.get(host)
  if (!store) stores.set(host, (store = createStore(host)))
  return store
}

function createStore(host: CampHost): CampStore {
  let state: CampSnapshot | null = null
  const listeners = new Set<() => void>()
  let offs: (() => void)[] = []
  // Bumped by every event and purchase, so a load answer older than it is dropped
  let version = 0
  const set = (next: CampSnapshot | null): void => {
    state = next
    for (const l of listeners) l()
  }
  const load = (): void => {
    const asked = version
    host.request<CampSnapshot>('state').then(
      (snap) => {
        if (asked === version) set(snap)
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
    build: (offer) => buy('build', { id: offer.id, tier: offer.tier, cost: { wood: offer.cost.wood, markers: offer.cost.markers } }),
    recruit: (candidate, cost) => buy('recruit', { candidate, cost: { wood: cost } }),
    gear: (crewId, slot, tier, cost) => buy('gear', { crewId, slot, tier, cost: { wood: cost } }),
    pin: (crewId, pin) => buy('pin', { crewId, pin: pin && { kind: pin.kind, id: pin.id } }),
    journal: async (crewId) => (await host.request<{ journal: JournalEntry[] }>('journal', { crewId })).journal,
    seen: () => {
      host.request('seen').catch(() => {
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
