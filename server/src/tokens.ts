// Named access tokens, one per device. Only sha256 hashes are stored.

export interface TokenEntry {
  name: string
  /** sha256 hex of the token */
  hash: string
  /** ISO timestamp; empty for a token migrated from v1's single tokenHash */
  createdAt: string
}
