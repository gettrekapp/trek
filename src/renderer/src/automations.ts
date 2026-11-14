// The Automations panel's and the missed-runs modal's pure helpers. Times are shown in each
// automation's own timezone (the one its schedule is read in).
import type { Automation, AutomationMissed, AutomationRun } from '../../shared/model/types'
import { formatWall, nextSlot, parseCron } from '../../shared/cron.ts'

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
