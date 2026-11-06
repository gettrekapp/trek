// The renderer's one ServerRegistry (3a SDK) over the main-process relay. Each
// registered "url" is the app-server entry id: main looks up the real URL and
// injects the stored token into hello, so the SDK's token is always ''. After a
// token change or a URL save, call `connection.reconnect()` on the entry.
import { ServerRegistry, type RegisteredServer } from '../../../shared/client/index.ts'
import { ipcSocketFactory } from './ipcSocket.ts'
import { version } from '../../../../package.json'

let registry: ServerRegistry | null = null

function servers(): ServerRegistry {
  registry ??= new ServerRegistry({
    createSocket: ipcSocketFactory(window.api.v2Socket),
    client: 'trek-desktop',
    clientVersion: version
  })
  return registry
}

/** The registered server for this entry, connecting it if it isn't registered yet. */
export function connectServerEntry(entryId: string): RegisteredServer {
  const reg = servers()
  return reg.get(entryId) ?? reg.add({ id: entryId, url: entryId, token: '' })
}

/** The registered server if any, without connecting. */
export function registeredServerEntry(entryId: string): RegisteredServer | undefined {
  return registry?.get(entryId)
}

/** Closes and forgets the entry's connection (for example once the entry is removed). */
export function dropServerEntry(entryId: string): void {
  registry?.remove(entryId)
}
