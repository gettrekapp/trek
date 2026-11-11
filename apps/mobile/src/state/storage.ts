// The paired servers (6a): the list (name and URL) and each one's token, both in the device's
// secure storage (Keychain / Android Keystore). Only this module and the connection layer read a
// token; it is never logged or shown.
import * as SecureStore from 'expo-secure-store'

export interface SavedServer {
  /**
   * The phone's own id for the entry, made when it is added (add-server.tsx), never the server's
   * reported serverId: it keys the token in secure storage, so a server can't pick (or collide)
   * the key. No migration: the app never shipped with entries keyed any other way.
   */
  id: string
  name: string
  url: string
}

const LIST_KEY = 'trek.servers'
const tokenKey = (id: string): string => `trek.token.${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }

export async function loadServers(): Promise<SavedServer[]> {
  const raw = await SecureStore.getItemAsync(LIST_KEY, OPTIONS)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is SavedServer => !!s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.url === 'string'
    )
  } catch {
    return []
  }
}

async function saveList(servers: SavedServer[]): Promise<void> {
  await SecureStore.setItemAsync(LIST_KEY, JSON.stringify(servers), OPTIONS)
}

export async function loadToken(id: string): Promise<string | null> {
  return SecureStore.getItemAsync(tokenKey(id), OPTIONS)
}

// The list is read, changed and written back: one change at a time, so two that overlap (a
// pairing while a removal is still writing) can't each write a list without the other's change.
let writes: Promise<unknown> = Promise.resolve()
function serially<T>(fn: () => Promise<T>): Promise<T> {
  const run = writes.then(fn, fn)
  writes = run.catch(() => {})
  return run
}

/** Adds or replaces the entry with that id, and stores its token. */
export function saveServer(server: SavedServer, token: string): Promise<void> {
  return serially(async () => {
    await SecureStore.setItemAsync(tokenKey(server.id), token, OPTIONS)
    const list = (await loadServers()).filter((s) => s.id !== server.id)
    await saveList([...list, server])
  })
}

/** Forgets the entry and its token on this phone (the token stays valid on the server until revoked). */
export function forgetServer(id: string): Promise<void> {
  return serially(async () => {
    await SecureStore.deleteItemAsync(tokenKey(id), OPTIONS)
    await saveList((await loadServers()).filter((s) => s.id !== id))
  })
}
