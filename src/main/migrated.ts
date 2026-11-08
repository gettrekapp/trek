// userData/migrated.json: which .trekproj files were imported, into which server projects,
// and whether the first-launch prompt has run (importRules.ts has the format).
import { app } from 'electron'
import { join } from 'node:path'
import { readJsonStore } from './jsonFile'
import { writeFileAtomic } from './secrets'
import { parseMigrated, serializeMigrated, type Migrated } from './importRules'

export { fileKey, isFileKey } from './fileKey'

function migratedPath(): string {
  return join(app.getPath('userData'), 'migrated.json')
}

const isObject = (raw: unknown): boolean => !!raw && typeof raw === 'object' && !Array.isArray(raw)

/** Nothing imported yet on a first run; a corrupt file is moved aside first (readJsonStore), never just overwritten. */
export async function readMigrated(): Promise<Migrated> {
  return parseMigrated((await readJsonStore(migratedPath(), isObject)) ?? null)
}

/** Every change is a read-modify-write; chained so two imports never lose each other's entry. */
let chain: Promise<unknown> = Promise.resolve()

export function updateMigrated(change: (m: Migrated) => Migrated): Promise<Migrated> {
  const run = chain.then(async () => {
    const next = change(await readMigrated())
    await writeFileAtomic(migratedPath(), JSON.stringify(serializeMigrated(next), null, 2))
    return next
  })
  chain = run.catch(() => undefined)
  return run
}
