// The Automations panel's and the missed-runs modal's pure helpers. Times are shown in each
// automation's own timezone (the one its schedule is read in).
import type { Automation, AutomationMissed } from '../../shared/model/types'
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

export function lastRunLabel(a: Automation): string {
  const last = a.history[0]
  if (!last) return 'Never run'
  const when = formatWall(last.at, a.schedule.tz, true)
  return last.outcome === 'ran' ? `Last: ${when} · ran` : `Last: ${when} · failed: ${last.error ?? 'unknown error'}`
}
