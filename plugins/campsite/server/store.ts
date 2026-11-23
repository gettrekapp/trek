// camp.json (campsite parts 2, 3a, 3b and 3c): the camp, loaded once (versions 1–3 are migrated to 4), saved atomically (a temp file renamed over it)
// at most once per debounce and on dispose. A file that can't be read as a camp is moved aside to
// camp.json.bak and a new camp starts, with a warning: the camp never stops the server.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { CAMP_VERSION, isCamp, migrateCamp, newCamp, type Camp } from '../shared/camp.ts'
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
  /** A fresh camp's wood and markers (no camp.json yet): TREK_CAMPSITE_SEED_WOOD, for the smokes */
  start?: { wood: number; markers: number }
}

const defaultSchedule = (fn: () => void, ms: number): { cancel(): void } => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

/** A camp, and whether it may be saved (false: the file is from a newer Trek and stays as it is) */
function load(file: string, o: CampStoreOptions): { camp: Camp; writable: boolean } {
  if (!existsSync(file)) {
    const camp = newCamp(o.seed(), o.now())
    if (o.start) {
      camp.wood = o.start.wood
      camp.markers = o.start.markers
    }
    return { camp, writable: true }
  }
  try {
    const raw: unknown = migrateCamp(JSON.parse(readFileSync(file, 'utf8')))
    const version = typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined
    if (typeof version === 'number' && version > CAMP_VERSION) {
      o.warn(`[campsite] camp.json is version ${version}, newer than this Trek understands (${CAMP_VERSION}): left as it is, and this run's camp is not saved`)
      return { camp: newCamp(o.seed(), o.now()), writable: false }
    }
    if (!isCamp(raw)) throw new Error('not a camp')
    const now = o.now()
    restore(raw, o.rules ?? RULES, now)
    // The server was down, not the user away: the seen clocks move on by the downtime, so the
    // minutes restore just paid (and a restart or the upgrade) don't make the away card due
    const down = Math.max(0, now - raw.savedAt)
    raw.seenAt += down
    raw.away.since += down
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
