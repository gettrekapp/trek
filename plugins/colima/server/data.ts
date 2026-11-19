// The Colima registry's file (plugins E2): `<dataDir>/plugins/env/environments.json` (0600: a
// branch's variables may hold secrets). Before E2 the server kept it at `<dataDir>/environments.json`:
// on a server with none here yet it is copied across, the old file kept, as the voice plugin's
// config is, so a server rolled back still has its VMs. Else, on a Local server started with
// --import-env-from, the app's registry is taken over (seed.ts).
//
// Nothing already there is replaced, as envSeed.ts's take-over before E2: anything at the plugin's
// path (a file, even one that does not parse, or a dangling symlink) is the plugin's registry, and
// anything at the old path is the server's own (it was 5a's take-over marker), so the app's is
// then never taken. Both writes are write-once (seed.ts's writeFileOnce: a temp file hard-linked
// into place), so a plugin copy that appeared meanwhile is never overwritten by an older one.
import { readFileSync } from 'node:fs'
import type { ServerPluginHost } from '../../../src/shared/plugins/server.ts'
import { isRecord, present, seedRegistryFromApp, writeFileOnce } from './seed.ts'

export const REGISTRY_FILE = 'environments.json'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The old registry's text, to copy: it must parse as a JSON object, so a torn or corrupt file is never made the plugin's for good. */
function readLegacy(file: string): string {
  const text = readFileSync(file, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`it does not parse (${messageOf(err)})`)
  }
  if (!isRecord(parsed)) throw new Error('it is not a JSON object')
  return text
}

/**
 * The registry's file, ready to use. Throws when the plugin's data directory can't be made (the
 * plugin then isn't loaded, and says why). An old registry that can't be read or doesn't parse is
 * logged and read in place (the service then says it is unreadable, naming that file), and copied
 * at a later start once it is fixed; a take-over that fails is logged and retried at the next start.
 */
export function prepareRegistry(host: Pick<ServerPluginHost, 'dataFile' | 'legacyDataFile' | 'legacyImportFile' | 'log'>): string {
  const file = host.dataFile(REGISTRY_FILE)
  if (present(file)) return file
  const legacy = host.legacyDataFile(REGISTRY_FILE)
  if (present(legacy)) {
    try {
      // false: a plugin registry appeared meanwhile, and it wins.
      if (writeFileOnce(file, readLegacy(legacy))) host.log.info(`copied the environments registry from ${legacy}`)
    } catch (err) {
      host.log.warn(`could not copy ${legacy} to ${file} (${messageOf(err)}); reading it where it is`)
      return legacy
    }
    return file
  }
  const app = host.legacyImportFile(REGISTRY_FILE)
  if (app === undefined) return file
  try {
    const seed = seedRegistryFromApp(app, file)
    if (seed.seeded) host.log.info(`took over ${seed.environments} environment(s) from ${app}`)
    if (seed.skipped.length > 0) host.log.warn(`left out ${seed.skipped.join('; ')}`)
  } catch (err) {
    // The VMs are still there; the next start tries again (nothing was written).
    host.log.warn(`could not take over ${app}: ${messageOf(err)}`)
  }
  return file
}
