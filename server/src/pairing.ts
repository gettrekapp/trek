// Phone pairing (6a): one-time codes a signed-in client asks for (`pairing.create`) and a phone
// redeems once at hello for its own named token. Only each code's hash is kept, in memory: a
// restart drops the pending codes. Spent and expired codes are remembered (hashes only) for a while,
// so a second try can be told "already used" or "expired" instead of "unknown".
import { createHash, randomBytes } from 'node:crypto'

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

export type RedeemOutcome = { ok: true; name: string } | { ok: false; reason: 'expired' | 'used' | 'unknown' }

interface Pending {
  expiresAt: number
  /** The name the code was asked for with (a hint for the token's name); '' for none */
  name: string
}

export class PairingCodes {
  private readonly pending = new Map<string, Pending>()
  /** Spent or expired: hash → why, and until when it is remembered */
  private readonly spent = new Map<string, { reason: 'expired' | 'used'; until: number }>()

  create(name: string, now: number): { code: string; expiresAt: number } {
    this.sweep(now)
    while (this.pending.size >= MAX_PENDING_PAIRING_CODES) {
      const oldest = this.pending.keys().next().value as string
      this.pending.delete(oldest)
    }
    const code = newPairingCode()
    const expiresAt = now + PAIRING_CODE_TTL_MS
    this.pending.set(hashCode(code), { expiresAt, name: name.slice(0, MAX_DEVICE_NAME) })
    return { code, expiresAt }
  }

  /** Spends the code: true at most once per code. */
  redeem(code: string, now: number): RedeemOutcome {
    this.sweep(now)
    const hash = hashCode(code)
    const entry = this.pending.get(hash)
    if (entry) {
      this.pending.delete(hash)
      this.remember(hash, 'used', now)
      return { ok: true, name: entry.name }
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

  private remember(hash: string, reason: 'expired' | 'used', now: number): void {
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
