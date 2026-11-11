// The paired servers (6a): the list (name and URL) and each one's token, both in the device's
// secure storage (Keychain / Android Keystore). Only this module and the connection layer read a
// token; it is never logged or shown.
import * as SecureStore from 'expo-secure-store'

export interface SavedServer {
  /** The phone's id for the entry (the server's own serverId when known) */
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

/** Adds or replaces the entry with that id, and stores its token. */
export async function saveServer(server: SavedServer, token: string): Promise<void> {
  await SecureStore.setItemAsync(tokenKey(server.id), token, OPTIONS)
  const list = (await loadServers()).filter((s) => s.id !== server.id)
  await saveList([...list, server])
}

/** Forgets the entry and its token on this phone (the token stays valid on the server until revoked). */
export async function forgetServer(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(tokenKey(id), OPTIONS)
  await saveList((await loadServers()).filter((s) => s.id !== id))
}
