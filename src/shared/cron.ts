// Automations' schedules: a 5-field cron (minute hour day-of-month month day-of-week) read as
// wall-clock time in an IANA timezone, with Intl only (no timezone library). Pure: the server's
// scheduler, its validation and the client's editor all use it.
//
// - `*`, numbers, lists `a,b`, ranges `a-b`, steps `*/n`, `a-b/n` and `a/n` (a to the field's max).
//   No names (MON, JAN), no @macros, no seconds. Day of week 0–7, 0 and 7 being Sunday.
// - Day of month and day of week: when both are restricted (neither starts with `*`), a day
//   matching either matches (the usual cron rule).
// - DST: a wall-clock minute that doesn't exist (spring forward) is skipped; one that happens
//   twice (fall back) fires once, on its first occurrence.

export class CronError extends Error {}

export interface CronSpec {
  /** Ascending */
  minutes: number[]
  /** Ascending */
  hours: number[]
  days: Set<number>
  months: Set<number>
  /** 0–6, Sunday 0 */
  weekdays: Set<number>
  dayRestricted: boolean
  weekdayRestricted: boolean
}

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
/** Offsets from UTC are within ±14 hours: a wall-clock guess this far off can't be the instant. */
const MAX_OFFSET_MS = 14 * 3_600_000
/** slotSpan looks back at most this far: older slots only add to a count nobody needs exactly. */
const SPAN_DAYS = 400
/** nextSlot looks this far ahead (Feb 29 can be almost 8 years away). */
const NEXT_SEARCH_DAYS = 366 * 8
export const MIN_GAP_MS = 5 * MINUTE_MS

interface FieldDef {
  name: string
  min: number
  max: number
}
const FIELDS: readonly FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 }
]

function parseField(text: string, f: FieldDef): number[] {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new CronError(`${f.name}: "${part}" is not a number, range or step`)
    const lo = m[1] === '*' ? f.min : Number(m[2])
    const hi = m[1] === '*' ? f.max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? f.max : lo
    const step = m[4] !== undefined ? Number(m[4]) : 1
    if (lo < f.min || hi > f.max || lo > hi) throw new CronError(`${f.name}: "${part}" is outside ${f.min}–${f.max}`)
    if (step < 1) throw new CronError(`${f.name}: a step must be at least 1`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

/** Throws CronError with a message fit for the user. */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5 || fields[0] === '') throw new CronError('a cron expression has 5 fields: minute hour day-of-month month day-of-week')
  const [minutes, hours, days, months, weekdays] = fields.map((text, i) => parseField(text, FIELDS[i]))
  return {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((d) => d % 7)),
    dayRestricted: !fields[2].startsWith('*'),
    weekdayRestricted: !fields[4].startsWith('*')
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    formatters.set(tz, f)
  }
  return f
}

export function validTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz === '') return false
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

export interface WallTime {
  year: number
  /** 1–12 */
  month: number
  day: number
  hour: number
  minute: number
}

/** The wall-clock time at `ms` in `tz`. */
export function wallTime(ms: number, tz: string): WallTime {
  const parts: Record<string, number> = {}
  for (const p of formatter(tz).formatToParts(ms)) if (p.type !== 'literal') parts[p.type] = Number(p.value)
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute }
}

/** The wall time as if it were UTC: comparing it with a real instant gives the offset. */
function wallAsUtc(ms: number, tz: string): number {
  const w = wallTime(ms, tz)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute)
}

/** The first instant whose wall-clock time in `tz` is this one; undefined when it doesn't exist (DST gap). */
function zonedToUtc(guess: number, tz: string): number | undefined {
  // Around a transition the offsets a day before and a day after are the two in play.
  const offsets = new Set([wallAsUtc(guess - DAY_MS, tz) - (guess - DAY_MS), wallAsUtc(guess + DAY_MS, tz) - (guess + DAY_MS)])
  let best: number | undefined
  for (const offset of offsets) {
    const t = guess - offset
    if (wallAsUtc(t, tz) === guess && (best === undefined || t < best)) best = t
  }
  return best
}

function dayMatches(spec: CronSpec, month: number, day: number, weekday: number): boolean {
  if (!spec.months.has(month)) return false
  const dom = spec.days.has(day)
  const dow = spec.weekdays.has(weekday)
  if (spec.dayRestricted && spec.weekdayRestricted) return dom || dow
  return dom && dow
}

/** The slots in (after, until], ascending. */
export function* slots(spec: CronSpec, tz: string, after: number, until: number): Generator<number> {
  if (until <= after) return
  const start = wallTime(after, tz)
  const end = wallTime(until, tz)
  const endDay = Date.UTC(end.year, end.month - 1, end.day)
  for (let day = Date.UTC(start.year, start.month - 1, start.day); day <= endDay; day += DAY_MS) {
    const date = new Date(day)
    if (!dayMatches(spec, date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCDay())) continue
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const guess = day + hour * 3_600_000 + minute * MINUTE_MS
        if (guess + MAX_OFFSET_MS <= after) continue
        if (guess - MAX_OFFSET_MS > until) return
        const t = zonedToUtc(guess, tz)
        if (t === undefined || t <= after) continue
        if (t > until) return
        yield t
      }
    }
  }
}

export function slotsBetween(spec: CronSpec, tz: string, after: number, until: number): number[] {
  return [...slots(spec, tz, after, until)]
}

/** The first and last slot in (after, until] and how many; `after` is clamped to 400 days back. */
export function slotSpan(spec: CronSpec, tz: string, after: number, until: number): { first: number; last: number; count: number } | undefined {
  let first: number | undefined
  let last = 0
  let count = 0
  for (const t of slots(spec, tz, Math.max(after, until - SPAN_DAYS * DAY_MS), until)) {
    first ??= t
    last = t
    count++
  }
  return first === undefined ? undefined : { first, last, count }
}

export function nextSlot(spec: CronSpec, tz: string, after: number): number | undefined {
  for (const t of slots(spec, tz, after, after + NEXT_SEARCH_DAYS * DAY_MS)) return t
  return undefined
}

/** The next `n` slots after `after` (the editor's preview). */
export function nextSlots(spec: CronSpec, tz: string, after: number, n: number): number[] {
  const out: number[] = []
  if (n <= 0) return out
  for (const t of slots(spec, tz, after, after + NEXT_SEARCH_DAYS * DAY_MS)) {
    out.push(t)
    if (out.length >= n) break
  }
  return out
}

/** No two slots within 5 minutes, over the 8 days after `from` (covers weekly schedules and a DST change). */
export function minGapOk(spec: CronSpec, tz: string, from: number): boolean {
  let prev: number | undefined
  for (const t of slots(spec, tz, from, from + 8 * DAY_MS)) {
    if (prev !== undefined && t - prev < MIN_GAP_MS) return false
    prev = t
  }
  return true
}
