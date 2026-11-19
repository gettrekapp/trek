// The campsite's prefs, one store per host shared by every component that reads them: one load and
// one change feed while anything listens. A set shows at once, then the saved value wins (a failed
// save reloads); an answer older than a later set or change is dropped. No React.
import type { ClientPluginHost } from '../../../src/shared/plugins/client.ts'
import { DEFAULT_PREFS, readPrefs, type CampsitePrefKey, type CampsitePrefs } from '../shared/prefs.ts'

export interface PrefsSnapshot {
  /** False until the first load answers (or fails: then the defaults) */
  loaded: boolean
  prefs: CampsitePrefs
}
export interface PrefsStore {
  subscribe(listener: () => void): () => void
  /** The same object until something changes */
  snapshot(): PrefsSnapshot
  set(key: CampsitePrefKey, value: boolean): void
}

type PrefsHost = Pick<ClientPluginHost, 'prefs'>
const stores = new WeakMap<PrefsHost, PrefsStore>()

export function prefsStore(host: PrefsHost): PrefsStore {
  let store = stores.get(host)
  if (!store) stores.set(host, (store = createStore(host)))
  return store
}

function createStore(host: PrefsHost): PrefsStore {
  let state: PrefsSnapshot = { loaded: false, prefs: DEFAULT_PREFS }
  const listeners = new Set<() => void>()
  let off: (() => void) | null = null
  // Bumped by every set and change, so an answer to an older request can tell it is stale
  let version = 0

  // The full stored prefs (a load, a change, a saved set's answer) mark it loaded; an optimistic set does not
  const emit = (prefs: CampsitePrefs, loaded = true): void => {
    state = { loaded, prefs }
    for (const l of listeners) l()
  }
  const load = (): void => {
    const asked = version
    host.prefs.load().then(
      (raw) => {
        if (version === asked) emit(readPrefs(raw))
      },
      (err) => {
        console.warn('Campsite preferences could not be read', err)
        if (!state.loaded) emit(state.prefs)
      }
    )
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (!off) {
        off = host.prefs.onChange((raw) => {
          version++
          emit(readPrefs(raw))
        })
        load()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && off) {
          off()
          off = null
        }
      }
    },
    snapshot: () => state,
    set(key, value) {
      const mine = ++version
      emit({ ...state.prefs, [key]: value }, state.loaded)
      host.prefs.set(key, value).then(
        (raw) => {
          if (version === mine) emit(readPrefs(raw))
        },
        (err) => {
          console.warn('Campsite preference could not be saved', err)
          if (version === mine) load()
        }
      )
    }
  }
}
