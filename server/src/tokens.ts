// Named access tokens, one per device. Only sha256 hashes are stored; the
// plaintext is shown once when created.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DaemonConfig } from './config'

export interface TokenEntry {
  name: string
  /** sha256 hex of the token */
  hash: string
  /** ISO timestamp; empty for a token migrated from v1's single tokenHash */
  createdAt: string
}

export const DEFAULT_TOKEN_NAME = 'default'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Every token the config accepts, counting an unmigrated v1 tokenHash as "default". */
export function listTokens(config: DaemonConfig): TokenEntry[] {
  const tokens = [...(config.tokens ?? [])]
  if (config.tokenHash && !tokens.some((t) => t.name === DEFAULT_TOKEN_NAME)) {
    tokens.push({ name: DEFAULT_TOKEN_NAME, hash: config.tokenHash, createdAt: '' })
  }
  return tokens
}

export function activeTokenHashes(config: DaemonConfig): Set<string> {
  return new Set(listTokens(config).map((t) => t.hash))
}

/** Moves v1's `tokenHash` into `tokens` as "default". Returns true if it changed the config. */
export function migrateLegacyToken(config: DaemonConfig): boolean {
  if (!config.tokenHash) return false
  config.tokens = listTokens(config)
  delete config.tokenHash
  return true
}

/** Creates the token `name`, replacing any token of that name. Returns the plaintext, shown once. */
export function addToken(config: DaemonConfig, name: string, now: Date = new Date()): string {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid token name "${name}" (letters, digits, ".", "_", "-"; up to 64)`)
  }
  migrateLegacyToken(config)
  const token = randomBytes(32).toString('base64url')
  const tokens = (config.tokens ?? []).filter((t) => t.name !== name)
  tokens.push({ name, hash: hashToken(token), createdAt: now.toISOString() })
  config.tokens = tokens
  return token
}

/** Returns true if a token of that name existed. */
export function revokeToken(config: DaemonConfig, name: string): boolean {
  migrateLegacyToken(config)
  const tokens = config.tokens ?? []
  const kept = tokens.filter((t) => t.name !== name)
  config.tokens = kept
  return kept.length !== tokens.length
}

/** The entry `token` matches, or undefined. Compares every entry in constant time. */
export function matchToken(config: DaemonConfig, token: string): TokenEntry | undefined {
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
  return [
    `${'NAME'.padEnd(width)}  CREATED`,
    ...tokens.map((t) => `${t.name.padEnd(width)}  ${t.createdAt || 'unknown'}`)
  ].join('\n')
}
