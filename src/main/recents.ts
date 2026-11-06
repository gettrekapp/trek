import { app } from 'electron'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './secrets'
import { addRecentEntry, keepRecents, parseRecents, removeRecentEntry, serializeRecents, type RecentEntry } from './recentsRules'

function recentsFile(): string {
  return join(app.getPath('userData'), 'recent-projects.json')
}

async function readRecents(): Promise<RecentEntry[]> {
  const paths = [
    recentsFile(),
    // Pre-rename userData dir (app was "trek-developer" before "Trek Dev")
    join(app.getPath('userData'), '..', 'trek-developer', 'recent-projects.json')
  ]
  for (const path of paths) {
    try {
      return parseRecents(JSON.parse(await readFile(path, 'utf8')))
    } catch {
      // try the next location
    }
  }
  return []
}

/** Every change is a read-modify-write; chained so two never interleave and lose an entry. */
let chain: Promise<unknown> = Promise.resolve()

function update(change: (list: RecentEntry[]) => RecentEntry[]): Promise<void> {
  const run = chain.then(async () => {
    const next = change(await readRecents())
    await writeFileAtomic(recentsFile(), JSON.stringify(serializeRecents(next), null, 2))
  })
  chain = run.catch(() => undefined)
  return run
}

/**
 * Most recent first. File entries whose file was moved or deleted are dropped;
 * server entries stay until the user removes them, even when their server entry is gone.
 */
export async function getRecents(): Promise<RecentEntry[]> {
  const recents = await readRecents()
  const missing = new Set<string>()
  for (const entry of recents) {
    if (entry.kind !== 'file') continue
    await access(entry.path).catch(() => missing.add(entry.path))
  }
  return keepRecents(recents, missing)
}

export function addRecent(filePath: string): Promise<void> {
  return update((list) => addRecentEntry(list, { kind: 'file', path: filePath }))
}

export function addRecentServer(entry: Extract<RecentEntry, { kind: 'server' }>): Promise<void> {
  return update((list) => addRecentEntry(list, entry))
}

export function removeRecent(entry: RecentEntry): Promise<void> {
  return update((list) => removeRecentEntry(list, entry))
}
