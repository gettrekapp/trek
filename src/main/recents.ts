import { app } from 'electron'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_RECENTS = 8

function recentsFile(): string {
  return join(app.getPath('userData'), 'recent-projects.json')
}

async function readRecents(): Promise<string[]> {
  const paths = [
    recentsFile(),
    // Pre-rename userData dir (app was "trek-developer" before "Trek Dev")
    join(app.getPath('userData'), '..', 'trek-developer', 'recent-projects.json')
  ]
  for (const path of paths) {
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : []
    } catch {
      // try the next location
    }
  }
  return []
}

/** Recent project files that still exist on disk, most recent first. */
export async function getRecents(): Promise<string[]> {
  const recents = await readRecents()
  const existing: string[] = []
  for (const path of recents) {
    try {
      await access(path)
      existing.push(path)
    } catch {
      // dropped: file was moved or deleted
    }
  }
  return existing
}

export async function addRecent(filePath: string): Promise<void> {
  const recents = await readRecents()
  const updated = [filePath, ...recents.filter((p) => p !== filePath)].slice(0, MAX_RECENTS)
  await writeFile(recentsFile(), JSON.stringify(updated, null, 2), 'utf8')
}
