// camp.json (campsite part 2): the camp, loaded once, saved atomically (a temp file renamed over it)
// at most once per debounce and on dispose. A file that can't be read as a camp is moved aside to
// camp.json.bak and a new camp starts, with a warning: the camp never stops the server.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isCamp, newCamp, type Camp } from '../shared/camp.ts'
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

function load(file: string, o: CampStoreOptions): Camp {
  if (!existsSync(file)) return newCamp(o.seed(), o.now())
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isCamp(raw)) throw new Error('not a camp')
    restore(raw, o.rules ?? RULES)
    return raw
  } catch (err) {
    try {
      renameSync(file, `${file}.bak`)
    } catch {
      // nothing to move
    }
    o.warn(`[campsite] camp.json could not be read (${err instanceof Error ? err.message : String(err)}): moved to camp.json.bak, a new camp starts`)
    return newCamp(o.seed(), o.now())
  }
}

export function openCampStore(file: string, o: CampStoreOptions): CampStore {
  const camp = load(file, o)
  const schedule = o.schedule ?? defaultSchedule
  let pending: { cancel(): void } | null = null
  const save = (): void => {
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
      pending ??= schedule(save, o.debounceMs ?? 2000)
    },
    flush: save,
    dispose: save
  }
}
