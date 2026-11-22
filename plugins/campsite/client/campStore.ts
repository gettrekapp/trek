// The camp's snapshot (campsite part 2), one store per host shared by every component: one
// `state` request and one event feed while anything listens; reloaded when the connection comes
// back. null until the first answer (or if the server half is missing). No React.
import type { ClientPluginHost } from '../../../src/shared/plugins/client.ts'
import type { CampSnapshot } from '../shared/camp.ts'

type CampHost = Pick<ClientPluginHost, 'request' | 'onEvent' | 'onChanged'>
export interface CampStore {
  subscribe(listener: () => void): () => void
  snapshot(): CampSnapshot | null
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
  // Bumped by every event, so a load answer older than it is dropped
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
    snapshot: () => state
  }
}
