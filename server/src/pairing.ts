// Phone pairing (6a): one-time codes a signed-in client asks for (`pairing.create`) and a phone
// redeems once at hello for its own named token. Only each code's hash is kept, in memory: a
// restart drops the pending codes. Spent and expired codes are remembered (hashes only) for a while,
// so a second try can be told "already used" or "expired" instead of "unknown".
import { createHash, randomBytes } from 'node:crypto'
import type { TrekServerConfig } from './config'
import { addToken, listTokens } from './tokens.ts'

/** How long a code stays redeemable. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000
/** At most this many codes wait at once; creating one past it drops the oldest. */
export const MAX_PENDING_PAIRING_CODES = 20
/** How long a spent or expired code is remembered, to say so. */
const REMEMBER_MS = 30 * 60_000
const REMEMBER_MAX = 200
/** The longest device name kept (the token's name is built from it). */
export const MAX_DEVICE_NAME = 60

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** 128 random bits as 26 base32 characters (RFC 4648 alphabet, no padding). */
export function newPairingCode(bytes: Buffer = randomBytes(16)): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** What a person types back: case, spaces and dashes don't matter. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, '')
}

const hashCode = (code: string): string => createHash('sha256').update(normalizePairingCode(code), 'utf8').digest('hex')

/** Why a code no longer redeems: its time ran out (or its asker's token was revoked), it was spent, or the desktop withdrew it. */
type GoneReason = 'expired' | 'used' | 'withdrawn'

export type RedeemOutcome = { ok: true; name: string; pairedBy: string } | { ok: false; reason: GoneReason | 'unknown' }

interface Pending {
  expiresAt: number
  /** The name the code was asked for with (a hint for the token's name); '' for none */
  name: string
  /** The token name of the connection that asked for the code; '' when unknown */
  pairedBy: string
}

export class PairingCodes {
  private readonly pending = new Map<string, Pending>()
  /** Spent or expired: hash → why, and until when it is remembered */
  private readonly spent = new Map<string, { reason: GoneReason; until: number }>()

  /**
   * `expiresInMs` is the code's lifetime, so a client whose clock is off can count down from its
   * own clock; `expiresAt` is the server's clock.
   */
  create(name: string, now: number, pairedBy = ''): { code: string; expiresAt: number; expiresInMs: number } {
    this.sweep(now)
    while (this.pending.size >= MAX_PENDING_PAIRING_CODES) {
      const oldest = this.pending.keys().next().value as string
      this.pending.delete(oldest)
    }
    const code = newPairingCode()
    const expiresAt = now + PAIRING_CODE_TTL_MS
    this.pending.set(hashCode(code), { expiresAt, name: name.slice(0, MAX_DEVICE_NAME), pairedBy })
    return { code, expiresAt, expiresInMs: PAIRING_CODE_TTL_MS }
  }

  /**
   * Drops a waiting code (the desktop's New code). Knowing the code is enough: whoever holds it
   * could redeem it, which is more. A cancelled code is then refused as withdrawn. True if a
   * waiting code was dropped.
   */
  cancel(code: string, now: number): boolean {
    this.sweep(now)
    const hash = hashCode(code)
    if (!this.pending.delete(hash)) return false
    this.remember(hash, 'withdrawn', now)
    return true
  }

  /**
   * Drops the waiting codes asked for by a token that is no longer listed (it was revoked):
   * `active` is the token names still listed. A code with no asker recorded stays. Refused as
   * expired from then on. Answers how many were dropped.
   */
  retainIssuedBy(active: ReadonlySet<string>, now: number): number {
    this.sweep(now)
    let dropped = 0
    for (const [hash, entry] of this.pending) {
      if (!entry.pairedBy || active.has(entry.pairedBy)) continue
      this.pending.delete(hash)
      this.remember(hash, 'expired', now)
      dropped++
    }
    return dropped
  }

  /** Spends the code: true at most once per code. */
  redeem(code: string, now: number): RedeemOutcome {
    this.sweep(now)
    const hash = hashCode(code)
    const entry = this.pending.get(hash)
    if (entry) {
      this.pending.delete(hash)
      this.remember(hash, 'used', now)
      return { ok: true, name: entry.name, pairedBy: entry.pairedBy }
    }
    const known = this.spent.get(hash)
    return { ok: false, reason: known ? known.reason : 'unknown' }
  }

  /** How many codes wait now (tests, health). */
  size(now: number): number {
    this.sweep(now)
    return this.pending.size
  }

  private sweep(now: number): void {
    for (const [hash, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        this.pending.delete(hash)
        this.remember(hash, 'expired', now)
      }
    }
    for (const [hash, s] of this.spent) if (s.until <= now) this.spent.delete(hash)
  }

  private remember(hash: string, reason: GoneReason, now: number): void {
    this.spent.set(hash, { reason, until: now + REMEMBER_MS })
    while (this.spent.size > REMEMBER_MAX) this.spent.delete(this.spent.keys().next().value as string)
  }
}

const TOKEN_NAME_MAX = 64

/**
 * The phone's token name: `phone-<device>` with what token names allow (letters, digits, ".",
 * "_", "-"), cut to fit, and `-2`, `-3`… added when the name is taken. ("phone: <device>" in the
 * spec; token names can't hold ": " or spaces.)
 */
export function phoneTokenName(deviceName: string, taken: ReadonlySet<string>): string {
  const cleaned = deviceName
    .slice(0, MAX_DEVICE_NAME)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  const base = `phone-${cleaned || 'device'}`.slice(0, TOKEN_NAME_MAX)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const name = `${base.slice(0, TOKEN_NAME_MAX - suffix.length)}${suffix}`
    if (!taken.has(name)) return name
  }
}

/** Failed redeems allowed per address in a window, before it is refused for the rest of it. */
export const PAIRING_FAILS_PER_ADDRESS = 5
export const PAIRING_WINDOW_MS = 60_000

/**
 * Failed redeems in a sliding window, per address only (pairing's own: nothing shared with the web
 * sign-in, and no total, so a burst from one address never locks out another). An attempt counts
 * as a failure the moment it is allowed; a good redeem clears its address. Behind a reverse proxy
 * every client has the proxy's address, so they all share one allowance.
 */
export class PairingLimiter {
  private readonly byAddress = new Map<string, number[]>()

  allow(address: string, now: number): boolean {
    const mine = (this.byAddress.get(address) ?? []).filter((t) => now - t < PAIRING_WINDOW_MS)
    if (mine.length >= PAIRING_FAILS_PER_ADDRESS) {
      this.byAddress.set(address, mine)
      return false
    }
    mine.push(now)
    this.byAddress.set(address, mine)
    if (this.byAddress.size > 10_000) {
      for (const [a, times] of this.byAddress) if (times.every((t) => now - t >= PAIRING_WINDOW_MS)) this.byAddress.delete(a)
    }
    return true
  }

  succeed(address: string): void {
    this.byAddress.delete(address)
  }
}

/** What the hello handler needs of the config store. */
export interface PairingStore {
  readonly config: TrekServerConfig
  update(mutate: (config: TrekServerConfig) => void): void
}

export type PhoneRedeem =
  | { ok: true; token: string; name: string; pairedBy: string }
  | { ok: false; reason: GoneReason | 'unknown' | 'limited' }
  /** The code was good (and is spent) but the config could not be written */
  | { ok: false; reason: 'unsaved'; error: unknown }

/**
 * A phone's hello with a pairing code: limited per address, the code spent, and the phone's token
 * minted. The token's name is chosen inside the config update, from the config as it is on disk
 * then, so a `token add` of the same name that landed meanwhile is numbered around, not replaced.
 * A failed write leaves the code spent (it can't be put back safely): the phone needs a new one.
 */
export function redeemForPhone(
  deps: { codes: PairingCodes; limiter: PairingLimiter; store: PairingStore },
  code: string,
  deviceName: string,
  address: string,
  now: number
): PhoneRedeem {
  if (!deps.limiter.allow(address, now)) return { ok: false, reason: 'limited' }
  const redeemed = deps.codes.redeem(code, now)
  if (!redeemed.ok) return redeemed
  deps.limiter.succeed(address)
  const device = deviceName.trim() || redeemed.name
  let token = ''
  let name = ''
  try {
    deps.store.update((c) => {
      name = phoneTokenName(device, new Set(listTokens(c).map((t) => t.name)))
      token = addToken(c, name, new Date(now), { pairedBy: redeemed.pairedBy })
    })
  } catch (error) {
    return { ok: false, reason: 'unsaved', error }
  }
  return { ok: true, token, name, pairedBy: redeemed.pairedBy }
}
