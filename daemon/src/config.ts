import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RemoteRepo } from '../../src/shared/protocol'

export interface DaemonConfig {
  /** sha256 hex of the bearer token — the token itself is never stored. */
  tokenHash?: string
  /** Repos clients may operate on. `id` is any stable slug. */
  repos: RemoteRepo[]
  /**
   * Extra directories where worktrees may be created/spawned. The parent
   * directory of each repo is always allowed (worktrees are created as
   * siblings of the repo checkout).
   */
  worktreeRoots?: string[]
  port?: number
  host?: string
}

export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'trek-daemon', 'config.json')
}

export function loadConfig(path: string): DaemonConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { repos: [] }
  }
  const config = JSON.parse(raw) as DaemonConfig
  if (!Array.isArray(config.repos)) config.repos = []
  return config
}

export function saveConfig(path: string, config: DaemonConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8')
}
