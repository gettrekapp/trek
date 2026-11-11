// A topic's snapshot while a screen shows it, subscribed through the server's SDK mirror (and
// unsubscribed when the screen goes); again after the connections are made again.
import { useEffect, useRef, useState } from 'react'
import type { RegisteredServer, Topic, TopicSnapshot } from '../shared.ts'
import { useServers } from './ServersProvider.tsx'

export type TopicView<T extends Topic> = { state: 'loading' } | { state: 'ready'; snapshot: TopicSnapshot<T> } | { state: 'error'; message: string }

export function useTopic<T extends Topic>(serverId: string, topic: T | null): TopicView<T> {
  const { get, generation } = useServers()
  const [view, setView] = useState<TopicView<T>>({ state: 'loading' })
  // Which server and topic the view shows: re-subscribing to the same one (a new connection)
  // keeps the last snapshot on screen until the new one comes, instead of a flash of Loading
  // (and, on the session screen, a remounted terminal).
  const shown = useRef<string | null>(null)
  useEffect(() => {
    if (!topic) return
    const server = get(serverId)
    if (!server) {
      shown.current = null
      setView({ state: 'error', message: 'Not connected' })
      return
    }
    const key = `${serverId}\n${topic}`
    if (shown.current !== key) setView({ state: 'loading' })
    shown.current = key
    return server.mirror.subscribe(topic, (update) => {
      if ('error' in update) setView({ state: 'error', message: update.error.message })
      else setView({ state: 'ready', snapshot: update.snapshot as TopicSnapshot<T> })
    })
    // get is stable per generation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, topic, generation])
  return view
}

/** The server's live connection, or undefined (out of the foreground, or not paired). */
export function useServer(serverId: string): RegisteredServer | undefined {
  const { get, generation } = useServers()
  void generation
  return get(serverId)
}

/** The server's error message, as the server worded it. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
