// The app-wide server list with main's connection statuses, for components:
// one feed per window, following main's `appServers:changed` broadcast.
import { useSyncExternalStore } from 'react'
import { createLinksFeed, type LinksFeed, type LinksState } from './v2/appServerLinks'

let feed: LinksFeed | null = null

function links(): LinksFeed {
  feed ??= createLinksFeed(window.api.appServers)
  return feed
}

export function useAppServerLinks(): LinksState {
  const f = links()
  return useSyncExternalStore(f.subscribe, f.get)
}
