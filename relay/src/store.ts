// The relay's devices and grants, in <dataDir>/relay.json (0600, written then renamed; the
// directory 0700). A device is a phone's push token (the relay needs it to send); its secret and
// every grant's secret are kept only as sha256 hashes, so the file alone can't be used to push or
// to manage a phone's grants. A change that issues or revokes a secret is written before the
// relay answers, and so is a token's first delivery (it decides whether APNs' BadDeviceToken
// means gone); bookkeeping (a grant's last push) is written within a second, or on close. Devices
// dead for 30 days, and devices with no grant for 7 days (registered, never granted, or every
// grant revoked), are pruned, on load and daily.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../src/host/atomicWrite.ts'

export type Platform = 'ios' | 'android'

export interface Device {
  id: string
  platform: Platform
  pushToken: string
  secretHash: string
  createdAt: number
  /** APNs or FCM said the token is gone: its grants answer 410 until the phone sends a token */
  dead?: true
  /** When it was marked dead (pruned DEAD_PRUNE_MS later) */
  deadAt?: number
  /** A push to this token was delivered at least once (APNs' BadDeviceToken counts as gone only then) */
  delivered?: true
  /** The phone paused all pushes: the relay accepts and drops them */
  paused?: true
  /** When its last grant was revoked (with none left; pruned UNGRANTED_PRUNE_MS later) */
  ungrantedAt?: number
}

export interface Grant {
  id: string
  deviceId: string
  label: string
  secretHash: string
  createdAt: number
  lastPushAt?: number
}

interface StoreFile {
  version: 1
  devices: Device[]
  grants: Grant[]
}

export const STORE_FILE = 'relay.json'
/** A device holds at most this many grants (one per paired server) */
export const MAX_GRANTS_PER_DEVICE = 50
export const MAX_LABEL = 80
export const MAX_PUSH_TOKEN = 4096
/** The relay holds at most this many devices by default (`maxDevices` in the config) */
export const DEFAULT_MAX_DEVICES = 10_000
/** A device dead this long is removed, with its grants */
export const DEAD_PRUNE_MS = 30 * 24 * 3_600_000
/** A device with no grant this long (since it registered, or its last grant went) is removed */
export const UNGRANTED_PRUNE_MS = 7 * 24 * 3_600_000
/** Bookkeeping is written at most this long after it changes */
export const SAVE_DEBOUNCE_MS = 1_000

export interface RelayStoreOptions {
  now?: () => number
  maxDevices?: number
}

export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')
/** 256 random bits, base64url */
export const newSecret = (): string => randomBytes(32).toString('base64url')

export class RelayStore {
  private readonly path: string
  private devices = new Map<string, Device>()
  private grants = new Map<string, Grant>()
  private deviceBySecret = new Map<string, string>()
  private grantBySecret = new Map<string, string>()
  private readonly now: () => number
  private readonly maxDevices: number
  private saveTimer?: NodeJS.Timeout

  constructor(dataDir: string, options: RelayStoreOptions | (() => number) = {}) {
    const opts = typeof options === 'function' ? { now: options } : options
    this.path = join(dataDir, STORE_FILE)
    this.now = opts.now ?? Date.now
    this.maxDevices = opts.maxDevices ?? DEFAULT_MAX_DEVICES
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    let text: string | undefined
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${this.path} cannot be read: ${(err as Error).message}`)
    }
    if (text !== undefined) {
      const file = JSON.parse(text) as StoreFile
      for (const d of file.devices ?? []) {
        // A device marked dead before deadAt was kept counts from now.
        if (d.dead && d.deadAt === undefined) d.deadAt = this.now()
        this.devices.set(d.id, d)
      }
      for (const g of file.grants ?? []) if (this.devices.has(g.deviceId)) this.grants.set(g.id, g)
      this.reindex()
      this.prune()
    }
  }

  private reindex(): void {
    this.deviceBySecret = new Map([...this.devices.values()].map((d) => [d.secretHash, d.id]))
    this.grantBySecret = new Map([...this.grants.values()].map((g) => [g.secretHash, g.id]))
  }

  private save(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const file: StoreFile = { version: 1, devices: [...this.devices.values()], grants: [...this.grants.values()] }
    writeFileAtomic(this.path, JSON.stringify(file, null, 2) + '\n', 0o600)
  }

  /** Bookkeeping: written within SAVE_DEBOUNCE_MS (or by the next change, or flush) */
  private saveSoon(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      try {
        this.save()
      } catch (err) {
        console.warn(`[relay] could not write ${this.path}: ${(err as Error).message}`)
      }
    }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  /** Writes what is waiting (shutdown) */
  flush(): void {
    if (this.saveTimer) this.save()
  }

  get deviceCount(): number {
    return this.devices.size
  }

  /**
   * A new device for the token. A device already holding this (platform, token) — the app
   * reinstalled, its old secret lost — is replaced: removed with its grants. 'full' when the relay
   * holds maxDevices already.
   */
  addDevice(platform: Platform, pushToken: string): { device: Device; secret: string; replaced: boolean } | 'full' {
    const existing = [...this.devices.values()].filter((d) => d.platform === platform && d.pushToken === pushToken)
    if (!existing.length && this.devices.size >= this.maxDevices) return 'full'
    for (const d of existing) this.dropDevice(d.id)
    if (existing.length) this.reindex()
    const secret = newSecret()
    const device: Device = { id: randomUUID(), platform, pushToken, secretHash: hashSecret(secret), createdAt: this.now() }
    this.devices.set(device.id, device)
    this.deviceBySecret.set(device.secretHash, device.id)
    this.save()
    return { device, secret, replaced: existing.length > 0 }
  }

  /** The device the secret belongs to, if its id matches */
  deviceFor(secret: string, id?: string): Device | undefined {
    const deviceId = this.deviceBySecret.get(hashSecret(secret))
    if (!deviceId || (id !== undefined && id !== deviceId)) return undefined
    return this.devices.get(deviceId)
  }

  /** The phone sent its token (new or the same): a dead device comes back */
  setPushToken(id: string, pushToken: string): void {
    const d = this.devices.get(id)
    if (!d) return
    if (d.pushToken !== pushToken) delete d.delivered
    d.pushToken = pushToken
    delete d.dead
    delete d.deadAt
    this.save()
  }

  setPaused(id: string, paused: boolean): void {
    const d = this.devices.get(id)
    if (!d || (d.paused === true) === paused) return
    if (paused) d.paused = true
    else delete d.paused
    this.save()
  }

  private dropDevice(id: string): boolean {
    if (!this.devices.delete(id)) return false
    for (const [gid, g] of this.grants) if (g.deviceId === id) this.grants.delete(gid)
    return true
  }

  removeDevice(id: string): void {
    if (!this.dropDevice(id)) return
    this.reindex()
    this.save()
  }

  /** The provider said `tokenSent` is gone. Ignored if the phone sent a new token meanwhile. */
  markDead(id: string, tokenSent: string): void {
    const d = this.devices.get(id)
    if (!d || d.dead || d.pushToken !== tokenSent) return
    d.dead = true
    d.deadAt = this.now()
    this.save()
  }

  /** A push to `tokenSent` was delivered */
  markDelivered(id: string, tokenSent: string): void {
    const d = this.devices.get(id)
    if (!d || d.delivered || d.pushToken !== tokenSent) return
    d.delivered = true
    // Written now: lost on a crash, a later BadDeviceToken would leave a gone token "alive".
    this.save()
  }

  /**
   * Removes devices dead for DEAD_PRUNE_MS, with their grants, and devices with no grant for
   * UNGRANTED_PRUNE_MS (since they registered, or since their last grant was revoked). Returns how many.
   */
  prune(): number {
    const now = this.now()
    const deadBefore = now - DEAD_PRUNE_MS
    const ungrantedBefore = now - UNGRANTED_PRUNE_MS
    const granted = new Set([...this.grants.values()].map((g) => g.deviceId))
    let pruned = 0
    for (const d of [...this.devices.values()]) {
      const dead = d.dead && (d.deadAt ?? 0) <= deadBefore
      const ungranted = !granted.has(d.id) && Math.max(d.createdAt, d.ungrantedAt ?? 0) <= ungrantedBefore
      if ((dead || ungranted) && this.dropDevice(d.id)) pruned += 1
    }
    if (pruned) {
      this.reindex()
      this.save()
    }
    return pruned
  }

  grantsOf(deviceId: string): Grant[] {
    return [...this.grants.values()].filter((g) => g.deviceId === deviceId)
  }

  addGrant(deviceId: string, label: string): { grant: Grant; secret: string } | 'full' {
    if (this.grantsOf(deviceId).length >= MAX_GRANTS_PER_DEVICE) return 'full'
    const secret = newSecret()
    const grant: Grant = { id: randomUUID(), deviceId, label, secretHash: hashSecret(secret), createdAt: this.now() }
    this.grants.set(grant.id, grant)
    this.grantBySecret.set(grant.secretHash, grant.id)
    const d = this.devices.get(deviceId)
    if (d) delete d.ungrantedAt
    this.save()
    return { grant, secret }
  }

  removeGrant(deviceId: string, grantId: string): boolean {
    const g = this.grants.get(grantId)
    if (!g || g.deviceId !== deviceId) return false
    this.grants.delete(grantId)
    this.grantBySecret.delete(g.secretHash)
    const d = this.devices.get(deviceId)
    if (d && !this.grantsOf(deviceId).length) d.ungrantedAt = this.now()
    this.save()
    return true
  }

  /** The grant and its device for a server's bearer secret */
  grantFor(secret: string): { grant: Grant; device: Device } | undefined {
    const grantId = this.grantBySecret.get(hashSecret(secret))
    const grant = grantId ? this.grants.get(grantId) : undefined
    const device = grant ? this.devices.get(grant.deviceId) : undefined
    return grant && device ? { grant, device } : undefined
  }

  /** Bookkeeping, written within a second */
  touchGrant(grantId: string): void {
    const g = this.grants.get(grantId)
    if (!g) return
    g.lastPushAt = this.now()
    this.saveSoon()
  }
}
