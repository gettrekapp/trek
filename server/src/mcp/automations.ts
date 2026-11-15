// Automations as MCP tools see them: describing one, finding one by id or name, and the
// `automation.save` input a save_automation call makes. Pure; the checks stay in
// server/src/automations/model.ts, behind the v2 method.
import type { Automation, Project } from '../../../src/shared/model/types'
import { nextSlot, parseCron } from '../../../src/shared/cron.ts'
import { codedError } from '../errors.ts'

const bad = (message: string): Error => codedError('BAD_REQUEST', message)
const iso = (ms: number): string => new Date(ms).toISOString()

/** The next slot after `now`; undefined when disabled, or when a stored cron no longer parses (a hand-edited file). */
function nextRun(a: Automation, now: number): number | undefined {
  if (!a.enabled) return undefined
  try {
    return nextSlot(parseCron(a.schedule.cron), a.schedule.tz, now)
  } catch {
    return undefined
  }
}

/** What list_automations returns for one automation. */
export function describeAutomation(project: Project, a: Automation, now: number) {
  const tab = project.globalSessions.find((s) => s.context?.kind === 'automation' && s.context.automationId === a.id)
  const next = nextRun(a, now)
  return {
    id: a.id,
    name: a.name,
    prompt: a.prompt,
    cron: a.schedule.cron,
    timezone: a.schedule.tz,
    enabled: a.enabled,
    ...(a.llm ? { llm: a.llm } : {}),
    ...(next !== undefined ? { nextRun: iso(next) } : {}),
    ...(a.missed ? { missed: { since: iso(a.missed.since), count: a.missed.count } } : {}),
    ...(tab ? { runSession: { terminalId: tab.id, status: tab.status } } : {}),
    history: a.history.map((r) => ({ at: iso(r.at), trigger: r.trigger, outcome: r.outcome, ...(r.error ? { error: r.error } : {}) }))
  }
}

/** An automation by id, then by name (trimmed, case-insensitive); names are not unique, so a name can be ambiguous. */
export function resolveAutomation(project: Project, ref: unknown): Automation {
  if (typeof ref !== 'string' || ref.trim() === '') throw bad('automation is required: an id or name from list_automations')
  const list = project.automations ?? []
  const byId = list.find((a) => a.id === ref.trim())
  if (byId) return byId
  const wanted = ref.trim().toLowerCase()
  const named = list.filter((a) => a.name.trim().toLowerCase() === wanted)
  if (named.length === 1) return named[0]
  if (named.length > 1) throw bad(`"${ref}" names several automations; pass an id: ${named.map((a) => a.id).join(', ')}`)
  const has = list.length > 0 ? `it has: ${list.map((a) => a.name).join(', ')}` : 'it has none'
  throw codedError('NOT_FOUND', `No automation "${ref}" in this project; ${has}`)
}

/**
 * The `automation.save` input for a save_automation call: `existing` overlaid with the arguments
 * passed (absent or null = keep), or a new one with its defaults. Values go through unchecked:
 * `automation.save` checks them. `llm: null` clears the agent; absent keeps it.
 */
export function automationInput(existing: Automation | undefined, args: Record<string, unknown>, defaultTz: string): Record<string, unknown> {
  const given = (key: string): boolean => args[key] !== undefined && args[key] !== null
  if (!existing) {
    for (const key of ['name', 'prompt', 'cron']) {
      if (!given(key)) throw bad(`${key} is required to create an automation`)
    }
  }
  return {
    ...(existing ? { id: existing.id } : {}),
    name: given('name') ? args.name : existing?.name,
    prompt: given('prompt') ? args.prompt : existing?.prompt,
    schedule: {
      cron: given('cron') ? args.cron : existing?.schedule.cron,
      tz: given('timezone') ? args.timezone : (existing?.schedule.tz ?? defaultTz)
    },
    enabled: given('enabled') ? args.enabled : (existing?.enabled ?? true),
    llm: args.llm === undefined ? (existing?.llm ?? null) : args.llm
  }
}
