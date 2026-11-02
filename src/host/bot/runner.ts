import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Approval, BotEventKind, BotView, ToolCall, TrekSnapshot, Wake } from '../../shared/bot'
import { describeChanges } from './changeCheck.ts'
import { dueDuties, parseDuties } from './duties.ts'
import {
  appendEvent, appendJournal, buildContext, loadState, localDate, readConfig, readHeartbeat,
  readPolicy, saveState, type BotState
} from './memory.ts'
import { approvalMatches, decide, type PolicyDecision } from './policy.ts'
import type { TurnHandle, TurnOutcome } from './turnProcess'

export interface TurnRequest {
  wake: Wake
  prompt: string
  systemPrompt: string
  sessionId: string
  resume: boolean
  timeoutMs: number
}

export interface RunnerDeps {
  folder: string
  secretPaths: string[]
  now: () => number
  newSessionId: () => string
  snapshot: () => Promise<TrekSnapshot>
  runTurn: (request: TurnRequest, onEvent: (e: { kind: BotEventKind; text: string }) => void) => TurnHandle
  onView: (view: BotView) => void
  onEvent: (event: { at: number; kind: BotEventKind; text: string }) => void
  /** The bot's folder has gone. Called at most once. */
  onFolderMissing: () => void
}

const BACKOFF_MS = [60_000, 5 * 60_000]
const MAX_FAILURES = 3
const SUMMARY_CAP = 200
const FOLDER_MISSING_REASON = "The bot's folder is missing"

const isUserWake = (wake: Wake): boolean => wake.kind === 'chat' || wake.kind === 'approval'
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class BotRunner {
  private deps: RunnerDeps
  private state: BotState
  private busy = false
  private stopped = false
  private current: TurnHandle | null = null
  private running: Promise<void> | null = null
  private nextBeatAt: number | null = null
  /** What the running heartbeat turn was told about, saved if the turn succeeds. */
  private checkedTrek: TrekSnapshot | null = null
  private folderReported = false

  constructor(deps: RunnerDeps) {
    this.deps = deps
    this.state = loadState(deps.folder)
  }

  /** Recovers from an interrupted turn, then runs anything still queued. */
  start(): void {
    try {
      const interrupted = this.state.activeTurn
      if (interrupted) {
        this.journal(`Turn interrupted by a crash or quit (${interrupted.kind}).`)
        this.event('error', `Previous ${interrupted.kind} turn was interrupted`)
        if (isUserWake(interrupted)) this.state.queue.unshift(interrupted)
        this.state.activeTurn = null
      }
      this.commit()
      this.drain()
    } catch (err) {
      console.error('Bot could not start', err)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.current?.kill()
    await this.idle()
  }

  /** Resolves once no turn is running or waiting to start. */
  async idle(): Promise<void> {
    while (this.running) {
      const running = this.running
      await running
      if (this.running === running) this.running = null
    }
  }

  view(): BotView {
    const { paused, pauseReason, queue, approvals, lastBeatAt } = this.state
    const pending = approvals.filter((a) => a.status === 'pending')
    const phase = pauseReason ? 'error' : paused ? 'paused' : this.current ? 'working' : 'idle'
    return {
      phase,
      reason: pauseReason,
      folderMissing: pauseReason === FOLDER_MISSING_REASON,
      folder: this.deps.folder,
      lastBeatAt,
      nextBeatAt: this.nextBeatAt,
      queued: queue.length,
      approvals: pending,
      decision: pending[0] ? `Bot asks to run ${pending[0].tool}: ${pending[0].reason}` : pauseReason ? `Bot stopped: ${pauseReason}` : null
    }
  }

  setNextBeat(at: number): void {
    this.nextBeatAt = at
    this.publishView()
  }

  send(text: string): void {
    this.event('user', text)
    this.state.queue.push({ kind: 'chat', text })
    this.commit()
    this.drain()
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused
    if (!paused) {
      this.state.pauseReason = null
      this.state.failures = 0
      this.state.blockedUntil = 0
      this.state.limited = false
      this.dropPoisonWake()
    }
    this.commit()
    this.drain()
  }

  /** `cwd` is the working directory the hook reports, which an earlier `cd` can change. */
  checkTool(call: ToolCall, cwd?: string): PolicyDecision {
    let result: PolicyDecision
    try {
      result = decide(call, { ...this.policyContext(), cwd })
    } catch (err) {
      const reason = errorText(err)
      this.event('error', `Denied ${call.tool}: ${reason}`)
      return { decision: 'deny', reason }
    }
    if (result.approvalId) {
      this.state.approvals = this.state.approvals.filter((a) => a.id !== result.approvalId)
      this.commit()
    }
    return result
  }

  requestApproval(tool: string, input: Record<string, unknown>, reason: string): string {
    const call = { tool, input }
    if (decide(call, { ...this.policyContext(), approvals: [] }).decision === 'deny') {
      throw new Error('This action is in the never tier and cannot be approved.')
    }
    const existing = this.state.approvals.find((a) => approvalMatches(a, call))
    if (existing) return existing.id
    const approval: Approval = {
      id: randomUUID(),
      tool,
      input,
      reason,
      requestedAt: this.deps.now(),
      status: 'pending'
    }
    this.state.approvals.push(approval)
    this.event('approval', `Requested ${tool}: ${reason}`)
    this.commit()
    return approval.id
  }

  decideApproval(id: string, approved: boolean): void {
    const approval = this.state.approvals.find((a) => a.id === id && a.status === 'pending')
    if (!approval) return
    const action = `${approval.tool} ${JSON.stringify(approval.input)}`
    if (approved) approval.status = 'approved'
    else this.state.approvals = this.state.approvals.filter((a) => a.id !== id)
    const answer = approved ? 'approved' : 'denied'
    this.event('approval', `User ${answer} ${action}`)
    this.state.queue.push({
      kind: 'approval',
      text: approved
        ? `The user approved this exact call, which may now run once: ${action}`
        : `The user denied this call. Do not try it another way: ${action}`
    })
    this.commit()
    this.drain()
  }

  /** One heartbeat. A busy bot skips it; it is never queued. Never rejects. */
  async beat(): Promise<void> {
    try {
      await this.runBeat()
    } catch (err) {
      console.error('Bot heartbeat failed', err)
      this.event('error', `Heartbeat failed: ${errorText(err)}`)
    }
  }

  private async runBeat(): Promise<void> {
    if (this.stopped) return
    const now = this.deps.now()
    if (!existsSync(this.deps.folder)) this.folderLost()
    this.state.lastBeatAt = now
    if (this.state.paused || this.state.pauseReason) {
      this.commit()
      return
    }
    if (this.busy) {
      this.event('skip', 'Heartbeat skipped: a turn is running')
      this.commit()
      return
    }
    this.state.limited = false
    if (now < this.state.blockedUntil) {
      this.event('skip', 'Heartbeat skipped: backing off after a failure')
      this.commit()
      return
    }
    if (this.state.queue.length > 0) {
      this.commit()
      this.drain()
      await this.idle()
      return
    }
    this.resetDailyCount(now)
    if (this.state.turnsToday >= readConfig(this.deps.folder).dailyTurnCap) {
      this.event('skip', 'Heartbeat skipped: daily turn cap reached')
      this.commit()
      return
    }
    if (this.state.lastReflectionDate !== localDate(now)) {
      this.launch({ kind: 'reflection', text: '' })
      await this.idle()
      return
    }

    // The check is async, so it holds the lock: a chat arriving now queues.
    this.busy = true
    let wake: Wake | null = null
    try {
      wake = await this.heartbeatWake(now)
    } catch (err) {
      this.event('error', `Could not read Trek's state: ${String(err)}`)
    } finally {
      this.busy = false
    }
    if (this.stopped) {
      this.checkedTrek = null
      return
    }
    // Anything that arrived during the check wins. An unsaved snapshot means the next beat sees the same changes.
    if (wake && this.state.queue.length === 0 && !this.state.paused && !this.state.pauseReason) {
      this.launch(wake)
    } else {
      this.checkedTrek = null
      this.commit()
      this.drain()
    }
    await this.idle()
  }

  private async heartbeatWake(now: number): Promise<Wake | null> {
    const trek = await this.deps.snapshot()
    const heartbeat = readHeartbeat(this.deps.folder)
    const changes = describeChanges(this.state.snapshot, { ...trek, heartbeat })
    const dutyKeys = dueDuties(parseDuties(heartbeat), this.state.dutyRuns, now)
    if (changes.length === 0 && dutyKeys.length === 0) return null
    this.checkedTrek = trek
    const lines = [...changes, ...dutyKeys.map((d) => `scheduled duty is due: ${d}`)]
    return { kind: 'heartbeat', text: lines.map((l) => `- ${l}`).join('\n'), dutyKeys }
  }

  /** Throws if POLICY.json can't be used: a broken file must never read as no overrides. */
  private policyContext(): Parameters<typeof decide>[1] {
    let overrides: ReturnType<typeof readPolicy>
    try {
      overrides = readPolicy(this.deps.folder)
    } catch (err) {
      throw new Error(`POLICY.json can't be read and must be fixed before tools can run. ${errorText(err)}`)
    }
    return {
      folder: this.deps.folder,
      secretPaths: this.deps.secretPaths,
      overrides,
      approvals: this.state.approvals
    }
  }

  private drain(): void {
    if (this.busy || this.stopped || this.state.paused || this.state.pauseReason) return
    if (this.state.limited || this.deps.now() < this.state.blockedUntil) return
    const next = this.state.queue.shift()
    if (next) this.launch(next)
  }

  private launch(wake: Wake): void {
    const run = this.runWake(wake)
    this.running = run
  }

  /** Never rejects, and always releases the lock. */
  private async runWake(wake: Wake): Promise<void> {
    this.busy = true
    this.state.activeTurn = wake
    let outcome: TurnOutcome
    try {
      this.resetDailyCount(this.deps.now())
      this.state.turnsToday++
      this.event('wake', wake.kind === 'chat' ? 'Reading your message' : `Woke for ${wake.kind}`)
      outcome = await this.attempt(wake, this.state.sessionId)
      if (outcome.kind === 'resume') {
        this.event('error', 'Could not resume the conversation; starting a new one from memory')
        outcome = await this.attempt(wake, null)
      }
    } catch (err) {
      outcome = { kind: 'crash', text: errorText(err) }
    }
    try {
      this.afterTurn(wake, outcome)
    } catch (err) {
      console.error('Bot could not finish a turn', err)
    } finally {
      this.current = null
      this.state.activeTurn = null
      this.checkedTrek = null
      this.busy = false
    }
    try {
      this.commit()
      this.drain()
    } catch (err) {
      console.error('Bot could not start the next wake', err)
    }
  }

  private attempt(wake: Wake, existingSession: string | null): Promise<TurnOutcome> {
    const now = this.deps.now()
    const sessionId = existingSession ?? this.deps.newSessionId()
    this.state.sessionId = sessionId
    this.commit()
    // The commit can report a missing folder, which may stop this runner.
    if (this.stopped) return Promise.resolve({ kind: 'killed', text: 'Turn stopped' })
    const { systemPrompt, prompt } = buildContext(this.deps.folder, wake, now)
    const timeoutMs = readConfig(this.deps.folder).turnTimeoutMinutes * 60_000
    this.current = this.deps.runTurn(
      { wake, prompt, systemPrompt, sessionId, resume: existingSession !== null, timeoutMs },
      (event) => this.event(event.kind, event.text)
    )
    this.commit()
    return this.current.done
  }

  private afterTurn(wake: Wake, outcome: TurnOutcome): void {
    // First, so nothing below can lose the user's message.
    if (outcome.kind !== 'ok' && isUserWake(wake)) this.state.queue.unshift(wake)
    const now = this.deps.now()
    const summary = outcome.text.replace(/\s+/g, ' ').slice(0, SUMMARY_CAP)
    if (outcome.kind === 'ok') {
      this.state.failures = 0
      this.state.wakeFailures = 0
      this.state.blockedUntil = 0
      for (const key of wake.dutyKeys ?? []) this.state.dutyRuns[key] = now
      if (wake.kind === 'reflection') {
        this.state.lastReflectionDate = localDate(now)
        this.state.sessionId = null
      }
      this.journal(`${wake.kind} turn: ${summary}`)
      // Trek's state as checked before the turn, so anything that changes during it
      // wakes the next beat. HEARTBEAT.md as of now, so the bot's own edits don't.
      if (wake.kind === 'heartbeat' && this.checkedTrek) {
        this.state.snapshot = { ...this.checkedTrek, heartbeat: readHeartbeat(this.deps.folder) }
      }
      return
    }

    this.journal(`${wake.kind} turn ${outcome.kind}: ${summary}`)
    this.event('error', `Turn ${outcome.kind}: ${summary}`)

    if (outcome.kind === 'limit') {
      this.state.limited = true
    } else if (outcome.kind === 'auth' || outcome.kind === 'missing') {
      this.pauseWith(summary)
    } else if (outcome.kind !== 'killed') {
      this.state.failures++
      if (isUserWake(wake)) this.state.wakeFailures++
      if (this.state.failures >= MAX_FAILURES || this.state.wakeFailures >= MAX_FAILURES) {
        this.pauseWith(`${MAX_FAILURES} turns failed in a row. Last: ${summary}`)
      } else {
        this.state.blockedUntil = now + BACKOFF_MS[this.state.failures - 1]
      }
    }
  }

  /** A failed user wake goes back to the head of the queue, so `wakeFailures` always describes the head. */
  private dropPoisonWake(): void {
    if (this.state.wakeFailures < MAX_FAILURES) return
    this.state.wakeFailures = 0
    const poison = this.state.queue.shift()
    if (!poison) return
    const text = `Dropped ${poison.kind} wake after ${MAX_FAILURES} failed turns: ${poison.text.slice(0, SUMMARY_CAP)}`
    this.journal(text)
    this.event('error', text)
  }

  private pauseWith(reason: string): void {
    this.state.paused = true
    this.state.pauseReason = reason
  }

  private resetDailyCount(now: number): void {
    const today = localDate(now)
    if (this.state.turnsDate !== today) {
      this.state.turnsDate = today
      this.state.turnsToday = 0
    }
  }

  /** Pauses with an error rather than recreate the folder, and reports it once. */
  private folderLost(): void {
    this.pauseWith(FOLDER_MISSING_REASON)
    if (this.folderReported) return
    this.folderReported = true
    try {
      this.deps.onFolderMissing()
    } catch (err) {
      console.error('Bot onFolderMissing failed', err)
    }
  }

  /** Runs a write to the bot's folder. Storage can vanish, and that must never stop the bot's callers. */
  private store(write: () => void): void {
    try {
      write()
    } catch (err) {
      // A long turn would otherwise log every event once the folder is gone.
      if (!this.folderReported) console.error('Bot could not write to its folder', err)
      if (!existsSync(this.deps.folder)) this.folderLost()
    }
  }

  private journal(text: string): void {
    this.store(() => appendJournal(this.deps.folder, this.deps.now(), text))
  }

  private event(kind: BotEventKind, text: string): void {
    try {
      const event = { at: this.deps.now(), kind, text }
      this.store(() => appendEvent(this.deps.folder, event))
      this.deps.onEvent(event)
    } catch (err) {
      console.error('Bot could not report an event', err)
    }
  }

  private commit(): void {
    this.store(() => saveState(this.deps.folder, this.state))
    this.publishView()
  }

  private publishView(): void {
    try {
      this.deps.onView(this.view())
    } catch (err) {
      console.error('Bot could not report its view', err)
    }
  }
}
