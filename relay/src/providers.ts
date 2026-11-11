// The push services the config names: APNs for iOS, FCM for Android. A platform with no
// credentials gets no provider, and the relay refuses to register its devices.
import { readFileSync } from 'node:fs'
import type { Provider } from './api.ts'
import { APNS_PRODUCTION, APNS_SANDBOX, ApnsProvider } from './apns.ts'
import type { RelayConfig } from './config.ts'
import { FcmProvider, parseServiceAccount } from './fcm.ts'
import { ApnsToken, loadPrivateKey } from './jwt.ts'
import type { Platform } from './store.ts'

export function createProviders(config: RelayConfig, log: (line: string) => void = (line) => console.log(line)): Partial<Record<Platform, Provider>> {
  const providers: Partial<Record<Platform, Provider>> = {}
  if (config.apns) {
    const a = config.apns
    const key = loadPrivateKey(readFileSync(a.keyPath, 'utf8'), 'The APNs key')
    providers.ios = new ApnsProvider({
      origin: config.apnsHost ?? (a.production ? APNS_PRODUCTION : APNS_SANDBOX),
      bundleId: a.bundleId,
      token: new ApnsToken(key, a.keyId, a.teamId),
      log
    })
  }
  if (config.fcm) {
    const path = config.fcm.serviceAccountPath
    providers.android = new FcmProvider({
      account: parseServiceAccount(readFileSync(path, 'utf8'), path),
      fcmOrigin: config.fcmHost,
      oauthOrigin: config.oauthHost,
      log
    })
  }
  return providers
}
