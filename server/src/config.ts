import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RemoteRepo } from '../../src/shared/protocolV2'
import { writeFileAtomic } from './atomicWrite.ts'
import type { TokenEntry } from './tokens'

export interface TrekServerConfig {
  /** Stable UUID of this server, generated on first start. */
  serverId?: string
  /** Display name shown in clients; defaults to the hostname. */
  name?: string
  /** v1's single token hash. Moved into `tokens` as "default" on start. */
  tokenHash?: string
  /** Named tokens; only sha256 hashes are stored. */
  tokens?: TokenEntry[]
  /** Repos clients may operate on. `id` is any stable slug. */
  repos: RemoteRepo[]
  /**
   * Extra directories where worktrees may be created/spawned. The parent
   * directory of each repo is always allowed (worktrees are created as
   * siblings of the repo checkout).
   */
  worktreeRoots?: string[]
  port?: number
  /**
   * Agent CLI settings: the default LLM and per-provider command, approval
   * mode and local backend. Same shape as the desktop's LlmSettings; read
   * through ConfigStore.llmSettings(). Project settings override it.
   */
  llm?: unknown
  host?: string
  /** Most session ptys running at once (default DEFAULT_MAX_SESSIONS, 64). */
  maxSessions?: number
  /** Where projects are stored (default: the platform data dir, see dataDir.ts). */
  dataDir?: string
}

export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'trek-server', 'config.json')
}

/** Where trek-daemon (before the rename) kept its config. */
export function legacyConfigPath(): string {
  return join(homedir(), '.config', 'trek-daemon', 'config.json')
}

/**
 * Copies the trek-daemon config to `target` when `target` does not exist yet
 * and `legacy` does. Returns true if it copied. The legacy file is kept.
 */
export function migrateLegacyConfig(target: string, legacy: string): boolean {
  if (existsSync(target) || !existsSync(legacy)) return false
  mkdirSync(dirname(target), { recursive: true })
  try {
    // COPYFILE_EXCL closes the exists/copy race: never overwrite a target.
    copyFileSync(legacy, target, constants.COPYFILE_EXCL)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  // The copy inherits the legacy file's mode; the file holds token hashes.
  chmodSync(target, 0o600)
  return true
}

/**
 * Write-then-rename, so a running server watching the file never reads a
 * half-written config. The file is 0600: it holds token hashes.
 */
export function saveConfig(path: string, config: TrekServerConfig): void {
  writeFileAtomic(path, JSON.stringify(config, null, 2) + '\n', 0o600)
}

/** Fills in `serverId` and `name` if missing. Returns true if it changed the config. */
export function ensureIdentity(config: TrekServerConfig, hostname: string): boolean {
  let changed = false
  if (!config.serverId) {
    config.serverId = randomUUID()
    changed = true
  }
  if (!config.name) {
    config.name = hostname
    changed = true
  }
  return changed
}
