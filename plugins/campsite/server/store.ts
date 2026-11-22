// camp.json (campsite part 2): the camp, loaded once, saved atomically (a temp file renamed over it)
// at most once per debounce and on dispose. A file that can't be read as a camp is moved aside to
// camp.json.bak and a new camp starts, with a warning: the camp never stops the server.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { CAMP_VERSION, isCamp, newCamp, type Camp } from '../shared/camp.ts'
import { restore, RULES, type Rules } from '../shared/economy.ts'

export interface CampStore {
  readonly camp: Camp
  /** Something changed: save within the debounce */
  changed(): void
  /** Save now */
  flush(): void
  dispose(): void
}

export interface CampStoreOptions {
  now: () => number
  /** A new camp's seed */
  seed: () => number
  warn: (message: string) => void
  schedule?: (fn: () => void, ms: number) => { cancel(): void }
  debounceMs?: number
  rules?: Rules
}

const defaultSchedule = (fn: () => void, ms: number): { cancel(): void } => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

/** A camp, and whether it may be saved (false: the file is from a newer Trek and stays as it is) */
function load(file: string, o: CampStoreOptions): { camp: Camp; writable: boolean } {
  if (!existsSync(file)) return { camp: newCamp(o.seed(), o.now()), writable: true }
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const version = typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined
    if (typeof version === 'number' && version > CAMP_VERSION) {
      o.warn(`[campsite] camp.json is version ${version}, newer than this Trek understands (${CAMP_VERSION}): left as it is, and this run's camp is not saved`)
      return { camp: newCamp(o.seed(), o.now()), writable: false }
    }
    if (!isCamp(raw)) throw new Error('not a camp')
    restore(raw, o.rules ?? RULES)
    return { camp: raw, writable: true }
  } catch (err) {
    try {
      renameSync(file, `${file}.bak`)
    } catch {
      // nothing to move
    }
    o.warn(`[campsite] camp.json could not be read (${err instanceof Error ? err.message : String(err)}): moved to camp.json.bak, a new camp starts`)
    return { camp: newCamp(o.seed(), o.now()), writable: true }
  }
}

export function openCampStore(file: string, o: CampStoreOptions): CampStore {
  const { camp, writable } = load(file, o)
  let disposed = false
  const schedule = o.schedule ?? defaultSchedule
  let pending: { cancel(): void } | null = null
  const save = (): void => {
    if (!writable) return
    pending?.cancel()
    pending = null
    camp.savedAt = o.now()
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(camp))
      renameSync(`${file}.tmp`, file)
    } catch (err) {
      o.warn(`[campsite] camp.json could not be saved: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {
    camp,
    changed: () => {
      if (disposed) return
      pending ??= schedule(save, o.debounceMs ?? 2000)
    },
    flush: save,
    dispose: () => {
      if (disposed) return
      save()
      disposed = true
    }
  }
}
