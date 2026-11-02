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
const CHECK_TIMEOUT_MS = 15_000
const FOLDER_MISSING_REASON = "The bot's folder is missing"
/** Failures in a row of one kind of write before the bot pauses, so a brief hiccup is only logged. */
const MAX_WRITE_FAILURES = 3

type WriteKind = 'state' | 'event' | 'journal'

const isUserWake = (wake: Wake): boolean => wake.kind === 'chat' || wake.kind === 'approval'
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const preview = (text: string): string => text.replace(/\s+/g, ' ').slice(0, SUMMARY_CAP)
/** Turns that spent no real work, or that the bot had no part in ending, don't use up the daily cap. */
const UNCOUNTED: ReadonlySet<TurnOutcome['kind']> = new Set<TurnOutcome['kind']>(['limit', 'killed', 'missing', 'auth'])

const pendingText = (id: string): string =>
  `Requested approval ${id}. End your turn; the answer arrives in a later turn.`

export class BotRunner {
  private deps: RunnerDeps
  private state: BotState
  private busy = false
  private stopped = false
  private current: TurnHandle | null = null
  private running: Promise<void> | null = null
  private nextBeatAt: number | null = null
  private folderReported = false
  /** Ends a running change check early, for `stop`. */
  private abortCheck: (() => void) | null = null
  /** `stop` has finished: nothing writes or publishes any more. */
  private closed = false
  private writeFailures: Record<WriteKind, number> = { state: 0, event: 0, journal: 0 }

  constructor(deps: RunnerDeps) {
    this.deps = deps
    this.state = loadState(deps.folder)
  }

  /** Recovers from an interrupted turn, then runs anything still queued. */
  start(): void {
    if (this.stopped) return
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

  /** Final. A turn in progress finishes writing; after this resolves nothing does. */
  async stop(): Promise<void> {
    this.stopped = true
    this.current?.kill()
    this.abortCheck?.()
    await this.idle()
    this.closed = true
  }

  /** Resolves once no change check or turn is running or waiting to start. */
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
    const phase = pauseReason ? 'error' : this.state.activeTurn ? 'working' : paused ? 'paused' : 'idle'
    return {
      phase,
      reason: pauseReason,
      bound: true,
      folderMissing: pauseReason === FOLDER_MISSING_REASON,
      folderInUse: false,
      needsConsent: false,
      command: null,
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
    if (this.stopped) return
    this.event('user', text)
    this.state.queue.push({ kind: 'chat', text })
    this.commit()
    this.drain()
  }

  setPaused(paused: boolean): void {
    if (this.stopped) return
    this.state.paused = paused
    if (!paused) {
      this.state.pauseReason = null
      this.state.failures = 0
      this.state.blockedUntil = 0
      this.state.limited = false
      this.writeFailures = { state: 0, event: 0, journal: 0 }
    }
    this.commit()
    this.drain()
  }

  /** `cwd` is the working directory the hook reports, which an earlier `cd` can change. */
  checkTool(call: ToolCall, cwd?: string): PolicyDecision {
    if (this.stopped || !this.state.activeTurn) return { decision: 'deny', reason: 'No bot turn is running.' }
    if (!existsSync(this.deps.folder)) {
      this.folderLost()
      return { decision: 'deny', reason: `${FOLDER_MISSING_REASON}, so its policy can't be read.` }
    }
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
      const used = `Used approval for ${call.tool} ${JSON.stringify(call.input)}`
      this.journal(used)
      this.event('approval', used)
      this.commit()
    }
    return result
  }

  /** Returns what to tell the bot. */
  requestApproval(tool: string, input: Record<string, unknown>, reason: string): string {
    if (this.stopped) throw new Error('The bot has stopped.')
    const call = { tool, input }
    if (decide(call, { ...this.policyContext(), approvals: [] }).decision === 'deny') {
      throw new Error('This action is in the never tier and cannot be approved.')
    }
    const existing = this.state.approvals.find((a) => approvalMatches(a, call))
    if (existing?.status === 'approved') {
      return `This exact call is already approved (${existing.id}). Run it now, in this turn.`
    }
    if (existing) return pendingText(existing.id)
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
    return pendingText(approval.id)
  }

  decideApproval(id: string, approved: boolean): void {
    if (this.stopped) return
    const approval = this.state.approvals.find((a) => a.id === id && a.status === 'pending')
    if (!approval) return
    const action = `${approval.tool} ${JSON.stringify(approval.input)}`
    if (approved) approval.status = 'approved'
    else this.state.approvals = this.state.approvals.filter((a) => a.id !== id)
    const answer = approved ? 'approved' : 'denied'
    this.event('approval', `User ${answer} ${action}`)
    this.state.queue.push(
      approved
        ? { kind: 'approval', text: action, approvalId: id }
        : { kind: 'approval', text: `The user denied this call. Do not try it another way: ${action}` }
    )
    this.commit()
    this.drain()
  }

  /** One heartbeat. A busy bot skips it; it is never queued. Never rejects. */
  async beat(): Promise<void> {
    try {
      await this.runBeat()
    } catch (err) {
      console.error('Bot heartbeat failed', err)
      if (!this.stopped) this.event('error', `Heartbeat failed: ${errorText(err)}`)
    }
  }

  private async runBeat(): Promise<void> {
    if (this.stopped) return
    const now = this.deps.now()
    if (!existsSync(this.deps.folder)) this.folderLost()
    this.state.lastBeatAt = now
    // A new bot has nothing to reflect on yet.
    this.state.lastReflectionDate ??= localDate(now)
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
    if (this.backingOff(now)) {
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
    if ((this.state.lastReflectionDate as string) < localDate(now)) {
      this.launch({ kind: 'reflection', text: '' })
      await this.idle()
      return
    }

    // The check is async, so it holds the lock: a chat arriving now queues.
    this.busy = true
    this.running = this.changeCheck(now)
    await this.idle()
  }

  /** Never rejects, and always releases the lock. */
  private async changeCheck(now: number): Promise<void> {
    let found: { wake: Wake; trek: TrekSnapshot } | null = null
    try {
      found = await this.heartbeatWake(now)
    } catch (err) {
      if (!this.stopped) this.event('error', `Could not read Trek's state: ${String(err)}`)
    } finally {
      this.busy = false
    }
    if (this.stopped) return
    try {
      // Anything that arrived during the check wins. An unsaved snapshot means the next beat sees the same changes.
      if (found && this.state.queue.length === 0 && !this.state.paused && !this.state.pauseReason) {
        this.launch(found.wake, found.trek)
      } else {
        this.commit()
        this.drain()
      }
    } catch (err) {
      console.error('Bot could not finish a change check', err)
    }
  }

  private async readSnapshot(): Promise<TrekSnapshot> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cutOff = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer after ${CHECK_TIMEOUT_MS / 1000} seconds`)), CHECK_TIMEOUT_MS)
      this.abortCheck = () => reject(new Error('the bot stopped'))
    })
    try {
      return await Promise.race([this.deps.snapshot(), cutOff])
    } finally {
      clearTimeout(timer)
      this.abortCheck = null
    }
  }

  private async heartbeatWake(now: number): Promise<{ wake: Wake; trek: TrekSnapshot } | null> {
    const trek = await this.readSnapshot()
    const heartbeat = readHeartbeat(this.deps.folder)
    const changes = describeChanges(this.state.snapshot, { ...trek, heartbeat })
    const dutyKeys = dueDuties(parseDuties(heartbeat), this.state.dutyRuns, now)
    if (changes.length === 0 && dutyKeys.length === 0) return null
    const lines = [...changes, ...dutyKeys.map((d) => `scheduled duty is due: ${d}`)]
    return { wake: { kind: 'heartbeat', text: lines.map((l) => `- ${l}`).join('\n'), dutyKeys }, trek }
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
    if (this.state.limited || this.backingOff(this.deps.now())) return
    const next = this.state.queue.shift()
    if (next) this.launch(next)
  }

  /** `trek` is what a heartbeat wake was told about, saved if its turn succeeds. */
  private launch(wake: Wake, trek: TrekSnapshot | null = null): void {
    this.busy = true
    this.state.activeTurn = wake
    this.running = this.runWake(wake, trek)
  }

  /** Never rejects, and always releases the lock. */
  private async runWake(wake: Wake, trek: TrekSnapshot | null): Promise<void> {
    // Yields first, so `running` is set before any listener can call `stop` or `idle`.
    await null
    let outcome: TurnOutcome
    let startedAt = 0
    let resumed = false
    try {
      startedAt = this.deps.now()
      this.event('wake', wake.kind === 'chat' ? 'Reading your message' : `Woke for ${wake.kind}`)
      resumed = this.state.sessionId !== null
      outcome = await this.attempt(wake, this.state.sessionId)
      if (outcome.kind === 'resume') {
        this.event('error', 'Could not resume the conversation; starting a new one from memory')
        resumed = false
        outcome = await this.attempt(wake, null)
      }
    } catch (err) {
      outcome = { kind: 'crash', text: errorText(err), sessionStarted: false }
    }
    try {
      this.afterTurn(wake, outcome, { startedAt, resumed, trek })
    } catch (err) {
      console.error('Bot could not finish a turn', err)
    } finally {
      this.current = null
      this.state.activeTurn = null
      this.busy = false
    }
    try {
      this.commit()
      this.drain()
    } catch (err) {
      console.error('Bot could not start the next wake', err)
    }
  }

  private async attempt(wake: Wake, existingSession: string | null): Promise<TurnOutcome> {
    const now = this.deps.now()
    const sessionId = existingSession ?? this.deps.newSessionId()
    this.state.sessionId = sessionId
    this.commit()
    // Anything above can reach a listener, which may pause or stop the bot.
    if (this.stopped || this.state.paused) return { kind: 'killed', text: 'Turn stopped', sessionStarted: false }
    const turnWake = this.wakeForTurn(wake)
    const { systemPrompt, prompt } = buildContext(this.deps.folder, turnWake, now)
    const timeoutMs = readConfig(this.deps.folder).turnTimeoutMinutes * 60_000
    this.current = this.deps.runTurn(
      { wake: turnWake, prompt, systemPrompt, sessionId, resume: existingSession !== null, timeoutMs },
      (event) => this.event(event.kind, event.text)
    )
    this.commit()
    return this.current.done
  }

  /** The approval may have been used since it was queued, by an earlier turn or a failed try of this one. */
  private wakeForTurn(wake: Wake): Wake {
    if (!wake.approvalId) return wake
    const stillThere = this.state.approvals.some((a) => a.id === wake.approvalId)
    return {
      ...wake,
      text: stillThere
        ? `The user approved this exact call, which may now run once: ${wake.text}`
        : `The approval for this call was already used: ${wake.text}. Check whether the action took effect before asking again.`
    }
  }

  private afterTurn(
    wake: Wake,
    outcome: TurnOutcome,
    run: { startedAt: number; resumed: boolean; trek: TrekSnapshot | null }
  ): void {
    // Together and first: nothing below can lose the user's message, and a listener's commit
    // can't save it as both queued and active, which would run it twice after a crash.
    if (outcome.kind !== 'ok' && isUserWake(wake)) this.state.queue.unshift(wake)
    this.state.activeTurn = null
    const now = this.deps.now()
    this.resetDailyCount(now)
    if (!UNCOUNTED.has(outcome.kind)) this.state.turnsToday++
    const summary = preview(outcome.text)
    if (outcome.kind === 'ok') {
      this.state.failures = 0
      this.state.wakeFailures = 0
      this.state.blockedUntil = 0
      for (const key of wake.dutyKeys ?? []) this.state.dutyRuns[key] = now
      if (wake.approvalId) this.deleteApproval(wake.approvalId)
      if (wake.kind === 'reflection') {
        this.state.lastReflectionDate = localDate(run.startedAt)
        this.state.sessionId = null
      }
      this.journal(`${wake.kind} turn: ${summary}`)
      // Trek's state as checked before the turn, so anything that changes during it
      // wakes the next beat. HEARTBEAT.md as of now, so the bot's own edits don't.
      if (wake.kind === 'heartbeat' && run.trek) {
        this.state.snapshot = { ...run.trek, heartbeat: readHeartbeat(this.deps.folder) }
      }
      return
    }

    // A resumed session that crashes may be what is broken, and a fresh one that never reported
    // itself doesn't exist. Either way, the next attempt starts from memory.
    const broken = outcome.kind === 'crash' || outcome.kind === 'timeout'
    if (run.resumed ? broken : !outcome.sessionStarted) this.state.sessionId = null

    this.journal(`${wake.kind} turn ${outcome.kind}: ${summary}`)
    this.event('error', `Turn ${outcome.kind}: ${summary}`)

    if (outcome.kind === 'limit') {
      this.state.limited = true
    } else if (outcome.kind === 'auth' || outcome.kind === 'missing') {
      this.pauseWith(summary)
    } else if (outcome.kind !== 'killed') {
      this.state.failures++
      if (isUserWake(wake)) this.state.wakeFailures++
      if (this.state.wakeFailures > MAX_FAILURES) {
        this.dropPoisonWake()
      } else if (this.state.failures >= MAX_FAILURES || this.state.wakeFailures >= MAX_FAILURES) {
        this.pauseWith(this.failurePause(wake, summary))
        return
      }
      this.state.blockedUntil = now + BACKOFF_MS[Math.min(this.state.failures, BACKOFF_MS.length) - 1]
    }
  }

  private failurePause(wake: Wake, summary: string): string {
    const failed = `${MAX_FAILURES} turns failed in a row.`
    if (!isUserWake(wake)) return `${failed} Last: ${summary}`
    const retry = this.state.wakeFailures >= MAX_FAILURES ? 'retry it once more' : 'retry it'
    return `${failed} Resuming will ${retry}: ${wake.kind} "${preview(wake.text)}". Last: ${summary}`
  }

  /** A failed user wake goes back to the head of the queue, so `wakeFailures` always describes the head. */
  private dropPoisonWake(): void {
    this.state.wakeFailures = 0
    const poison = this.state.queue.shift()
    if (!poison) return
    if (poison.approvalId) this.deleteApproval(poison.approvalId)
    const text = `Dropped ${poison.kind} wake after ${MAX_FAILURES + 1} failed turns: ${preview(poison.text)}`
    this.journal(text)
    this.event('error', text)
  }

  private deleteApproval(id: string): void {
    this.state.approvals = this.state.approvals.filter((a) => a.id !== id)
  }

  /** A block further off than the longest backoff can only come from a clock that has since moved back. */
  private backingOff(now: number): boolean {
    const left = this.state.blockedUntil - now
    return left > 0 && left <= BACKOFF_MS[BACKOFF_MS.length - 1]
  }

  private pauseWith(reason: string): void {
    this.state.paused = true
    // A missing folder explains everything else, so nothing replaces it.
    if (this.state.pauseReason !== FOLDER_MISSING_REASON) this.state.pauseReason = reason
  }

  private resetDailyCount(now: number): void {
    const today = localDate(now)
    // `<`, so a clock moved backwards doesn't reset the count.
    if (this.state.turnsDate === null || this.state.turnsDate < today) {
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
  private store(kind: WriteKind, write: () => void): void {
    if (this.closed) return
    try {
      write()
      this.writeFailures[kind] = 0
    } catch (err) {
      // A long turn would otherwise log every event once the folder is gone, or once the bot has paused over it.
      if (!this.folderReported && !this.state.pauseReason) console.error('Bot could not write to its folder', err)
      if (!existsSync(this.deps.folder)) this.folderLost()
      else if (++this.writeFailures[kind] >= MAX_WRITE_FAILURES) this.writesFailing(err)
    }
  }

  /** Carrying on would look fine until a restart lost everything. Resuming tries again. */
  private writesFailing(err: unknown): void {
    if (this.stopped || this.state.pauseReason) return
    this.pauseWith(`The bot could not write to its folder: ${errorText(err)}`)
    this.publishView()
  }

  private journal(text: string): void {
    this.store('journal', () => appendJournal(this.deps.folder, this.deps.now(), text))
  }

  private event(kind: BotEventKind, text: string): void {
    if (this.closed) return
    try {
      const event = { at: this.deps.now(), kind, text }
      this.store('event', () => appendEvent(this.deps.folder, event))
      this.deps.onEvent(event)
    } catch (err) {
      console.error('Bot could not report an event', err)
    }
  }

  private commit(): void {
    this.store('state', () => saveState(this.deps.folder, this.state))
    this.publishView()
  }

  private publishView(): void {
    if (this.closed) return
    try {
      this.deps.onView(this.view())
    } catch (err) {
      console.error('Bot could not report its view', err)
    }
  }
}
