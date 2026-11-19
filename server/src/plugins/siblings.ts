// The other Local profiles' data dirs on this machine (plugins E2): `<parent>/local` and
// `<parent>/local-<name>` beside a Local server's own (`<platform data dir>/local…`), not its own.
// Each Local profile took its own snapshot of the app's files (Decision 16), so a built-in plugin
// reads theirs, never writes them (host.legacySiblingDataFiles). Before E2 core's machine.ts did
// this for its environments registry.
import { readdirSync, type Dirent } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { LOCAL_PROFILE_NAME_RE } from '../../../src/shared/localServer.ts'

export function localSiblingDataDirs(dataDir: string): string[] {
  const parent = dirname(dataDir)
  const own = basename(dataDir)
  let entries: Dirent[]
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== own && (e.name === 'local' || (e.name.startsWith('local-') && LOCAL_PROFILE_NAME_RE.test(e.name.slice(6)))))
    .map((e) => join(parent, e.name))
}
