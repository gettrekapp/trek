// Named access tokens, one per device. Only sha256 hashes are stored; the
// plaintext is shown once when created.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { TrekServerConfig } from './config'

export interface TokenEntry {
  name: string
  /** sha256 hex of the token */
  hash: string
  /** ISO timestamp; empty for a token migrated from v1's single tokenHash */
  createdAt: string
  /** A phone's token (6a): the name of the token whose connection asked for the pairing code. A record only: revoking that token leaves this one. */
  pairedBy?: string
}

export const DEFAULT_TOKEN_NAME = 'default'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Every token the config accepts, counting an unmigrated v1 tokenHash as "default". */
export function listTokens(config: TrekServerConfig): TokenEntry[] {
  // Hand-edited entries that are malformed are dropped (fail closed).
  const tokens = (config.tokens ?? []).filter(
    (t) => t && typeof t.name === 'string' && t.name !== '' && typeof t.hash === 'string' && t.hash !== ''
  )
  if (config.tokenHash && !tokens.some((t) => t.name === DEFAULT_TOKEN_NAME)) {
    tokens.push({ name: DEFAULT_TOKEN_NAME, hash: config.tokenHash, createdAt: '' })
  }
  return tokens
}

export function activeTokenHashes(config: TrekServerConfig): Set<string> {
  return new Set(listTokens(config).map((t) => t.hash))
}

/** Moves v1's `tokenHash` into `tokens` as "default". Returns true if it changed the config. */
export function migrateLegacyToken(config: TrekServerConfig): boolean {
  if (!config.tokenHash) return false
  config.tokens = listTokens(config)
  delete config.tokenHash
  return true
}

/** Creates the token `name`, replacing any token of that name. Returns the plaintext, shown once. */
export function addToken(config: TrekServerConfig, name: string, now: Date = new Date(), extra: { pairedBy?: string } = {}): string {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid token name "${name}" (letters, digits, ".", "_", "-"; up to 64)`)
  }
  migrateLegacyToken(config)
  const token = randomBytes(32).toString('base64url')
  const tokens = (config.tokens ?? []).filter((t) => t.name !== name)
  tokens.push({ name, hash: hashToken(token), createdAt: now.toISOString(), ...(extra.pairedBy ? { pairedBy: extra.pairedBy } : {}) })
  config.tokens = tokens
  return token
}

/** Returns true if a token of that name existed. Also migrates a v1 tokenHash into `tokens`. */
export function revokeToken(config: TrekServerConfig, name: string): boolean {
  migrateLegacyToken(config)
  const tokens = config.tokens ?? []
  const kept = tokens.filter((t) => t.name !== name)
  config.tokens = kept
  return kept.length !== tokens.length
}

/** The entry `token` matches, or undefined. Compares every entry in constant time. */
export function matchToken(config: TrekServerConfig, token: string): TokenEntry | undefined {
  const digest = Buffer.from(hashToken(token), 'hex')
  let match: TokenEntry | undefined
  for (const entry of listTokens(config)) {
    const stored = Buffer.from(entry.hash, 'hex')
    if (stored.length === digest.length && timingSafeEqual(stored, digest)) match ??= entry
  }
  return match
}

export function formatTokenList(tokens: TokenEntry[]): string {
  if (tokens.length === 0) return 'No tokens. Run `trek-server token add <name>`.'
  const width = Math.max(4, ...tokens.map((t) => t.name.length))
  const created = Math.max(7, ...tokens.map((t) => (t.createdAt || 'unknown').length))
  // A hand-edited pairedBy that isn't a string is left out.
  const pairedBy = (t: TokenEntry): string => (typeof t.pairedBy === 'string' ? t.pairedBy : '')
  return [
    `${'NAME'.padEnd(width)}  ${'CREATED'.padEnd(created)}  PAIRED BY`,
    ...tokens.map((t) => `${t.name.padEnd(width)}  ${(t.createdAt || 'unknown').padEnd(created)}  ${pairedBy(t)}`.trimEnd())
  ].join('\n')
}
