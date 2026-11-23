// The camp's snapshot (campsite parts 2 and 3a), one store per host shared by every component: one
// `state` request and one event feed while anything listens; reloaded when the connection comes
// back. null until the first answer (or if the server half is missing). Buying (build, recruit)
// answers the new snapshot; a refusal reloads the state and rethrows, its message saying why.
// `seen` and `awaySeen` keep the away card. No React.
import type { ClientPluginHost } from '../../../src/shared/plugins/client.ts'
import type { CampSnapshot } from '../shared/camp.ts'
import type { Offer } from '../shared/shop.ts'

type CampHost = Pick<ClientPluginHost, 'request' | 'onEvent' | 'onChanged'>
export interface CampStore {
  subscribe(listener: () => void): () => void
  snapshot(): CampSnapshot | null
  /** Builds a building's next tier at its offered price */
  build(offer: Offer): Promise<void>
  /** Hires one of today's walk-ins at `cost` wood */
  recruit(candidate: string, cost: number): Promise<void>
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
  const buy = async (method: 'build' | 'recruit', params: Record<string, unknown>): Promise<void> => {
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
