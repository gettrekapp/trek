// Which topic a held snapshot belongs to (6a). Pure.
//
// A screen's view is kept with the key (server and topic) it came from. When the key changes (the
// screen now shows another session, project or server), what is held is for the old key: the
// screen sees loading, never the old snapshot for a render, until the new key's first update.
// Re-subscribing to the same key (a new connection) keeps the snapshot on screen.

export type View<S> = { state: 'loading' } | { state: 'ready'; snapshot: S } | { state: 'error'; message: string }

export interface HeldView<S> {
  key: string
  view: View<S>
}

const LOADING = { state: 'loading' } as const

export function viewFor<S>(held: HeldView<S> | null, key: string | null): View<S> {
  return held && key !== null && held.key === key ? held.view : LOADING
}
