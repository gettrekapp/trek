// The push services the config names. Task 2 adds APNs and FCM; until then none is configured.
import type { Provider } from './api.ts'
import type { RelayConfig } from './config.ts'
import type { Platform } from './store.ts'

export function createProviders(_config: RelayConfig): Partial<Record<Platform, Provider>> {
  return {}
}
