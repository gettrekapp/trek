// The Automations panel's and the missed-runs modal's pure helpers. Times are shown in each
// automation's own timezone (the one its schedule is read in).
import type { Automation, AutomationMissed, AutomationRun } from '../../shared/model/types'
import { WEEKDAY_NAMES, cronFromPicker, describeCron, formatWall, nextSlot, parseCron, pickerFromCron, wallTime, type SchedulePicker } from '../../shared/cron.ts'

export function missedRows(automations: readonly Automation[] | undefined): Automation[] {
  return (automations ?? []).filter((a) => a.missed)
}

/** Identifies the pending set: a new miss (another automation, a higher count) changes it. */
export function missedKey(automations: readonly Automation[] | undefined): string {
  return missedRows(automations).map((a) => `${a.id}:${a.missed?.since}:${a.missed?.count}`).join(',')
}

export function missedLabel(missed: AutomationMissed, tz: string): string {
  const since = formatWall(missed.since, tz, true)
  return missed.count === 1 ? `missed its ${since} run` : `missed ${missed.count} runs since ${since}`
}

export function nextRunLabel(a: Automation, now: number): string {
  if (!a.enabled) return 'Paused'
  try {
    const next = nextSlot(parseCron(a.schedule.cron), a.schedule.tz, now)
    return next === undefined ? 'No upcoming run' : `Next: ${formatWall(next, a.schedule.tz, true)}`
  } catch {
    return 'Invalid schedule'
  }
}

/** The server's error for a run skipped because the automation's run tab was busy. */
export const SKIPPED_ERROR = 'previous run still working'

/** A run's outcome in a line: ran, skipped (its tab was busy), or failed with its error. */
export function runOutcomeLabel(run: AutomationRun): string {
  if (run.outcome === 'ran') return 'ran'
  if (run.outcome === 'skipped') return `skipped: ${run.error ?? SKIPPED_ERROR}`
  return `failed: ${run.error ?? 'unknown error'}`
}

export function lastRunLabel(a: Automation): string {
  const last = a.history[0]
  if (!last) return 'Never run'
  return `Last: ${formatWall(last.at, a.schedule.tz, true)} · ${runOutcomeLabel(last)}`
}

/** Run now's refusal shown inline: a CONFLICT is the run tab still busy with the last run. Else undefined (the usual text). */
export function runNowError(err: unknown): string | undefined {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
  return code === 'CONFLICT' ? 'The previous run is still working' : undefined
}

/** A missed run that did not start, for the missed-runs modal's list. */
export function resolveMissedError(name: string, error: string): string {
  return error === SKIPPED_ERROR ? `${name}: skipped, the previous run is still working` : `${name}: ${error}`
}

// ---- The Automations page: a list of rows and the selected automation's detail -----------------

/**
 * How an automation stands, for its row's mark and line — the first that applies:
 * missed runs wait for an answer; its run tab is working; it is paused; its newest run failed;
 * it has never run; else it waits for its next run.
 */
export type AutomationState = 'missed' | 'running' | 'paused' | 'failed' | 'never' | 'waiting'

export function automationState(a: Automation, running: boolean): AutomationState {
  if (a.missed) return 'missed'
  if (running) return 'running'
  if (!a.enabled) return 'paused'
  if (a.history[0]?.outcome === 'failed') return 'failed'
  return a.history.length === 0 ? 'never' : 'waiting'
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The calendar day `ms` falls on in `tz`, as a count of days. */
const dayIndex = (ms: number, tz: string): number => {
  const w = wallTime(ms, tz)
  return Date.UTC(w.year, w.month - 1, w.day) / DAY
}

/** How many calendar days in `tz` the instant `at` is after `now`'s day. */
const daysAhead = (at: number, now: number, tz: string): number => dayIndex(at, tz) - dayIndex(now, tz)

/**
 * When a coming run is, short enough for a row: minutes under an hour, hours under twelve, then
 * the day and the time in `tz` — today, tomorrow, the weekday within the week — and from a week
 * on the date alone, where a weekday would read as this week's.
 */
export function relativeUntil(at: number, now: number, tz: string): string {
  const ms = at - now
  if (ms < MINUTE) return 'in under a minute'
  if (ms < HOUR) return `in ${Math.floor(ms / MINUTE)} min`
  if (ms < 12 * HOUR) return `in ${Math.floor(ms / HOUR)} h`
  const days = daysAhead(at, now, tz)
  if (days === 0) return `today ${formatWall(at, tz)}`
  if (days === 1) return `tomorrow ${formatWall(at, tz)}`
  // The calendar day in `tz` as a UTC date: its weekday is the one the timezone's clock shows.
  if (days < 7) return `${WEEKDAY_NAMES[new Date(dayIndex(at, tz) * DAY).getUTCDay()]} ${formatWall(at, tz)}`
  return formatWall(at, tz, true).slice(0, 10)
}

/** A piece of a row's text with how it is coloured: quiet, asking for the user, or a fault. */
export interface RowFact {
  text: string
  tone: 'muted' | 'attention' | 'danger'
}

/** The one fact a row gives after its schedule. */
export function automationFact(a: Automation, state: AutomationState, now: number): RowFact {
  if (state === 'missed') {
    const count = a.missed?.count ?? 0
    return { text: count === 1 ? '1 run missed' : `${count} runs missed`, tone: 'attention' }
  }
  if (state === 'running') return { text: 'running now', tone: 'muted' }
  if (state === 'paused') return { text: 'paused', tone: 'muted' }
  if (state === 'failed') return { text: 'last run failed', tone: 'danger' }
  try {
    const next = nextSlot(parseCron(a.schedule.cron), a.schedule.tz, now)
    return next === undefined ? { text: 'no upcoming run', tone: 'muted' } : { text: `next ${relativeUntil(next, now, a.schedule.tz)}`, tone: 'muted' }
  } catch {
    return { text: 'invalid schedule', tone: 'danger' }
  }
}

/** A row's line: the schedule in words, then the fact. Offline a countdown cannot be trusted, so the schedule stands alone. */
export function automationRowLine(a: Automation, state: AutomationState, now: number, offline: boolean): RowFact {
  const schedule = describeCron(a.schedule.cron)
  const fact = automationFact(a, state, now)
  // describeCron already says an invalid schedule is one.
  if (fact.text === 'invalid schedule') return { text: schedule, tone: 'danger' }
  if (offline && (state === 'waiting' || state === 'never')) return { text: schedule, tone: 'muted' }
  return { text: `${schedule} · ${fact.text}`, tone: fact.tone }
}

/** The detail's Next run: the wall time, and how far off it is while that says more than the date above it does (up to tomorrow). */
export function nextRunFact(a: Automation, now: number): { value: string; sub: string | null } {
  if (!a.enabled) return { value: 'Paused', sub: null }
  try {
    const next = nextSlot(parseCron(a.schedule.cron), a.schedule.tz, now)
    if (next === undefined) return { value: 'No upcoming run', sub: null }
    const { tz } = a.schedule
    return { value: formatWall(next, tz, true), sub: daysAhead(next, now, tz) < 2 ? relativeUntil(next, now, tz) : null }
  } catch {
    return { value: 'Invalid schedule', sub: null }
  }
}

/** The page's banner while runs wait in the missed-runs modal; null with none. */
export function missedBanner(automations: readonly Automation[] | undefined): string | null {
  const count = missedRows(automations).reduce((sum, a) => sum + (a.missed?.count ?? 0), 0)
  if (count === 0) return null
  return count === 1 ? '1 run was missed while the server was off.' : `${count} runs were missed while the server was off.`
}

/** Who started a run, in the history table's words. */
export const TRIGGER_LABELS: Record<AutomationRun['trigger'], string> = {
  schedule: 'Schedule',
  manual: 'Run now',
  missed: 'Missed, run later'
}

/** The list's order: the project's, with the paused ones after the rest. */
export function sortAutomations<T extends { enabled: boolean }>(list: readonly T[]): T[] {
  return [...list.filter((a) => a.enabled), ...list.filter((a) => !a.enabled)]
}

/** The automations whose run tab (a session the server opened for them) is working now. */
export function runningAutomations(terminals: Record<string, { status: string; context?: { kind: string; automationId?: string } } | undefined>): Set<string> {
  const ids = new Set<string>()
  for (const t of Object.values(terminals)) {
    if (t?.status === 'working' && t.context?.kind === 'automation' && t.context.automationId) ids.add(t.context.automationId)
  }
  return ids
}

/** The picker a schedule kind starts from, when the editor switches to it. */
export function defaultPicker(kind: SchedulePicker['kind']): SchedulePicker {
  if (kind === 'minutes') return { kind, every: 15 }
  if (kind === 'hours') return { kind, every: 1, minute: 0 }
  if (kind === 'daily') return { kind, hour: 9, minute: 0 }
  return { kind, days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }
}

/** The editor's schedule as it holds it: the cron line while `advanced`, else the picker. */
export interface ScheduleChoice {
  advanced: boolean
  cron: string
  picker: SchedulePicker
}

/** A cron line the pickers cannot write can only be edited as cron. */
export function cronOnly(advanced: boolean, cron: string): boolean {
  return advanced && pickerFromCron(cron) === null
}

/** The editor's schedule after a kind is picked from its row: one of the picker's, or cron. */
export function chooseScheduleKind(state: ScheduleChoice, next: SchedulePicker['kind'] | 'cron'): ScheduleChoice {
  if (next === 'cron') {
    // The line starts as what the picker says; one already being edited is left alone.
    return state.advanced ? state : { ...state, advanced: true, cron: cronFromPicker(state.picker) }
  }
  if (cronOnly(state.advanced, state.cron)) return state
  // Leaving cron keeps the line's values where it is of this kind.
  const from = state.advanced ? pickerFromCron(state.cron) : state.picker
  return { ...state, advanced: false, picker: from?.kind === next ? from : defaultPicker(next) }
}
