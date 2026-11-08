// userData/migrated.json: which .trekproj files were imported, into which server projects,
// and whether the first-launch prompt has run (importRules.ts has the format).
import { app } from 'electron'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from './secrets'
import { parseMigrated, serializeMigrated, type Migrated } from './importRules'

function migratedPath(): string {
  return join(app.getPath('userData'), 'migrated.json')
}

/** A .trekproj's key: its realpath, so a symlink or another spelling finds the same import. */
export function fileKey(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Whether `path` is the file `key` names (for the recents and open-windows rewrites). */
export function isFileKey(key: string): (path: string) => boolean {
  return (path) => fileKey(path) === key
}

export async function readMigrated(): Promise<Migrated> {
  try {
    return parseMigrated(JSON.parse(await readFile(migratedPath(), 'utf8')))
  } catch {
    return parseMigrated(null) // first run, or unreadable: nothing imported yet
  }
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
