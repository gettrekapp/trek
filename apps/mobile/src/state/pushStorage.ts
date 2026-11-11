// Background push's secrets on the phone (6b), in secure storage beside the servers' tokens: this
// device's registration at the relay (its secret), each paired server's grant (its secret and the
// three switches), and "Pause all pushes".
import * as SecureStore from 'expo-secure-store'
import type { RelayDevice, ServerPush } from '../logic/push.ts'

const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }
const DEVICE_KEY = 'trek.push.device'
const PAUSED_KEY = 'trek.push.paused'
const serverKey = (entryId: string): string => `trek.push.server.${entryId.replace(/[^A-Za-z0-9._-]/g, '_')}`

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await SecureStore.getItemAsync(key, OPTIONS)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export const pushStorage = {
  device: () => readJson<RelayDevice>(DEVICE_KEY),
  setDevice: (d: RelayDevice | null) => (d ? SecureStore.setItemAsync(DEVICE_KEY, JSON.stringify(d), OPTIONS) : SecureStore.deleteItemAsync(DEVICE_KEY, OPTIONS)),
  server: (entryId: string) => readJson<ServerPush>(serverKey(entryId)),
  setServer: (entryId: string, p: ServerPush | null) =>
    p ? SecureStore.setItemAsync(serverKey(entryId), JSON.stringify(p), OPTIONS) : SecureStore.deleteItemAsync(serverKey(entryId), OPTIONS),
  paused: async () => (await SecureStore.getItemAsync(PAUSED_KEY, OPTIONS)) === '1',
  setPaused: (paused: boolean) => SecureStore.setItemAsync(PAUSED_KEY, paused ? '1' : '0', OPTIONS)
}
