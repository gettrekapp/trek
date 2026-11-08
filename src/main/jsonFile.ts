// Reading a JSON store in userData that the app rewrites whole (migrated.json). No Electron: tested directly.
import { readFile, rename } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * The file's JSON, or undefined when there is none. A file that is there but does not parse,
 * or whose JSON `valid` refuses, is moved aside as `<file>.corrupt-<time>` (as app-servers.json
 * is) with a warning, so the next write starts afresh without losing it. Any other read error
 * is warned about and reads as undefined, the file left where it is.
 */
export async function readJsonStore(path: string, valid: (raw: unknown) => boolean, now: () => number = Date.now): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`trek: ${basename(path)} could not be read`, err)
    return undefined
  }
  let why: string
  try {
    const raw: unknown = JSON.parse(text)
    if (valid(raw)) return raw
    why = 'not what Trek writes there'
  } catch (err) {
    why = err instanceof Error ? err.message : String(err)
  }
  const aside = `${path}.corrupt-${now()}`
  try {
    await rename(path, aside)
    console.warn(`trek: ${basename(path)} could not be read (${why}); moved it to ${aside}`)
  } catch (err) {
    // Another read moved it first: it is aside either way.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`trek: ${basename(path)} could not be read (${why}), nor moved aside`, err)
  }
  return undefined
}
