// The phones' push grants (6b), one per paired token, in the server's secrets file (0600) under
// `push:<token name>`. A phone sets its grant with `push.setGrant`: the relay's URL, the grant's
// secret, which kinds it wants and whether it is paused. The secret is write-only over the
// protocol. A grant the relay refused (401/404/410) keeps its settings and why, without its secret,
// so `push.status` can tell the phone to grant again.
import { ALL_PUSH_KINDS_ON, type PushKinds } from '../../../src/shared/push.ts'
import { codedError } from '../errors.ts'
import type { SecretFile } from '../secrets.ts'

export interface StoredGrant {
  relayUrl: string
  /** '' once the relay refused it */
  grantSecret: string
  kinds: PushKinds
  paused: boolean
  lastError?: string
  lastPushAt?: number
}

export interface PushStatus {
  relayUrl: string
  kinds: PushKinds
  paused: boolean
  /** false once the relay refused the grant: the phone asks it for a new one */
  active: boolean
  lastError?: string
  lastPushAt?: number
}

const PREFIX = 'push:'
export const MAX_RELAY_URL = 512
export const MAX_GRANT_SECRET = 128

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** A relay is reached over https; http only to loopback (a relay on the same machine, or a test). */
export function checkRelayUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_RELAY_URL) throw codedError('BAD_REQUEST', 'relayUrl must be a URL')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw codedError('BAD_REQUEST', 'relayUrl must be a URL')
  }
  if (url.username || url.password || url.search || url.hash) throw codedError('BAD_REQUEST', 'relayUrl must be a plain origin (and path)')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw codedError('BAD_REQUEST', 'relayUrl must be https:// (http:// only on this machine)')
  }
  return url.href.replace(/\/+$/, '')
}

function checkKinds(value: unknown): PushKinds {
  if (value === undefined) return { ...ALL_PUSH_KINDS_ON }
  if (!value || typeof value !== 'object') throw codedError('BAD_REQUEST', 'kinds must be an object')
  const k = value as Record<string, unknown>
  const flag = (name: keyof PushKinds): boolean => {
    if (k[name] === undefined) return true
    if (typeof k[name] !== 'boolean') throw codedError('BAD_REQUEST', `kinds.${name} must be true or false`)
    return k[name] as boolean
  }
  return { decisions: flag('decisions'), sessions: flag('sessions'), prWatch: flag('prWatch') }
}

/** `push.setGrant`'s params, checked */
export function checkSetGrant(p: Record<string, unknown>): StoredGrant {
  if (typeof p.grantSecret !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(p.grantSecret)) throw codedError('BAD_REQUEST', 'grantSecret must be the relay grant secret')
  if (p.paused !== undefined && typeof p.paused !== 'boolean') throw codedError('BAD_REQUEST', 'paused must be true or false')
  return { relayUrl: checkRelayUrl(p.relayUrl), grantSecret: p.grantSecret, kinds: checkKinds(p.kinds), paused: p.paused === true }
}

export class PushGrants {
  private readonly file: SecretFile
  /** Names with a stored grant, kept so a push doesn't re-read the file per token */
  private cache?: Map<string, StoredGrant>
  private readonly names: () => Iterable<string>

  /** `names` lists every token the config has (the only ones whose grants are looked at) */
  constructor(file: SecretFile, names: () => Iterable<string>) {
    this.file = file
    this.names = names
  }

  private load(): Map<string, StoredGrant> {
    if (this.cache) return this.cache
    const all = new Map<string, StoredGrant>()
    for (const name of this.names()) {
      const raw = this.file.get(PREFIX + name)
      if (!raw) continue
      try {
        all.set(name, JSON.parse(raw) as StoredGrant)
      } catch {
        // a hand-edited value: ignored
      }
    }
    this.cache = all
    return all
  }

  private write(name: string, grant: StoredGrant | null): void {
    this.file.set(PREFIX + name, grant ? JSON.stringify(grant) : null)
    const all = this.load()
    if (grant) all.set(name, grant)
    else all.delete(name)
  }

  set(name: string, grant: StoredGrant): void {
    this.write(name, grant)
  }

  clear(name: string): void {
    this.write(name, null)
  }

  get(name: string): StoredGrant | undefined {
    return this.load().get(name)
  }

  status(name: string): PushStatus | null {
    const g = this.get(name)
    if (!g) return null
    return {
      relayUrl: g.relayUrl,
      kinds: { ...g.kinds },
      paused: g.paused,
      active: g.grantSecret !== '',
      ...(g.lastError ? { lastError: g.lastError } : {}),
      ...(g.lastPushAt ? { lastPushAt: g.lastPushAt } : {})
    }
  }

  /** The grants that can push: secret still good */
  active(): [string, StoredGrant][] {
    return [...this.load()].filter(([, g]) => g.grantSecret !== '')
  }

  /** The relay refused the grant: forget its secret, keep its settings and why */
  refused(name: string, why: string): void {
    const g = this.get(name)
    if (g) this.write(name, { ...g, grantSecret: '', lastError: why })
  }

  pushed(name: string, at: number, error?: string): void {
    const g = this.get(name)
    if (!g) return
    // Only `lastPushAt` changes on success; it is kept in memory, not rewritten to disk each push.
    if (error === undefined) {
      g.lastPushAt = at
      if (g.lastError) {
        delete g.lastError
        this.write(name, g)
      }
    } else if (g.lastError !== error) this.write(name, { ...g, lastError: error })
  }

  /** A revoked token's grant goes with it. Returns how many were dropped. */
  retain(active: Set<string>): number {
    this.cache = undefined
    const before = this.allStoredNames()
    let dropped = 0
    for (const name of before) {
      if (active.has(name)) continue
      this.file.set(PREFIX + name, null)
      dropped += 1
    }
    this.cache = undefined
    return dropped
  }

  /** Every name with a stored grant, the file's own (a revoked token's included) */
  private allStoredNames(): string[] {
    return this.file.keys().filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length))
  }
}
