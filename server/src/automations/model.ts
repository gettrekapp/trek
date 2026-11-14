// Automations' input checks and the mutations the v2 methods make (server/src/automations/
// automationHandlers.ts). Pure: they take and return lists; ProjectState.apply saves them.
import type { Automation } from '../../../src/shared/model/types'
import { CronError, minGapOk, nextSlot, parseCron, validTimeZone } from '../../../src/shared/cron.ts'
import { getProvider, isProviderId } from '../../../src/shared/providers/registry.ts'
import { sanitizeLlmSelection } from '../../../src/shared/providers/selection.ts'
import type { LlmSelection } from '../../../src/shared/providers/types'
import { codedError } from '../errors.ts'
import { isRecord, requireBoolean } from '../validate.ts'

export const MAX_AUTOMATIONS = 50
export const MAX_AUTOMATION_NAME = 80
export const MAX_AUTOMATION_PROMPT = 20_000

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/** A checked `automation.save` input: `llm` absent means the project's Global agent. */
export interface CheckedInput {
  id?: string
  name: string
  prompt: string
  schedule: { cron: string; tz: string }
  enabled: boolean
  llm?: LlmSelection
}

export function checkSchedule(raw: unknown, now: number): { cron: string; tz: string } {
  if (!isRecord(raw)) throw bad('automation.schedule must be an object')
  const { cron, tz } = raw
  if (typeof cron !== 'string') throw bad('automation.schedule.cron must be a string')
  if (typeof tz !== 'string' || !validTimeZone(tz)) throw bad('automation.schedule.tz must be an IANA timezone, e.g. America/New_York')
  let spec
  try {
    spec = parseCron(cron)
  } catch (err) {
    throw bad(`automation.schedule.cron: ${err instanceof CronError ? err.message : String(err)}`)
  }
  if (nextSlot(spec, tz, now) === undefined) throw bad('automation.schedule.cron never matches a date')
  if (!minGapOk(spec, tz, now)) throw bad('automation.schedule.cron must not run more often than every 5 minutes')
  return { cron: cron.trim().split(/\s+/).join(' '), tz }
}

export function checkInput(raw: unknown, now: number): CheckedInput {
  if (!isRecord(raw)) throw bad('automation must be an object')
  const out: CheckedInput = { name: '', prompt: '', schedule: { cron: '', tz: '' }, enabled: false }
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || raw.id === '') throw bad('automation.id must be a non-empty string')
    out.id = raw.id
  }
  if (typeof raw.name !== 'string' || raw.name.trim() === '') throw bad('automation.name must not be empty')
  const name = raw.name.trim()
  if (name.length > MAX_AUTOMATION_NAME) throw bad(`automation.name must be at most ${MAX_AUTOMATION_NAME} characters`)
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw bad('automation.name must not contain control characters')
  out.name = name
  if (typeof raw.prompt !== 'string' || raw.prompt.trim() === '') throw bad('automation.prompt must not be empty')
  const prompt = raw.prompt.trim()
  if (prompt.length > MAX_AUTOMATION_PROMPT) throw bad(`automation.prompt must be at most ${MAX_AUTOMATION_PROMPT} characters`)
  out.prompt = prompt
  out.schedule = checkSchedule(raw.schedule, now)
  out.enabled = requireBoolean(raw.enabled, 'automation.enabled')
  if (raw.llm !== undefined && raw.llm !== null) {
    // sanitizeLlmSelection turns an unknown provider into Claude: refuse it instead (as session.start does).
    if (!isRecord(raw.llm) || !isProviderId(raw.llm.provider)) throw bad('automation.llm.provider must be a known provider')
    const llm = sanitizeLlmSelection(raw.llm)
    if (!llm) throw bad('automation.llm must be an LLM selection')
    if (!getProvider(llm.provider).capabilities.mcp) throw bad('automation.llm.provider must be an agent that can use Trek’s tools (MCP)')
    out.llm = llm
  }
  return out
}

/** Creates (no id) or updates one. A schedule change or a re-enable restarts the clock: nothing counts as missed. */
export function saveAutomation(list: readonly Automation[], input: CheckedInput, now: number, newId: () => string): { list: Automation[]; id: string } {
  const { id, llm, ...fields } = input
  if (id === undefined) {
    if (list.length >= MAX_AUTOMATIONS) throw codedError('CAPACITY', `a project holds at most ${MAX_AUTOMATIONS} automations`)
    const created: Automation = { id: newId(), ...fields, ...(llm ? { llm } : {}), createdAt: now, lastSlot: now, history: [] }
    return { list: [...list, created], id: created.id }
  }
  const i = list.findIndex((a) => a.id === id)
  if (i < 0) throw codedError('NOT_FOUND', `No automation with id "${id}"`)
  const prev = list[i]
  const next: Automation = { ...prev, ...fields }
  if (llm) next.llm = llm
  else delete next.llm
  const scheduleChanged = prev.schedule.cron !== fields.schedule.cron || prev.schedule.tz !== fields.schedule.tz
  if (scheduleChanged || (!prev.enabled && fields.enabled)) {
    next.lastSlot = now
    delete next.missed
  }
  if (!fields.enabled) delete next.missed
  return { list: list.map((a, j) => (j === i ? next : a)), id }
}

export function deleteAutomation(list: readonly Automation[], id: string): Automation[] {
  if (!list.some((a) => a.id === id)) throw codedError('NOT_FOUND', `No automation with id "${id}"`)
  return list.filter((a) => a.id !== id)
}

/** Clears `missed` on the given ids; `cleared` lists those that had one. */
export function clearMissed(list: readonly Automation[], ids: readonly string[]): { list: Automation[]; cleared: string[] } {
  const wanted = new Set(ids)
  const cleared: string[] = []
  const out = list.map((a) => {
    if (!wanted.has(a.id) || !a.missed) return a
    cleared.push(a.id)
    const { missed: _missed, ...rest } = a
    return rest
  })
  return { list: out, cleared }
}
