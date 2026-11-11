// The two JWTs the relay signs with node:crypto: APNs' provider token (ES256, the .p8 key) and
// Google's service-account assertion (RS256) that it trades for an FCM access token.
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'

const b64url = (v: string | Buffer): string => Buffer.from(v).toString('base64url')

export function signJwt(alg: 'ES256' | 'RS256', header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject): string {
  const input = `${b64url(JSON.stringify({ alg, typ: 'JWT', ...header }))}.${b64url(JSON.stringify(claims))}`
  const signature = alg === 'ES256' ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }) : sign('sha256', Buffer.from(input), key)
  return `${input}.${b64url(signature)}`
}

export function loadPrivateKey(pem: string, what: string): KeyObject {
  try {
    return createPrivateKey(pem)
  } catch (err) {
    throw new Error(`${what} is not a private key: ${(err as Error).message}`)
  }
}

/** APNs provider tokens last an hour; Apple refuses one refreshed more often than every 20 minutes. */
export const APNS_TOKEN_TTL_MS = 50 * 60_000

/** An APNs provider token for `teamId`, re-signed once it is APNS_TOKEN_TTL_MS old. */
export class ApnsToken {
  private cached?: { token: string; at: number }
  private readonly key: KeyObject
  private readonly keyId: string
  private readonly teamId: string
  private readonly now: () => number

  constructor(key: KeyObject, keyId: string, teamId: string, now: () => number = Date.now) {
    this.key = key
    this.keyId = keyId
    this.teamId = teamId
    this.now = now
  }

  get(): string {
    const t = this.now()
    if (!this.cached || t - this.cached.at >= APNS_TOKEN_TTL_MS) {
      this.cached = { token: signJwt('ES256', { kid: this.keyId }, { iss: this.teamId, iat: Math.floor(t / 1000) }, this.key), at: t }
    }
    return this.cached.token
  }

  /** Apple said ExpiredProviderToken: sign a new one next time */
  reset(): void {
    this.cached = undefined
  }
}
