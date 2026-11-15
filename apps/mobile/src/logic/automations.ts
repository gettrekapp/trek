// A project's automations on the phone: the project screen's row, a card's lines, the schedule in
// words and its next runs, the missed-runs card and its one answer, a run's row, the run tab, the
// name and prompt edit with its changed-elsewhere rule, what `automation.save` is sent, the question
// before turning one off, and Run now's refusal. The
// rules are the desktop's (AutomationsPanel.tsx, AutomationEditor.tsx, MissedRunsModal.tsx and
// their helpers in src/renderer/src/automations.ts, which the phone cannot import) and the server's
// (automations/automationHandlers.ts, model.ts, scheduler.ts); the schedule's words and slots are
// the shared code's (src/shared/cron.ts). Pure.
//
// Times. A schedule is read in its own timezone, so next runs, a run's time and "missed since" are
// wall-clock times there ("2026-01-05 09:00", as on the desktop), beside the timezone's name; a
// run's age on a card is on the phone's clock ("2 h ago"). The wall-clock times need the engine's
// Intl with time zones (cron.ts: `new Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', …})`
// and `formatToParts`). Nothing here throws when that fails (an engine without it, a timezone it
// does not know, a snapshot that is not what it should be): each function states its fallback.
import { describeCron, formatWall, nextSlots, parseCron } from '../shared.ts'
import type { AgentInfo, Automation, AutomationInput, AutomationRun, AutomationSchedule, Session } from '../shared.ts'
import { ago } from './attention.ts'

/** The list with no automations. */
export const NO_AUTOMATIONS = 'No automations. Create them in the desktop app.'
/** An automation's screen whose automation is no longer in the snapshot. */
export const AUTOMATION_GONE = 'This automation is gone.'
/** Under the schedule, which the phone does not edit. */
export const SCHEDULE_READ_ONLY = 'Change the schedule in the desktop app.'
/** Above the server's name and prompt, when a Save was held back (`saveAutomationEdit`). */
export const AUTOMATION_CHANGED = 'This automation changed on the server'
/** The missed-runs card: its title and first line, and the title over `missedErrors`' lines (the desktop dialog's words). */
export const MISSED_TITLE = 'Missed automations'
export const MISSED_INTRO = 'The server could not run these at their scheduled time. Run them now?'
export const MISSED_ERRORS_TITLE = 'Some automations did not start'
/** The longest name the server takes (automations/model.ts), for the name box's `maxLength`. A longer prompt (20000) is the server's refusal. */
export const MAX_AUTOMATION_NAME = 80
/** The server's error for a run skipped because the run tab was busy (scheduler.ts). */
const SKIPPED_ERROR = 'previous run still working'

/**
 * The project screen's row (shown when the server has the `automations` capability): "Automations
 * · 3", or "Automations" for none; `missed` when any has missed runs, which the screen shows as
 * " · missed runs" in the attention colour after the text.
 */
export function automationsRow(automations: readonly Automation[] | undefined): { text: string; missed: boolean } {
  const list = automations ?? []
  return { text: list.length > 0 ? `Automations · ${list.length}` : 'Automations', missed: list.some((a) => !!a.missed) }
}

/**
 * The schedule in words ("Weekdays at 09:00"; "Cron: 0 9 1 * *" for one only cron can say; "Invalid
 * schedule"), or null when it cannot be worded at all (the screen then has the cron text alone).
 * `describe` is the shared describeCron (a parameter for the tests only).
 */
export function scheduleWords(schedule: AutomationSchedule | undefined, describe: (cron: string) => string = describeCron): string | null {
  try {
    return describe((schedule as AutomationSchedule).cron)
  } catch {
    return null
  }
}

/**
 * A card's schedule line: the words and the timezone, "Weekdays at 09:00 · America/New_York".
 * Fallback: the cron text and the timezone's name; '' for a snapshot without a schedule.
 */
export function scheduleLine(schedule: AutomationSchedule | undefined, describe?: (cron: string) => string): string {
  if (!schedule) return ''
  return `${scheduleWords(schedule, describe) ?? schedule.cron} · ${schedule.tz}`
}

/**
 * "2026-01-05 09:00" in `tz`, or null when the engine cannot say: it threw, or it answered without
 * the parts (cron.ts then computes NaN and does not throw: "NaN-NaN-NaN NaN:NaN").
 */
function wall(ms: number, tz: string): string | null {
  try {
    const text = formatWall(ms, tz, true)
    return text.includes('NaN') ? null : text
  } catch {
    return null
  }
}

/**
 * The next `count` run times after `now` (the automation's screen shows three), each
 * "2026-01-05 09:00" in the schedule's timezone, soonest first. Empty when the automation is off,
 * when the schedule has no slot ahead, and (the fallback) when the times cannot be worked out: the
 * screen then shows no next runs.
 */
export function nextRuns(a: Automation, now: number, count = 3): string[] {
  if (!a.enabled) return []
  try {
    const { cron, tz } = a.schedule
    // An engine that gives no parts makes every slot NaN: no next runs, as when it throws.
    if (wall(now, tz) === null) return []
    const times = nextSlots(parseCron(cron), tz, now, count).map((t) => wall(t, tz))
    return times.every((t): t is string => t !== null) ? times : []
  } catch {
    return []
  }
}

/**
 * A card's next-run line: "Off" for a disabled automation, else "Next: 2026-01-05 09:00" (the
 * schedule's timezone), or "No upcoming run". Fallback: null, no line, when the time cannot be
 * worked out.
 */
export function nextLine(a: Automation, now: number): string | null {
  if (!a.enabled) return 'Off'
  try {
    const { cron, tz } = a.schedule
    if (wall(now, tz) === null) return null
    const [next] = nextSlots(parseCron(cron), tz, now, 1)
    if (next === undefined) return 'No upcoming run'
    const when = wall(next, tz)
    return when === null ? null : `Next: ${when}`
  } catch {
    return null
  }
}

const OUTCOMES: Record<string, string> = { ran: 'Ran', failed: 'Failed', skipped: 'Skipped' }
const TRIGGERS: Record<string, string> = { schedule: 'Scheduled', manual: 'Manual', missed: 'Missed' }

/** A run's error as shown: a failed or skipped run always has words (the desktop's when the server gave none); a run that ran has none. */
function runError(run: AutomationRun): string | undefined {
  if (run.outcome === 'ran') return undefined
  if (run.outcome === 'skipped') return run.error ?? SKIPPED_ERROR
  if (run.outcome === 'failed') return run.error ?? 'unknown error'
  return run.error
}

/**
 * A card's last-run line, from `history[0]`: "Ran 2 h ago", "Failed 2 h ago: <error>", "Skipped
 * 5 min ago: previous run still working", or "Never run". The age is on the phone's clock (`now`).
 */
export function lastRunLine(a: Automation, now: number): string {
  const last = a.history?.[0]
  if (!last) return 'Never run'
  const error = runError(last)
  return `${OUTCOMES[last.outcome] ?? last.outcome} ${ago(last.at, now)}${error ? `: ${error}` : ''}`
}

/**
 * "Agent: Codex · gpt-5 · high" for an automation that names its agent, by the server's label for
 * it (`server.agents`' list; the provider's id without one); null for the project's Global agent.
 */
export function agentLine(a: Automation, agents: readonly AgentInfo[] = []): string | null {
  if (!a.llm) return null
  const label = agents.find((x) => x.provider === a.llm?.provider)?.label ?? a.llm.provider
  return `Agent: ${[label, a.llm.model, a.llm.effort].filter(Boolean).join(' · ')}`
}

/**
 * "3 missed since 2026-01-02 09:00" (the first missed slot, in the schedule's timezone) for an
 * automation with missed runs, else null. Fallback: the slot's age, "3 missed since 2 d ago".
 */
export function missedLine(a: Automation, now: number): string | null {
  if (!a.missed) return null
  return `${a.missed.count} missed since ${wall(a.missed.since, a.schedule?.tz) ?? ago(a.missed.since, now)}`
}

/** A card of the automations list. A null line is not drawn. */
export interface AutomationCard {
  id: string
  name: string
  /** `scheduleLine` */
  schedule: string
  /** `nextLine` */
  next: string | null
  /** `lastRunLine` */
  lastRun: string
  /** `agentLine` */
  agent: string | null
  /** `missedLine` */
  missed: string | null
}

/** A card's lines for one of `project.automations`. `agents`: the server's (`server.agents`), when loaded. */
export function automationCard(a: Automation, now: number, agents?: readonly AgentInfo[]): AutomationCard {
  return { id: a.id, name: a.name, schedule: scheduleLine(a.schedule), next: nextLine(a, now), lastRun: lastRunLine(a, now), agent: agentLine(a, agents), missed: missedLine(a, now) }
}

// ── Missed runs ──────────────────────────────────────────────────────────────────────────────

export type MissedChoice = 'run' | 'skip'
/** The user's choices on the missed-runs card, by automation id; an automation without one is skipped. */
export type MissedChoices = Readonly<Record<string, MissedChoice>>

export interface MissedRow {
  id: string
  name: string
  /** `missedLine` */
  text: string
  choice: MissedChoice
}

/**
 * The missed-runs card's rows: each automation of the snapshot that has missed runs, with the
 * user's choice (Skip until Run is chosen). No rows: no card.
 */
export function missedRows(automations: readonly Automation[] | undefined, choices: MissedChoices, now: number): MissedRow[] {
  return (automations ?? []).filter((a) => a.missed).map((a) => ({ id: a.id, name: a.name, text: missedLine(a, now) ?? '', choice: choices[a.id] === 'run' ? 'run' : 'skip' }))
}

/**
 * The choices that still stand: those for automations that have missed runs now. One answered
 * elsewhere loses its choice, so runs it misses later are skipped again until Run is chosen. The
 * same object when nothing is dropped.
 */
export function missedChoicesKept(automations: readonly Automation[] | undefined, choices: MissedChoices): MissedChoices {
  const missed = new Set((automations ?? []).filter((a) => a.missed).map((a) => a.id))
  const kept = Object.entries(choices).filter(([id]) => missed.has(id))
  return kept.length === Object.keys(choices).length ? choices : Object.fromEntries(kept)
}

/**
 * Done's one request: `automation.resolveMissed`'s `run` and `dismiss` (with the `projectId`), over
 * the snapshot's automations that have missed runs now: those chosen Run, and the rest. A choice
 * for an automation with nothing missed any more is left out (the server would ignore it). Both
 * empty: nothing to send.
 */
export function missedAnswer(automations: readonly Automation[] | undefined, choices: MissedChoices): { run: string[]; dismiss: string[] } {
  const ids = (automations ?? []).filter((a) => a.missed).map((a) => a.id)
  return { run: ids.filter((id) => choices[id] === 'run'), dismiss: ids.filter((id) => choices[id] !== 'run') }
}

/**
 * The lines under MISSED_ERRORS_TITLE after the answer: one for each of its `started` entries that
 * carries an `error` (the run failed, or was skipped: its run tab was busy), by the automation's
 * name, as the desktop words them. The others started; their missed state leaves with the snapshot.
 */
export function missedErrors(automations: readonly Automation[] | undefined, started: readonly { automationId: string; sessionId?: string; error?: string }[]): string[] {
  const names = new Map((automations ?? []).map((a) => [a.id, a.name]))
  return started
    .filter((s) => s.error)
    .map((s) => {
      const name = names.get(s.automationId) ?? s.automationId
      return s.error === SKIPPED_ERROR ? `${name}: skipped, the previous run is still working` : `${name}: ${s.error}`
    })
}

// ── Runs and the run tab ─────────────────────────────────────────────────────────────────────

/** A row of an automation's Runs. */
export interface RunRow {
  /** For the list (a run has no id) */
  key: string
  /** "2026-01-05 09:00" in the schedule's timezone; fallback: its age, "2 h ago" */
  when: string
  /** "Scheduled", "Manual" or "Missed" (a newer server's trigger as it is) */
  trigger: string
  /** "Ran", "Failed" or "Skipped" (a newer server's outcome as it is) */
  outcome: string
  /** Why it failed or was skipped */
  error?: string
  /** The session a tap opens: on the newest run that ran alone, when its session is still one of the project's Global sessions */
  sessionId?: string
}

/**
 * The automation's runs (`history`, newest first, at most 20). `globalSessions`: the project's, to
 * tell whether a run's session still exists. Every run of an automation is in its one run tab, which
 * each run starts afresh, so the tab shows the newest run alone: only the newest row that ran opens
 * its session (the desktop's rule), and no row does once that session is closed.
 */
export function runRows(a: Automation, globalSessions: readonly Pick<Session, 'id'>[] | undefined, now: number): RunRow[] {
  const open = new Set((globalSessions ?? []).map((s) => s.id))
  const history = a.history ?? []
  const newestRan = history.findIndex((run) => run.outcome === 'ran')
  return history.map((run, i) => {
    const error = runError(run)
    return {
      key: `${run.at}:${i}`,
      when: wall(run.at, a.schedule?.tz) ?? ago(run.at, now),
      trigger: TRIGGERS[run.trigger] ?? run.trigger,
      outcome: OUTCOMES[run.outcome] ?? run.outcome,
      ...(error ? { error } : {}),
      ...(i === newestRan && run.sessionId && open.has(run.sessionId) ? { sessionId: run.sessionId } : {})
    }
  })
}

/**
 * The automation's run tab for "Open run tab": the Global session (`project.globalSessions`) the
 * server opened for it (`context.kind === 'automation'`), or undefined (never run, or closed).
 */
export function runTab<S extends Pick<Session, 'id' | 'context'>>(globalSessions: readonly S[] | undefined, automationId: string): S | undefined {
  return (globalSessions ?? []).find((s) => s.context?.kind === 'automation' && s.context.automationId === automationId)
}

/** Run now on an automation whose run tab is still busy with its last run (the desktop's words for that refusal). */
export const RUN_TAB_BUSY = 'The previous run is still working.'

/**
 * What the screen says when `automation.runNow` fails (`err`: what the request threw). The
 * server's CONFLICT, its only one, is a busy run tab ("<name>: previous run still working"; the run
 * is recorded as skipped): RUN_TAB_BUSY. Anything else is the error's own message, as the server
 * worded it.
 */
export function runNowRefusal(err: unknown): string {
  if (!!err && typeof err === 'object' && (err as { code?: unknown }).code === 'CONFLICT') return RUN_TAB_BUSY
  return err instanceof Error ? err.message : String(err)
}

// ── Saving: the name and prompt edit, and On / Off ───────────────────────────────────────────

/**
 * The question before turning an automation off (the confirming alert's title, message and
 * button), or null when there is nothing to ask: the server discards an automation's missed runs
 * when it is turned off, so one that has any asks first. Turning one on never asks.
 */
export function turnOffQuestion(a: Automation): { title: string; message: string; confirm: string } | null {
  if (!a.enabled || !a.missed) return null
  const { count } = a.missed
  return { title: `Turn ${a.name} off?`, message: count === 1 ? 'Its 1 missed run is discarded.' : `Its ${count} missed runs are discarded.`, confirm: 'Turn off' }
}

/**
 * Whether a confirmed turn-off question (`asked`: the automation it was built from) still states
 * what is discarded, against the automation now (`current`): not when more runs were missed while it
 * was up (ask again with the new count). Fewer, or none, discards no more than was stated.
 */
export function turnOffStillMatches(asked: Automation, current: Automation): boolean {
  return (current.missed?.count ?? 0) <= (asked.missed?.count ?? 0)
}

/**
 * `automation.save`'s `automation` for one of the snapshot's, with `changes` over it (the request
 * is `{projectId, automation}`). The server replaces every field it is given and resets the agent
 * to the project's Global one when `llm` is absent or null, so the input always names them all, as
 * they are in the snapshot: a save from the phone cannot change the schedule, the timezone or the
 * agent. It always carries the `id`: an automation deleted meanwhile is the server's NOT_FOUND,
 * never a new one. On / Off is `automationInput(a, { enabled: !a.enabled })`; the server then
 * drops what was missed (off), or counts slots from now (on again).
 */
export function automationInput(a: Automation, changes: { name?: string; prompt?: string; enabled?: boolean } = {}): AutomationInput {
  return {
    id: a.id,
    name: changes.name ?? a.name,
    prompt: changes.prompt ?? a.prompt,
    schedule: { cron: a.schedule.cron, tz: a.schedule.tz },
    enabled: changes.enabled ?? a.enabled,
    llm: a.llm ? { ...a.llm } : null
  }
}

/** An automation's name and prompt being edited. */
export interface AutomationEdit {
  /** What the user typed */
  name: string
  prompt: string
  /** What a Save is measured against: the name and prompt as they were when editing began, or, after a held-back Save, the server's then (the ones shown under AUTOMATION_CHANGED) */
  base: { name: string; prompt: string }
  /** The last Save was held back: the name or prompt changed on the server meanwhile */
  changed: boolean
}

/** Editing begins from the snapshot's automation. */
export function beginAutomationEdit(a: Automation): AutomationEdit {
  return { name: a.name, prompt: a.prompt, base: { name: a.name, prompt: a.prompt }, changed: false }
}

/** Whether Save is offered: a name and a prompt that are not blank (the server trims both and refuses an empty one). */
export function canSaveAutomationEdit(edit: AutomationEdit): boolean {
  return edit.name.trim() !== '' && edit.prompt.trim() !== ''
}

/**
 * A Save of the edit against the snapshot's automation now (`current`; when it is gone the screen
 * says AUTOMATION_GONE instead). `automation.save` has no compare-and-set, so the phone compares:
 *
 * - the snapshot's name and prompt are still the edit's `base`: `{input}`, to send (the typed name
 *   and prompt over everything else as the snapshot has it now);
 * - they differ (changed elsewhere while the box was open): `{edit}`, nothing is sent. The box
 *   stays open with the typed text; the screen shows AUTOMATION_CHANGED with `edit.base.name` and
 *   `edit.base.prompt` (the server's now) below, and the next Save is measured against those, so
 *   it overwrites knowingly.
 */
export function saveAutomationEdit(edit: AutomationEdit, current: Automation): { input: AutomationInput } | { edit: AutomationEdit } {
  if (current.name !== edit.base.name || current.prompt !== edit.base.prompt) {
    return { edit: { name: edit.name, prompt: edit.prompt, base: { name: current.name, prompt: current.prompt }, changed: true } }
  }
  return { input: automationInput(current, { name: edit.name, prompt: edit.prompt }) }
}
