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
  if (typeof expr !== 'string') throw new CronError('a cron expression must be a string')
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
    // No offset change within reach of this wall day: every slot is the wall time less one offset.
    const before = wallAsUtc(day - MAX_OFFSET_MS, tz) - (day - MAX_OFFSET_MS)
    const afterOff = wallAsUtc(day + DAY_MS + MAX_OFFSET_MS, tz) - (day + DAY_MS + MAX_OFFSET_MS)
    const steady = before === afterOff
    const offset = before
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const guess = day + hour * 3_600_000 + minute * MINUTE_MS
        if (guess + MAX_OFFSET_MS <= after) continue
        if (guess - MAX_OFFSET_MS > until) return
        const t = steady ? guess - offset : zonedToUtc(guess, tz)
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

/**
 * No two slots within 5 minutes: over the 8 days after `from` (covers weekly schedules), and over
 * the 8 days starting a day before each offset change in the next year (a spring-forward can
 * squeeze two wall-clock times together, e.g. 01:58 and 03:00).
 */
export function minGapOk(spec: CronSpec, tz: string, from: number): boolean {
  const windows = [from]
  let prev = wallAsUtc(from, tz) - from
  for (let t = from + DAY_MS; t <= from + 366 * DAY_MS; t += DAY_MS) {
    const off = wallAsUtc(t, tz) - t
    if (off !== prev) windows.push(t - 2 * DAY_MS)
    prev = off
  }
  for (const start of windows) {
    let last: number | undefined
    for (const t of slots(spec, tz, start, start + 8 * DAY_MS)) {
      if (last !== undefined && t - last < MIN_GAP_MS) return false
      last = t
    }
  }
  return true
}

// ---- The editor's friendly picker ------------------------------------------------------------

export const MINUTE_STEPS = [5, 10, 15, 20, 30] as const
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const
export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export type SchedulePicker =
  | { kind: 'minutes'; every: number }
  | { kind: 'hours'; every: number; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; days: number[]; hour: number; minute: number }

export function cronFromPicker(p: SchedulePicker): string {
  switch (p.kind) {
    case 'minutes':
      return `*/${p.every} * * * *`
    case 'hours':
      return `${p.minute} ${p.every === 1 ? '*' : `*/${p.every}`} * * *`
    case 'daily':
      return `${p.minute} ${p.hour} * * *`
    case 'weekly':
      return `${p.minute} ${p.hour} * * ${[...new Set(p.days)].sort((a, b) => a - b).join(',')}`
  }
}

const NUM = (text: string, min: number, max: number): number | null => {
  if (!/^\d{1,2}$/.test(text)) return null
  const n = Number(text)
  return n >= min && n <= max ? n : null
}

/** The picker that writes this cron, or null (the editor shows it in Advanced). */
export function pickerFromCron(cron: string): SchedulePicker | null {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5 || f[2] !== '*' || f[3] !== '*') return null
  const [min, hour, , , dow] = f
  const step = /^\*\/(\d+)$/
  if (hour === '*' && dow === '*') {
    const m = step.exec(min)
    if (m && (MINUTE_STEPS as readonly number[]).includes(Number(m[1]))) return { kind: 'minutes', every: Number(m[1]) }
    const minute = NUM(min, 0, 59)
    return minute === null ? null : { kind: 'hours', every: 1, minute }
  }
  const minute = NUM(min, 0, 59)
  if (minute === null) return null
  const h = step.exec(hour)
  if (h && dow === '*') {
    const every = Number(h[1])
    return (HOUR_STEPS as readonly number[]).includes(every) && every !== 1 ? { kind: 'hours', every, minute } : null
  }
  const hourN = NUM(hour, 0, 23)
  if (hourN === null) return null
  if (dow === '*') return { kind: 'daily', hour: hourN, minute }
  const days = dow.split(',').map((d) => NUM(d, 0, 7))
  if (days.some((d) => d === null)) return null
  return { kind: 'weekly', days: [...new Set(days.map((d) => (d as number) % 7))].sort((a, b) => a - b), hour: hourN, minute }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** A short description for the list, e.g. "Weekdays at 09:00". */
export function describeCron(cron: string): string {
  let spec: CronSpec
  try {
    spec = parseCron(cron)
  } catch {
    return 'Invalid schedule'
  }
  const f = cron.trim().split(/\s+/)
  const picker = pickerFromCron(cron)
  if (picker?.kind === 'minutes') return `Every ${picker.every} minutes`
  if (picker?.kind === 'hours') {
    const base = picker.every === 1 ? 'Every hour' : `Every ${picker.every} hours`
    return picker.minute === 0 ? base : `${base} at :${pad(picker.minute)}`
  }
  const singleTime = spec.minutes.length === 1 && spec.hours.length === 1 && f[2] === '*' && f[3] === '*'
  if (singleTime) {
    const at = `${pad(spec.hours[0])}:${pad(spec.minutes[0])}`
    if (!spec.weekdayRestricted) return `Daily at ${at}`
    const days = [...spec.weekdays].sort((a, b) => a - b)
    const key = days.join(',')
    if (key === '1,2,3,4,5') return `Weekdays at ${at}`
    if (key === '0,6') return `Weekends at ${at}`
    if (days.length === 7) return `Daily at ${at}`
    const monFirst = [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)]
    return `${monFirst.map((d) => WEEKDAY_NAMES[d]).join(', ')} at ${at}`
  }
  return `Cron: ${cron.trim()}`
}

/** "09:00", or "2026-01-05 09:00" with the date, in `tz`. */
export function formatWall(ms: number, tz: string, withDate = false): string {
  const w = wallTime(ms, tz)
  const time = `${pad(w.hour)}:${pad(w.minute)}`
  return withDate ? `${w.year}-${pad(w.month)}-${pad(w.day)} ${time}` : time
}
