// What the store's project setters (store.ts `ProjectSetter`: the session, branch-data and
// settings edits) do: the server window's requests, which installV2.ts sets for the project it
// shows and clears when it leaves. Nothing changes in the store: the mirror's patch does. With none
// set (an empty window, no project) the setters do nothing.
//
// Pure: imported by tests.
import type { AppState, ProjectSetter, ProjectSetters } from './store'

let current: ProjectSetters | null = null

export function setProjectSetters(setters: ProjectSetters | null): void {
  current = setters
}

/** A store setter that calls the project setter of the same name, looked up at the time of the call. */
export function viaServer<K extends ProjectSetter>(name: K): AppState[K] {
  return ((...args: unknown[]) => {
    const setter = current?.[name] as ((...args: unknown[]) => void) | undefined
    setter?.(...args)
  }) as AppState[K]
}
