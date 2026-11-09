// A server window's `onEvent` (installV2.ts): the server's events of one name on the window's own
// connection (`docker.log`, `env.log`, sent to the requesting connection only). A reconnect keeps
// the connection, and so its listeners; once the window left, nothing is delivered or attached.
import type { ServerEvent } from '../../../shared/client/connection.ts'
import type { V2BackendDeps } from './backendV2'

export interface EventSource {
  on(kind: 'event', listener: (frame: ServerEvent) => void): () => void
}

export function windowEventSubscriber(connection: () => EventSource | undefined, left: () => boolean): V2BackendDeps['onEvent'] {
  return (event, listener) => {
    const source = left() ? undefined : connection()
    if (!source) return () => {}
    return source.on('event', (frame) => {
      if (!left() && frame.event === event) listener(frame.payload as Parameters<typeof listener>[0])
    })
  }
}
