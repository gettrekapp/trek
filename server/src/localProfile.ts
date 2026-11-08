// `trek-server start --local`'s own profile: its config, local.json and lock
// under ~/.config/trek-server/local, and its projects under <dataDir>/local, so
// it never shares files with a hand-run `trek-server start`.
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  LOCAL_CONFIG_FILE,
  LOCAL_INFO_FILE,
  LOCAL_LOCK_FILE,
  LOCAL_PROFILE_DIR,
  parseLocalInfo,
  type LocalInfo
} from '../../src/shared/localServer.ts'
import { writeFileAtomic } from './atomicWrite.ts'

export interface LocalProfile {
  /** ~/.config/trek-server/local */
  dir: string
  configPath: string
  infoPath: string
  lockPath: string
  /** <dataDir>/local: the local server's projects and MCP files */
  dataDir: string
}

/** `dataDir` is the platform data dir (defaultDataDir()); the profile uses its `local` subdirectory. */
export function localProfile(home: string, dataDir: string): LocalProfile {
  const dir = join(home, ...LOCAL_PROFILE_DIR)
  return {
    dir,
    configPath: join(dir, LOCAL_CONFIG_FILE),
    infoPath: join(dir, LOCAL_INFO_FILE),
    lockPath: join(dir, LOCAL_LOCK_FILE),
    dataDir: join(dataDir, 'local')
  }
}

/** Write-then-rename, 0600: the file holds the plaintext token. */
export function writeLocalInfo(path: string, info: LocalInfo): void {
  writeFileAtomic(path, JSON.stringify(info, null, 2) + '\n', 0o600)
}

/** The file's LocalInfo, or undefined if it is missing, not JSON or malformed. */
export function readLocalInfo(path: string): LocalInfo | undefined {
  try {
    return parseLocalInfo(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

/** Removes local.json if it is `pid`'s. Returns true if it removed it. */
export function removeLocalInfo(path: string, pid: number): boolean {
  if (readLocalInfo(path)?.pid !== pid) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}
