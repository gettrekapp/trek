// A topic's snapshot while a screen shows it, subscribed through the server's SDK mirror (and
// unsubscribed when the screen goes); again after that server's connection is made again.
import { useEffect, useState } from 'react'
import type { RegisteredServer, Topic, TopicSnapshot } from '../shared.ts'
import { connectionNotice, type KnownStatus } from '../logic/connection.ts'
import { viewFor, type HeldView } from '../logic/topicView.ts'
import { useServers } from './ServersProvider.tsx'

export type TopicView<T extends Topic> = { state: 'loading' } | { state: 'ready'; snapshot: TopicSnapshot<T> } | { state: 'error'; message: string }

export function useTopic<T extends Topic>(serverId: string, topic: T | null): TopicView<T> {
  const { get, generationOf } = useServers()
  const generation = generationOf(serverId)
  // The view is held with the server and topic it came from (topicView.ts): another key shows
  // loading at once, never the old snapshot; re-subscribing to the same one (a new connection)
  // keeps the last snapshot on screen until the new one comes, instead of a flash of Loading
  // (and, on the session screen, a remounted terminal).
  const key = topic ? `${serverId}\n${topic}` : null
  const [held, setHeld] = useState<HeldView<TopicSnapshot<T>> | null>(null)
  useEffect(() => {
    if (!topic || key === null) return
    const server = get(serverId)
    if (!server) {
      setHeld({ key, view: { state: 'error', message: 'Not connected' } })
      return
    }
    return server.mirror.subscribe(topic, (update) => {
      if ('error' in update) setHeld({ key, view: { state: 'error', message: update.error.message } })
      else setHeld({ key, view: { state: 'ready', snapshot: update.snapshot as TopicSnapshot<T> } })
    })
    // get is stable; this server's generation says when its connection changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, topic, key, generation])
  return viewFor(held, key) as TopicView<T>
}

/** The server's live connection, or undefined (out of the foreground, or not paired). */
export function useServer(serverId: string): RegisteredServer | undefined {
  const { get, generationOf } = useServers()
  void generationOf(serverId)
  return get(serverId)
}

/** The server's connection status as the server list shows it; undefined before it is known. */
export function useServerStatus(serverId: string): KnownStatus {
  const { ready, servers } = useServers()
  if (!ready) return undefined
  return servers.find((s) => s.id === serverId)?.status
}

/** "Reconnecting…" (or why not connected) for the top of a screen; null while connected. */
export function useConnectionNotice(serverId: string): string | null {
  return connectionNotice(useServerStatus(serverId))
}

/** The server's error message, as the server worded it. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
