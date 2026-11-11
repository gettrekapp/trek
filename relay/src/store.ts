// The relay's devices and grants, in <dataDir>/relay.json (0600, written then renamed). A device is
// a phone's push token (the relay needs it to send); its secret and every grant's secret are kept
// only as sha256 hashes, so the file alone can't be used to push or to manage a phone's grants.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../src/host/atomicWrite.ts'

export type Platform = 'ios' | 'android'

export interface Device {
  id: string
  platform: Platform
  pushToken: string
  secretHash: string
  createdAt: number
  /** APNs or FCM said the token is gone: its grants answer 410 */
  dead?: true
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

  constructor(dataDir: string, now: () => number = Date.now) {
    this.path = join(dataDir, STORE_FILE)
    this.now = now
    let text: string | undefined
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${this.path} cannot be read: ${(err as Error).message}`)
    }
    if (text !== undefined) {
      const file = JSON.parse(text) as StoreFile
      for (const d of file.devices ?? []) this.devices.set(d.id, d)
      for (const g of file.grants ?? []) if (this.devices.has(g.deviceId)) this.grants.set(g.id, g)
      this.reindex()
    }
  }

  private reindex(): void {
    this.deviceBySecret = new Map([...this.devices.values()].map((d) => [d.secretHash, d.id]))
    this.grantBySecret = new Map([...this.grants.values()].map((g) => [g.secretHash, g.id]))
  }

  private save(): void {
    const file: StoreFile = { version: 1, devices: [...this.devices.values()], grants: [...this.grants.values()] }
    writeFileAtomic(this.path, JSON.stringify(file, null, 2) + '\n', 0o600)
  }

  addDevice(platform: Platform, pushToken: string): { device: Device; secret: string } {
    const secret = newSecret()
    const device: Device = { id: randomUUID(), platform, pushToken, secretHash: hashSecret(secret), createdAt: this.now() }
    this.devices.set(device.id, device)
    this.deviceBySecret.set(device.secretHash, device.id)
    this.save()
    return { device, secret }
  }

  /** The device the secret belongs to, if its id matches */
  deviceFor(secret: string, id?: string): Device | undefined {
    const deviceId = this.deviceBySecret.get(hashSecret(secret))
    if (!deviceId || (id !== undefined && id !== deviceId)) return undefined
    return this.devices.get(deviceId)
  }

  /** A new token brings a dead device back */
  setPushToken(id: string, pushToken: string): void {
    const d = this.devices.get(id)
    if (!d) return
    d.pushToken = pushToken
    delete d.dead
    this.save()
  }

  removeDevice(id: string): void {
    if (!this.devices.delete(id)) return
    for (const [gid, g] of this.grants) if (g.deviceId === id) this.grants.delete(gid)
    this.reindex()
    this.save()
  }

  markDead(id: string): void {
    const d = this.devices.get(id)
    if (!d || d.dead) return
    d.dead = true
    this.save()
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
    this.save()
    return { grant, secret }
  }

  removeGrant(deviceId: string, grantId: string): boolean {
    const g = this.grants.get(grantId)
    if (!g || g.deviceId !== deviceId) return false
    this.grants.delete(grantId)
    this.grantBySecret.delete(g.secretHash)
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

  /** Recorded in memory only: written with the next change, so a busy relay doesn't rewrite the file per push */
  touchGrant(grantId: string): void {
    const g = this.grants.get(grantId)
    if (g) g.lastPushAt = this.now()
  }
}
