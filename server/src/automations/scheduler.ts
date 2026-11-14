// The automations' scheduler: every tick (30 s) it reads each project's enabled automations,
// runs the one whose latest slot is on time (at most LATE_MS old) and records the rest as missed
// (a laptop asleep, the server down), for the user to answer in a window. Everything it needs is
// on the project (`lastSlot`, `missed`, `history`), so a restart picks up where it left off and
// its first check reports the downtime. Each automation has one run tab, a Global session with
// `context.automationId` set: a run opens it (none yet, or the user closed it) or renews it as a
// brand-new conversation, the prompt its first message; while the previous run is still busy the
// run is skipped. A failure or a skip is recorded, never retried.
import { readFileSync } from 'node:fs'
import type { Automation, AutomationMissed, AutomationRun, Project, Session, SessionContext } from '../../../src/shared/model/types'
import { formatWall, parseCron, slotSpan } from '../../../src/shared/cron.ts'
import type { LlmSelection } from '../../../src/shared/providers/types'
import { codedError } from '../errors.ts'
import type { ProjectState } from '../projects/state.ts'
import { MAX_TITLE_LENGTH } from '../sessions/limits.ts'

export const AUTOMATION_TICK_MS = 30_000
/**
 * A run tab whose pty a run started this recently is busy: the agent may not have printed yet (a
 * tab is `idle` until it does), and a second run would renew it under the first.
 */
export const STARTING_MS = 10_000
/** A slot this old or less still runs; older, it is missed. */
export const LATE_MS = 2 * 60_000
export const AUTOMATION_HISTORY = 20
const MAX_ERROR = 200
/** A run's Global session's size until a window shows it (a window resizes it). */
const RUN_COLS = 120
const RUN_ROWS = 32

export interface TickUpdate {
  id: string
  lastSlot: number
  /** null: clear it */
  missed: AutomationMissed | null
}

export interface TickPlan {
  updates: TickUpdate[]
  due: { id: string; slot: number }[]
}

/** What one tick does to a project's automations. Pure. */
export function planTick(automations: readonly Automation[], now: number): TickPlan {
  const plan: TickPlan = { updates: [], due: [] }
  for (const a of automations) {
    if (!a.enabled) continue
    let span
    try {
      span = slotSpan(parseCron(a.schedule.cron), a.schedule.tz, a.lastSlot, now)
    } catch {
      continue // saved before a stricter check, or a timezone this machine lacks: leave it be
    }
    if (!span) continue
    if (now - span.last <= LATE_MS) {
      plan.updates.push({ id: a.id, lastSlot: span.last, missed: null })
      plan.due.push({ id: a.id, slot: span.last })
    } else {
      plan.updates.push({ id: a.id, lastSlot: span.last, missed: { since: a.missed?.since ?? span.first, count: (a.missed?.count ?? 0) + span.count } })
    }
  }
  return plan
}

export interface StartGlobal {
  projectId: string
  worktreeId: null
  title: string
  llm?: LlmSelection
  initialMessage: string
  cols: number
  rows: number
}

export interface RenewSession {
  projectId: string
  sessionId: string
  title: string
  /** null: the project's Global agent now */
  llm: LlmSelection | null
  initialMessage: string
  cols: number
  rows: number
}

export interface AutomationSchedulerDeps {
  projects: ProjectState
  sessions: {
    /** `options` is the server's own path: a client's session.start cannot set a context */
    start(p: StartGlobal, options: { context: SessionContext }): { sessionId: string; ptyId: string }
    renew(p: RenewSession): { ptyId: string }
  }
  now?: () => number
  tickMs?: number
  log?: (message: string) => void
}

export class AutomationScheduler {
  readonly now: () => number
  private readonly deps: AutomationSchedulerDeps
  private timer: ReturnType<typeof setInterval> | undefined
  /**
   * automationId → the pty its latest run started and when (the scheduler's clock). In memory only:
   * after a restart no run tab has a live pty of a run.
   */
  private readonly launched = new Map<string, { ptyId: string; at: number }>()

  constructor(deps: AutomationSchedulerDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.check()
    this.timer = setInterval(() => this.check(), this.deps.tickMs ?? AUTOMATION_TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One tick over every project. A project that fails is logged and tried again next tick. */
  check(): void {
    for (const project of [...this.deps.projects.all()]) {
      try {
        this.checkProject(project)
      } catch (err) {
        this.deps.log?.(`automations: project ${project.id}: ${(err as Error).message}`)
      }
    }
  }

  private checkProject(project: Project): void {
    if (!project.automations?.length) return
    const plan = planTick(project.automations, this.now())
    if (plan.updates.length === 0) return
    const byId = new Map(plan.updates.map((u) => [u.id, u]))
    this.deps.projects.apply(project.id, (d) => {
      for (const a of d.automations ?? []) {
        const u = byId.get(a.id)
        if (!u) continue
        a.lastSlot = u.lastSlot
        if (u.missed) a.missed = u.missed
        else delete a.missed
      }
    })
    for (const { id, slot } of plan.due) {
      try {
        this.run(project.id, id, 'schedule', slot)
      } catch (err) {
        this.deps.log?.(`automations: ${project.id}/${id}: ${(err as Error).message}`)
      }
    }
  }

  /**
   * Runs the automation now in its run tab (opened, or renewed) and records it; skips it while the
   * tab is busy. `error`: why it failed (as thrown) or was skipped (CONFLICT).
   */
  run(projectId: string, automationId: string, trigger: AutomationRun['trigger'], slot?: number): { run: AutomationRun; error?: unknown } {
    const project = this.deps.projects.require(projectId)
    const a = project.automations?.find((x) => x.id === automationId)
    if (!a) throw codedError('NOT_FOUND', `No automation with id "${automationId}"`)
    const at = this.now()
    const base = { at, ...(slot !== undefined ? { slot } : {}), trigger }
    const tab = project.globalSessions.find((s) => s.context?.kind === 'automation' && s.context.automationId === automationId)
    const title = runTitle(a, slot ?? at)
    let run: AutomationRun
    let error: unknown
    const recent = this.launched.get(automationId)
    const starting = tab?.ptyId !== undefined && recent?.ptyId === tab.ptyId && at - recent.at < STARTING_MS
    if (tab && (starting || isBusy(tab))) {
      run = { ...base, outcome: 'skipped', error: SKIPPED }
      error = codedError('CONFLICT', `${a.name}: ${SKIPPED}`)
    } else {
      try {
        let sessionId: string
        let ptyId: string
        if (tab) {
          ;({ ptyId } = this.deps.sessions.renew({ projectId, sessionId: tab.id, title, llm: a.llm ?? null, initialMessage: a.prompt, cols: RUN_COLS, rows: RUN_ROWS }))
          sessionId = tab.id
        } else {
          ;({ sessionId, ptyId } = this.deps.sessions.start(
            { projectId, worktreeId: null, title, ...(a.llm ? { llm: a.llm } : {}), initialMessage: a.prompt, cols: RUN_COLS, rows: RUN_ROWS },
            { context: { kind: 'automation', automationId } }
          ))
        }
        this.launched.set(automationId, { ptyId, at })
        run = { ...base, outcome: 'ran', sessionId }
      } catch (err) {
        error = err
        run = { ...base, outcome: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR) }
      }
    }
    this.deps.projects.apply(projectId, (d) => {
      const target = d.automations?.find((x) => x.id === automationId)
      if (target) target.history = [run, ...target.history].slice(0, AUTOMATION_HISTORY)
    })
    return error === undefined ? { run } : { run, error }
  }
}

const SKIPPED = 'previous run still working'

/**
 * A run tab still on the previous run: working, waiting on the user, or with an open decision (a
 * decision left on an exited tab waits on nothing).
 */
function isBusy(s: Session): boolean {
  return s.status === 'working' || s.status === 'attention' || (s.decision !== undefined && s.status !== 'exited')
}

/** "<name> · HH:MM" in the automation's timezone. */
export function runTitle(a: Automation, at: number): string {
  return `${a.name} · ${formatWall(at, a.schedule.tz)}`.slice(0, MAX_TITLE_LENGTH)
}

/**
 * `TREK_SERVER_AUTOMATION_CLOCK_FILE`, for the smokes only: the scheduler's "now" is the number of
 * milliseconds in that file, read each time (Date.now when it can't be read).
 */
export function clockFromFile(file: string | undefined): (() => number) | undefined {
  if (!file) return undefined
  return () => {
    try {
      const n = Number(readFileSync(file, 'utf8').trim())
      return Number.isFinite(n) && n > 0 ? n : Date.now()
    } catch {
      return Date.now()
    }
  }
}
