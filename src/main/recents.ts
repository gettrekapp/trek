import { app } from 'electron'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addRecentEntry, keepRecents, parseRecents, serializeRecents, type RecentEntry } from './recentsRules'

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

async function writeRecents(list: RecentEntry[]): Promise<void> {
  await writeFile(recentsFile(), JSON.stringify(serializeRecents(list), null, 2), 'utf8')
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

export async function addRecent(filePath: string): Promise<void> {
  await writeRecents(addRecentEntry(await readRecents(), { kind: 'file', path: filePath }))
}

export async function addRecentServer(entry: Extract<RecentEntry, { kind: 'server' }>): Promise<void> {
  await writeRecents(addRecentEntry(await readRecents(), entry))
}
