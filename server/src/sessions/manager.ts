// Agent sessions on the server. Session records live in the projects (through
// ProjectState.apply); their ptys live in a TerminalHost. Every agent command
// line is built here, never by a client.
import { randomUUID } from 'node:crypto'
import { discoverCodexSession } from '../../../src/host/agentService.ts'
import type { AttentionTopic } from '../../../src/shared/model/topics'
import type { Project, Session, SessionStatus, Worktree } from '../../../src/shared/model/types'
import { pickClaimant, pollDelay } from '../../../src/shared/providers/discovery.ts'
import { getProvider, isProviderId } from '../../../src/shared/providers/registry.ts'
import {
  resolveGlobalLlm,
  resolveNewSessionLlm,
  sanitizeLlmSelection,
  sessionLaunch
} from '../../../src/shared/providers/selection.ts'
import type { LlmSelection } from '../../../src/shared/providers/types'
import type { ConfigStore } from '../configStore.ts'
import { codedError } from '../errors.ts'
import { assertNotRepository, findRegistered } from '../projects/model.ts'
import type { ProjectState } from '../projects/state.ts'
import { realOrResolved as real } from '../repos.ts'
import type { TopicHub } from '../topicHub.ts'
import { checkExpected, isRecord, requireBoolean, requireName, requireString } from '../validate.ts'
import type { McpAccess } from '../../../src/shared/providers/types'
import { agentCommand, sessionEnv, shellLaunch } from './launch.ts'
import { MAX_COLS, MAX_PTY_WRITE, MAX_QUEUE_ENTRY, MAX_QUEUE_LENGTH, MAX_ROWS, MAX_SESSIONS_PER_PROJECT, checkQuestion, checkQueue, checkTitle } from './limits.ts'
import { findSession, findWorktree, sessionList } from './locate.ts'
import {
  IDLE_MS,
  attentionEntries,
  isTerminalReply,
  newActivity,
  onBell,
  onInput,
  onOutput,
  onQuiet,
  type Activity
} from './status.ts'
import { TerminalHost, type PtySpawner } from './terminalHost.ts'

export const LOAD_COLS = 120
export const LOAD_ROWS = 32

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

export interface ScheduledJob {
  cancel(): void
}

export interface SessionManagerDeps {
  projects: ProjectState
  store: ConfigStore
  /** Where the `attention` topic is published; without it the topic is not published */
  hub?: TopicHub
  spawner?: PtySpawner
  discover?: (cwd: string, ageMs: number, exclude: string[]) => Promise<string | undefined>
  schedule?: (fn: () => void | Promise<void>, ms: number) => ScheduledJob
  newId?: () => string
  now?: () => number
  /** The MCP access a project's sessions launch with; without it sessions launch without MCP */
  mcpAccess?: (projectId: string) => McpAccess | undefined
}

function requireSize(p: any): { cols: number; rows: number } {
  const ok = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max
  if (!ok(p.cols, MAX_COLS) || !ok(p.rows, MAX_ROWS)) throw bad('cols must be 1–500 and rows 1–200')
  return { cols: p.cols, rows: p.rows }
}

/** A Codex session whose id is not found yet. */
interface PendingDiscovery {
  projectId: string
  sessionId: string
  /** Unset for a Global session */
  repoId?: string
  cwd: string
  /** realOrResolved(cwd): sessions in one folder are discovered one at a time */
  folder: string
  startedAt: number
}

/** A folder's poll loop; `job` is the timer for its next poll. */
interface FolderLoop {
  job: ScheduledJob
}

interface Owner {
  projectId: string
  sessionId: string
  /** Unset for a Global session */
  repoId?: string
}

export class SessionManager {
  readonly terminals: TerminalHost
  private readonly deps: SessionManagerDeps
  private readonly newId: () => string
  private readonly now: () => number
  private readonly discover: NonNullable<SessionManagerDeps['discover']>
  private readonly schedule: NonNullable<SessionManagerDeps['schedule']>
  /** ptyId → the session it runs */
  private readonly owners = new Map<string, Owner>()
  /** sessionId → its pending Codex discovery */
  private readonly pending = new Map<string, PendingDiscovery>()
  /** folder → its poll loop, while it has pending sessions */
  private readonly loops = new Map<string, FolderLoop>()
  /** realpath → how many worktree.remove calls are working on it */
  private readonly blocked = new Map<string, number>()
  /** sessionId → live activity (marker scan) and its quiet timer */
  private readonly activity = new Map<string, { activity: Activity; quiet?: ScheduledJob }>()
  /** Sessions whose current pty run has printed live output */
  private readonly outputSeen = new Set<string>()
  /** sessionId → when it entered attention or done */
  private readonly since = new Map<string, number>()
  private stopped = false

  constructor(deps: SessionManagerDeps) {
    this.deps = deps
    this.newId = deps.newId ?? randomUUID
    this.now = deps.now ?? Date.now
    this.discover = deps.discover ?? discoverCodexSession
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(() => void fn(), ms)
        timer.unref()
        return { cancel: () => clearTimeout(timer) }
      })
    this.terminals = new TerminalHost({
      spawner: deps.spawner,
      onExit: (ptyId, code) => this.onExit(ptyId, code),
      onOutput: (ptyId, data) => this.onPtyOutput(ptyId, data),
      onBell: (ptyId) => this.onPtyBell(ptyId)
    })
    this.publishAttention()
  }

  /**
   * While the returned function is not called, start/load on `path` are IN_USE.
   * Blocks on one path nest; each returned function releases its own block once.
   */
  blockPath(path: string): () => void {
    const key = real(path)
    this.blocked.set(key, (this.blocked.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.blocked.get(key) ?? 1) - 1
      if (count > 0) this.blocked.set(key, count)
      else this.blocked.delete(key)
    }
  }

  start(p: any): { sessionId: string; ptyId: string } {
    this.assertRunning()
    const { cols, rows } = requireSize(p)
    const project = this.deps.projects.require(p.projectId)
    const global = p.worktreeId === null
    const worktree = global ? undefined : this.usableWorktree(project, p.worktreeId)
    if (global && project.repositories.length === 0) throw bad('the project has no repositories')
    const settings = project.settings
    let sessionType
    if (p.sessionTypeId !== undefined) {
      const id = requireString(p.sessionTypeId, 'sessionTypeId')
      sessionType = settings.sessionTypes?.find((t) => t.id === id)
      if (!sessionType) throw bad(`No session type with id "${id}"`)
    }
    let pick: LlmSelection | undefined
    if (p.llm !== undefined) {
      // sanitizeLlmSelection turns an unknown provider into Claude: refuse it instead.
      if (!isRecord(p.llm) || !isProviderId(p.llm.provider)) throw bad('llm.provider must be a known provider')
      pick = sanitizeLlmSelection(p.llm)
      if (!pick) throw bad('llm must be an LLM selection')
    }
    const serverDefault = this.deps.store.llmSettings().llmDefault
    const llm = global
      ? pick ?? resolveGlobalLlm(settings.globalLlm, settings.llmDefault ?? serverDefault)
      : resolveNewSessionLlm({ pick, sessionType: sessionType?.llm, projectDefault: settings.llmDefault, appDefault: serverDefault })
    if (p.title !== undefined && typeof p.title !== 'string') throw bad('title must be a string')
    const title = p.title?.trim() ? checkTitle(p.title.trim(), 'title') : undefined
    const typeTitle = sessionType?.name ? checkTitle(sessionType.name, `session type "${sessionType.id}" name`) : undefined
    if (p.initialMessage !== undefined && typeof p.initialMessage !== 'string') throw bad('initialMessage must be a string')

    // Before the lazy load: at the cap, loading would only mark the worktree's sessions exited -1.
    this.assertCapacity()
    const records = project.globalSessions.length + project.repositories.reduce((n, r) => n + r.worktrees.reduce((m, w) => m + w.sessions.length, 0), 0)
    if (records >= MAX_SESSIONS_PER_PROJECT) throw codedError('CAPACITY', `a project holds at most ${MAX_SESSIONS_PER_PROJECT} sessions; close some first`)
    if (worktree && !worktree.loaded) this.loadWorktree({ projectId: project.id, worktreeId: worktree.id })

    // Loading replaced the project snapshot: count the sessions in the current one.
    const current = this.deps.projects.require(project.id)
    const list = worktree ? findWorktree(current, worktree.id).worktree.sessions : current.globalSessions
    const provider = getProvider(llm.provider)
    const sessionId = this.newId()
    const session: Session = {
      id: sessionId,
      title: title || typeTitle || this.defaultTitle(provider.label, list.length, worktree),
      llm,
      queue: [],
      status: 'idle'
    }
    if (provider.capabilities.presetSessionId) session.agentSessionId = sessionId
    if (sessionType) session.sessionTypeId = sessionType.id
    const systemPrompt = sessionType?.systemPrompt?.trim()
    if (systemPrompt) session.systemPrompt = systemPrompt

    this.deps.projects.apply(project.id, (d) => {
      if (worktree) findWorktree(d, worktree.id).worktree.sessions.push(session)
      else d.globalSessions.push(session)
    })
    let ptyId: string
    try {
      ptyId = this.spawnSession(project.id, sessionId, {
        cols,
        rows,
        fresh: true,
        initialMessage: p.initialMessage ?? sessionType?.initialMessage
      })
    } catch (err) {
      // The agent never ran: a record left behind would resume a session that does not exist.
      this.removeSession(project.id, sessionId)
      throw err
    }
    return { sessionId, ptyId }
  }

  restart(p: any): { ptyId: string } {
    this.assertRunning()
    const { cols, rows } = requireSize(p)
    const project = this.deps.projects.require(p.projectId)
    const found = findSession(project, p.sessionId)
    if (found.session.ptyId && this.terminals.has(found.session.ptyId)) throw bad('the session is running')
    if (found.worktree) {
      this.usableWorktree(project, found.worktree.id)
      if (!found.worktree.loaded) throw bad('load the worktree first')
    }
    return { ptyId: this.spawnSession(project.id, found.session.id, { cols, rows }) }
  }

  close(p: any): null {
    const project = this.deps.projects.require(p.projectId)
    const found = findSession(project, p.sessionId)
    this.stopDiscovery(found.session.id)
    this.killSession(found.session)
    this.removeSession(project.id, found.session.id)
    this.since.delete(found.session.id)
    this.publishAttention()
    return null
  }

  markComplete(p: any): null {
    const complete = requireBoolean(p.complete, 'complete')
    this.mutate(p.projectId, p.sessionId, (s) => {
      if (complete) s.status = 'complete'
      else if (s.status === 'complete') s.status = 'idle'
    })
    this.syncSince(p.projectId, p.sessionId)
    this.publishAttention()
    return null
  }

  rename(p: any): null {
    const title = checkTitle(requireName(p.title, 'title'), 'title')
    this.mutate(p.projectId, p.sessionId, (s) => {
      checkExpected('title', s.title, p.expected)
      s.title = title
    })
    this.publishAttention()
    return null
  }

  enqueue(p: any): null {
    const text = requireString(p.text, 'text')
    if (text === '') throw bad('text must not be empty')
    if (text.length > MAX_QUEUE_ENTRY) throw bad(`text must be at most ${MAX_QUEUE_ENTRY} characters`)
    this.mutate(p.projectId, p.sessionId, (s) => {
      if (s.queue.length >= MAX_QUEUE_LENGTH) throw bad(`the queue is full (${MAX_QUEUE_LENGTH} prompts)`)
      s.queue = [...s.queue, text]
    })
    return null
  }

  setQueue(p: any): null {
    const queue = checkQueue(p.queue, 'queue')
    this.mutate(p.projectId, p.sessionId, (s) => { s.queue = queue })
    return null
  }

  /**
   * Removes the queued prompt at `index`. With `expected` (the prompt the client
   * saw there) it is compare-and-set: CONFLICT if that prompt changed or the queue
   * no longer reaches `index`. Without it, an index past the end is BAD_REQUEST.
   */
  dequeue(p: any): null {
    const index = p.index
    if (!Number.isInteger(index) || index < 0) throw bad('index must be a non-negative integer')
    if (p.expected !== undefined && typeof p.expected !== 'string') throw bad('expected must be a string')
    this.mutate(p.projectId, p.sessionId, (s) => {
      if (index >= s.queue.length) {
        if (p.expected !== undefined) throw codedError('CONFLICT', 'the queue changed since you read it')
        throw bad(s.queue.length ? `index must be 0–${s.queue.length - 1}` : 'the queue is empty')
      }
      checkExpected(`queue[${index}]`, s.queue[index], p.expected)
      s.queue = s.queue.filter((_, i) => i !== index)
    })
    return null
  }

  /** Types `text` into the running session as the desktop pastes it, then presses enter. */
  async sendPrompt(p: any): Promise<null> {
    const text = requireString(p.text, 'text')
    if (text.length > MAX_PTY_WRITE) throw bad(`text must be at most ${MAX_PTY_WRITE} characters`)
    const { session } = findSession(this.deps.projects.require(p.projectId), p.sessionId)
    const ptyId = session.ptyId
    if (!ptyId || !this.terminals.has(ptyId)) throw bad('the session is not running')
    await this.terminals.settled(ptyId)
    if (!this.terminals.has(ptyId)) throw bad('the session is not running')
    const normalized = text.replace(/\r?\n/g, '\r')
    this.terminals.write(ptyId, this.terminals.bracketedPaste(ptyId) ? `\x1b[200~${normalized}\x1b[201~` : normalized)
    // A prompt is the user acting, whatever its bytes are: no terminal-reply filter.
    this.onUserInput(ptyId)
    setTimeout(() => {
      if (this.terminals.has(ptyId)) this.terminals.write(ptyId, '\r')
    }, 150).unref()
    return null
  }

  /** A client showed the session to the user. */
  seen(p: any): null {
    this.mutate(
      p.projectId,
      p.sessionId,
      (s) => {
        if (s.status === 'attention' || s.status === 'done') s.status = 'idle'
      },
      false
    )
    this.syncSince(p.projectId, p.sessionId)
    this.publishAttention()
    return null
  }

  /**
   * The session's agent asks the user to decide something (MCP request_decision).
   * A newer request replaces an open one. Runtime only, like the status.
   */
  requestDecision(p: any): null {
    const question = checkQuestion(p.question, 'question')
    this.mutate(p.projectId, p.sessionId, (s) => { s.decision = { question, at: this.now() } }, false)
    this.publishAttention()
    return null
  }

  /** A client dismissed the session's decision without answering it in the terminal. */
  dismissDecision(p: any): null {
    this.mutate(p.projectId, p.sessionId, (s) => { delete s.decision }, false)
    this.publishAttention()
    return null
  }

  /** A client typed into the pty (pty.write). Terminal auto-replies are not input. */
  noteInput(ptyId: string, data: string): void {
    if (isTerminalReply(data)) return
    this.onUserInput(ptyId)
  }

  /** Keys sent to the session by a tool (MCP send_keys): always the user acting, as a prompt is. */
  noteUserInput(sessionId: string): void {
    for (const [ptyId, owner] of this.owners) {
      if (owner.sessionId === sessionId) this.onUserInput(ptyId)
    }
  }

  /** True once the session's current run has produced live output (cleared when its pty ends). */
  hasOutput(sessionId: string): boolean {
    return this.outputSeen.has(sessionId)
  }

  loadWorktree(p: any): null {
    this.assertRunning()
    const project = this.deps.projects.require(p.projectId)
    const worktree = this.usableWorktree(project, p.worktreeId)
    if (worktree.loaded) return null
    this.deps.projects.apply(project.id, (d) => { findWorktree(d, worktree.id).worktree.loaded = true }, { persist: false })
    // spawnSession re-reads each session from the current project; only the ids come from this snapshot.
    for (const session of worktree.sessions) {
      if (session.ptyId && this.terminals.has(session.ptyId)) continue
      try {
        this.spawnSession(project.id, session.id, { cols: LOAD_COLS, rows: LOAD_ROWS })
      } catch (err) {
        // The worktree still counts as loaded: this session shows as exited and can be restarted.
        console.error(`could not resume session ${session.id} in ${worktree.path}`, err)
        try {
          this.mutate(project.id, session.id, (s) => {
            delete s.ptyId
            s.status = 'exited'
            s.exitCode = -1
          }, false)
        } catch {
          // the session is gone
        }
      }
    }
    return null
  }

  unloadWorktree(p: any): null {
    const project = this.deps.projects.require(p.projectId)
    const { worktree } = findWorktree(project, p.worktreeId)
    for (const session of worktree.sessions) {
      this.stopDiscovery(session.id)
      this.killSession(session)
    }
    this.deps.projects.apply(
      project.id,
      (d) => {
        const target = findWorktree(d, worktree.id).worktree
        target.loaded = false
        for (const s of target.sessions) {
          delete s.ptyId
          delete s.exitCode
          // The agent that asked is gone; its question would outlive it.
          delete s.decision
          if (s.status !== 'complete') s.status = 'idle'
        }
      },
      { persist: false }
    )
    this.publishAttention()
    return null
  }

  /**
   * The project is being deleted: stop discovery and kill the pty of each of its
   * sessions, Global ones included. Their exits are not recorded.
   */
  forgetProject(projectId: string): void {
    this.forget((o) => o.projectId === projectId)
    this.publishAttention()
  }

  /** A repository is leaving the project: as forgetProject, for that repository's sessions only. */
  forgetRepo(projectId: string, repoId: string): void {
    this.forget((o) => o.projectId === projectId && o.repoId === repoId)
    this.publishAttention()
  }

  /**
   * The project's repositories changed so that its Global sessions run with a stale
   * working directory or additional directories: kill their ptys and stop their
   * discovery. The records stay, `idle`, and restart with the current repositories.
   */
  forgetGlobal(projectId: string): void {
    this.forget((o) => o.projectId === projectId && o.repoId === undefined)
    try {
      this.deps.projects.apply(
        projectId,
        (d) => {
          for (const s of d.globalSessions) {
            delete s.ptyId
            delete s.exitCode
            delete s.decision
            if (s.status !== 'complete') s.status = 'idle'
          }
        },
        { persist: false }
      )
    } catch {
      // the project is gone
    }
    this.publishAttention()
  }

  /** Server shutdown: kill every pty; their exits are ignored. */
  stopAll(): void {
    this.stopped = true
    for (const loop of this.loops.values()) loop.job.cancel()
    this.loops.clear()
    this.pending.clear()
    for (const entry of this.activity.values()) entry.quiet?.cancel()
    this.activity.clear()
    this.outputSeen.clear()
    this.since.clear()
    this.terminals.disposeAll()
  }

  // ---- internals ----

  private assertRunning(): void {
    if (this.stopped) throw codedError('INTERNAL', 'the server is shutting down')
  }

  /**
   * Refuses a new session pty at the cap. It counts the host's records, so a pty
   * killed but still running (up to the kill timeout) holds its slot.
   */
  private assertCapacity(): void {
    const max = this.deps.store.maxSessions()
    if (this.terminals.count() >= max) throw codedError('CAPACITY', `the server is running its maximum of ${max} sessions`)
  }

  /** Works from the manager's own maps, not the records, so it can run after the records are gone. */
  private forget(match: (o: Owner) => boolean): void {
    for (const entry of [...this.pending.values()]) {
      if (match(entry)) this.stopDiscovery(entry.sessionId)
    }
    for (const [ptyId, owner] of [...this.owners]) {
      if (!match(owner)) continue
      this.owners.delete(ptyId)
      this.dropActivity(owner.sessionId)
      if (this.terminals.has(ptyId)) this.terminals.kill(ptyId)
    }
  }

  /**
   * A worktree a session may run in: present, inside the allowlist, a registered repo
   * if it is a main worktree and not one if it is linked, not being removed.
   */
  private usableWorktree(project: Project, worktreeId: unknown): Worktree {
    const { worktree } = findWorktree(project, worktreeId)
    if (worktree.missing) throw bad(`${worktree.path} no longer exists`)
    this.deps.store.guard.check(worktree.path)
    if (worktree.isMain) findRegistered(this.deps.store.config.repos, worktree.path)
    else assertNotRepository(this.deps.store.config.repos, real(worktree.path), 'worktree')
    if (this.blocked.has(real(worktree.path))) throw codedError('IN_USE', `${worktree.path} is being removed`)
    return worktree
  }

  private defaultTitle(label: string, existing: number, worktree: Worktree | undefined): string {
    if (existing > 0) return `${label} ${existing + 1}`
    return worktree ? worktree.name : label
  }

  private removeSession(projectId: string, sessionId: string): void {
    this.deps.projects.apply(projectId, (d) => {
      const list = sessionList(d, findSession(d, sessionId))
      list.splice(list.findIndex((s) => s.id === sessionId), 1)
    })
  }

  /** Spawns (or resumes) the session's agent and records its pty. Returns the new ptyId. */
  private spawnSession(
    projectId: string,
    sessionId: string,
    run: { cols: number; rows: number; fresh?: boolean; initialMessage?: string }
  ): string {
    this.assertCapacity()
    const project = this.deps.projects.require(projectId)
    const { session, worktree, repo } = findSession(project, sessionId)
    const provider = getProvider(session.llm.provider)
    // A new session's preset id names a conversation the agent has not created yet: start it, don't resume it.
    const launch = run.fresh
      ? { sessionId: session.agentSessionId ?? this.newId(), resume: false }
      : sessionLaunch(provider.capabilities, session.agentSessionId, this.newId)
    let cwd: string
    let addDirs: string[] | undefined
    if (worktree) {
      cwd = worktree.path
    } else {
      // A Global session runs in the first repository's main worktree: check it as usableWorktree does.
      const first = project.repositories[0]
      if (!first) throw bad('the project has no repositories')
      const main = first.worktrees.find((w) => w.isMain) ?? first.worktrees[0]
      if (main?.missing) throw bad(`${main.path} no longer exists`)
      cwd = main?.path ?? first.path
      findRegistered(this.deps.store.config.repos, first.path)
      this.deps.store.guard.check(cwd)
      if (this.blocked.has(real(cwd))) throw codedError('IN_USE', `${cwd} is being removed`)
      addDirs = project.repositories.slice(1).map((r) => r.path)
      for (const dir of addDirs) this.deps.store.guard.check(dir)
    }
    let mcp: McpAccess | undefined
    try {
      mcp = this.deps.mcpAccess?.(projectId)
    } catch (err) {
      console.error(`MCP access for project ${projectId} unavailable; launching session ${sessionId} without it`, err)
    }
    const spec = agentCommand(
      {
        mcp,
        llm: session.llm,
        sessionId: launch.sessionId,
        resume: launch.resume,
        global: !worktree,
        systemPrompt: session.systemPrompt,
        initialMessage: launch.resume ? undefined : run.initialMessage,
        addDirs
      },
      project.settings,
      this.deps.store.llmSettings()
    )
    const ptyId = this.newId()
    this.terminals.spawn(ptyId, {
      ...shellLaunch(spec.command),
      cwd,
      env: sessionEnv(session.id, worktree ? { id: worktree.id, path: worktree.path } : undefined, spec.env ?? {}),
      cols: run.cols,
      rows: run.rows
    })
    this.owners.set(ptyId, { projectId, sessionId, repoId: repo?.id })
    // A preset-id agent whose saved id was unusable got a fresh one: that must reach disk.
    const idChanged = provider.capabilities.presetSessionId && session.agentSessionId !== launch.sessionId
    try {
      this.deps.projects.apply(
        projectId,
        (d) => {
          const s = findSession(d, sessionId).session
          s.ptyId = ptyId
          delete s.exitCode
          if (s.status === 'exited') s.status = 'idle'
          if (provider.capabilities.presetSessionId) s.agentSessionId = launch.sessionId
        },
        { persist: idChanged }
      )
    } catch (err) {
      // No record points at the new pty: nothing could ever reach or kill it.
      this.owners.delete(ptyId)
      this.dropActivity(sessionId)
      this.terminals.kill(ptyId)
      throw err
    }
    if (!provider.capabilities.presetSessionId && provider.capabilities.resume && !launch.resume) {
      this.startDiscovery({ projectId, sessionId, repoId: repo?.id, cwd, folder: real(cwd), startedAt: this.now() })
    }
    return ptyId
  }

  private killSession(session: Session): void {
    if (!session.ptyId) return
    this.owners.delete(session.ptyId)
    this.dropActivity(session.id)
    if (this.terminals.has(session.ptyId)) this.terminals.kill(session.ptyId)
  }

  private onExit(ptyId: string, exitCode: number): void {
    const owner = this.owners.get(ptyId)
    this.owners.delete(ptyId)
    if (!owner || this.stopped) return
    this.dropActivity(owner.sessionId)
    // A Codex session that exited before its id was found is never bound (pickClaimant's rule).
    this.stopDiscovery(owner.sessionId)
    try {
      this.deps.projects.apply(
        owner.projectId,
        (d) => {
          const s = findSession(d, owner.sessionId).session
          if (s.ptyId !== ptyId) return
          delete s.ptyId
          s.status = 'exited'
          s.exitCode = exitCode
        },
        { persist: false }
      )
    } catch {
      // the project or session is gone
    }
    this.publishAttention()
  }

  // ---- live status ----

  private onPtyOutput(ptyId: string, data: string): void {
    if (this.stopped) return
    const owner = this.owners.get(ptyId)
    const session = owner && this.sessionOf(owner)
    if (!owner || !session) return
    this.outputSeen.add(owner.sessionId)
    const markers = getProvider(session.llm.provider).statusMarkers
    const entry = this.activity.get(owner.sessionId) ?? { activity: newActivity() }
    const r = onOutput(session.status, entry.activity, data, markers)
    entry.activity = r.activity
    this.activity.set(owner.sessionId, entry)
    if (r.restartTimer) this.armQuiet(ptyId, entry)
    if (r.status !== session.status) this.setStatus(owner, r.status)
  }

  /** Cancels the session's pending quiet timer and schedules a new one IDLE_MS out. */
  private armQuiet(ptyId: string, entry: { activity: Activity; quiet?: ScheduledJob }): void {
    entry.quiet?.cancel()
    entry.quiet = this.schedule(() => this.onQuietTimer(ptyId, entry), IDLE_MS)
  }

  /**
   * The user typed or sent a prompt: it answers an open decision. Leaving attention or
   * complete for working arms the quiet timer as output does, so an agent that prints
   * nothing still settles.
   */
  private onUserInput(ptyId: string): void {
    if (this.stopped) return
    const owner = this.owners.get(ptyId)
    const session = owner && this.sessionOf(owner)
    if (!owner || !session) return
    const status = onInput(session.status)
    const answered = session.decision !== undefined
    if (status === session.status && !answered) return
    if (status !== session.status && status === 'working') {
      const entry = this.activity.get(owner.sessionId) ?? { activity: newActivity() }
      this.activity.set(owner.sessionId, entry)
      this.armQuiet(ptyId, entry)
    }
    this.setStatus(owner, status, answered)
  }

  private onQuietTimer(ptyId: string, entry: { activity: Activity; quiet?: ScheduledJob }): void {
    if (this.stopped) return
    const owner = this.owners.get(ptyId)
    // A timer whose session was dropped (and maybe tracked again since) does nothing.
    if (!owner || this.activity.get(owner.sessionId) !== entry) return
    entry.quiet = undefined
    const session = this.sessionOf(owner)
    if (!session) return
    const r = onQuiet(session.status, entry.activity)
    entry.activity = r.activity
    if (r.status !== session.status) this.setStatus(owner, r.status)
  }

  private onPtyBell(ptyId: string): void {
    if (this.stopped) return
    const owner = this.owners.get(ptyId)
    const session = owner && this.sessionOf(owner)
    if (!owner || !session) return
    const status = onBell(session.status)
    if (status !== session.status) this.setStatus(owner, status)
  }

  /** The session's current record, or undefined if it (or its project) is gone. */
  private sessionOf(owner: Owner): Session | undefined {
    try {
      return findSession(this.deps.projects.require(owner.projectId), owner.sessionId).session
    } catch {
      return undefined
    }
  }

  /**
   * A runtime-only status change (never saved), and with `clearDecision` the
   * session's decision cleared in the same patch, then the attention topic.
   * `since` moves only when the status does.
   */
  private setStatus(owner: Owner, status: SessionStatus, clearDecision = false): void {
    let changed = false
    try {
      this.deps.projects.apply(
        owner.projectId,
        (d) => {
          const s = findSession(d, owner.sessionId).session
          changed = s.status !== status
          s.status = status
          if (clearDecision) delete s.decision
        },
        { persist: false }
      )
    } catch {
      return
    }
    if (changed) {
      if (status === 'attention' || status === 'done') this.since.set(owner.sessionId, this.now())
      else this.since.delete(owner.sessionId)
    }
    this.publishAttention()
  }

  /** After a client changed a session's status: a session no longer in attention or done has no `since`. */
  private syncSince(projectId: unknown, sessionId: unknown): void {
    try {
      const { session } = findSession(this.deps.projects.require(projectId), sessionId)
      if (session.status !== 'attention' && session.status !== 'done') this.since.delete(session.id)
    } catch {
      // the session is gone
    }
  }

  /** The session's pty ended or was dropped: forget its activity, output flag, quiet timer and `since`. */
  private dropActivity(sessionId: string): void {
    this.activity.get(sessionId)?.quiet?.cancel()
    this.activity.delete(sessionId)
    this.outputSeen.delete(sessionId)
    this.since.delete(sessionId)
  }

  /** Republishes the `attention` topic (a no-op when nothing changed). */
  private publishAttention(): void {
    if (!this.deps.hub) return
    const topic: AttentionTopic = { entries: attentionEntries(this.deps.projects.all(), this.since, this.now) }
    this.deps.hub.publish('attention', topic)
  }

  private mutate(projectId: unknown, sessionId: unknown, fn: (s: Session) => void, persist = true): void {
    this.deps.projects.apply(projectId, (d) => fn(findSession(d, sessionId).session), { persist })
  }

  /**
   * Discovery runs one poll loop per folder. Each poll scans for the oldest-started
   * pending session there (pickClaimant), so two Codex sessions started together in
   * one folder bind their rollouts in launch order instead of racing for the same one.
   */
  private startDiscovery(entry: PendingDiscovery): void {
    this.stopDiscovery(entry.sessionId)
    this.pending.set(entry.sessionId, entry)
    if (!this.loops.has(entry.folder)) this.scheduleLoop(entry.folder)
  }

  private stopDiscovery(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (!entry) return
    this.pending.delete(sessionId)
    if (this.inFolder(entry.folder).length > 0) return
    this.loops.get(entry.folder)?.job.cancel()
    this.loops.delete(entry.folder)
  }

  private inFolder(folder: string): PendingDiscovery[] {
    return [...this.pending.values()].filter((e) => e.folder === folder)
  }

  private claimant(folder: string): PendingDiscovery | undefined {
    const tabs = this.inFolder(folder).map((entry) => ({
      id: entry.sessionId,
      status: 'idle',
      sessionPending: true,
      startedAt: entry.startedAt,
      entry
    }))
    return pickClaimant(tabs)?.entry
  }

  /** Schedules the folder's next poll, timed by its claimant's age; ends the loop when none is pending. */
  private scheduleLoop(folder: string): void {
    const claimant = this.claimant(folder)
    if (!claimant) {
      this.loops.delete(folder)
      return
    }
    const loop: FolderLoop = { job: { cancel: () => {} } }
    this.loops.set(folder, loop)
    loop.job = this.schedule(() => this.poll(folder, loop), pollDelay(this.now() - claimant.startedAt))
  }

  /** Every agent id held by a session on this server. */
  private claimedIds(): Set<string> {
    const ids = new Set<string>()
    for (const p of this.deps.projects.all()) {
      for (const s of [...p.globalSessions, ...p.repositories.flatMap((r) => r.worktrees.flatMap((w) => w.sessions))]) {
        if (s.agentSessionId) ids.add(s.agentSessionId)
      }
    }
    return ids
  }

  /** Whether the session's record still exists and still waits for an id. */
  private stillPending(entry: PendingDiscovery): boolean {
    try {
      const project = this.deps.projects.require(entry.projectId)
      return !findSession(project, entry.sessionId).session.agentSessionId
    } catch {
      return false
    }
  }

  private async poll(folder: string, loop: FolderLoop): Promise<void> {
    // Identity check: a loop that was cancelled (or replaced) while its poll was due or awaiting
    // must neither apply a result nor schedule another poll.
    const current = (): boolean => !this.stopped && this.loops.get(folder) === loop
    if (!current()) return
    // A record removed without close (its repo or project went away) stops its discovery.
    for (const entry of this.inFolder(folder)) {
      if (!this.stillPending(entry)) this.pending.delete(entry.sessionId)
    }
    const claimant = this.claimant(folder)
    if (!claimant) {
      this.loops.delete(folder)
      return
    }
    let found: string | undefined
    try {
      found = await this.discover(claimant.cwd, this.now() - claimant.startedAt, [...this.claimedIds()])
    } catch (err) {
      console.warn(`codex session discovery in ${claimant.cwd} failed`, err)
    }
    if (!current()) return
    // A throw below must not end the loop: the folder's other sessions still wait for ids.
    try {
      // Re-check after the await: the claimant may have been closed or restarted, and another
      // session may have taken the id meanwhile.
      if (found && this.pending.get(claimant.sessionId) === claimant && !this.claimedIds().has(found)) {
        this.pending.delete(claimant.sessionId)
        const id = found
        try {
          this.mutate(claimant.projectId, claimant.sessionId, (s) => { s.agentSessionId = id })
        } catch {
          // the session is gone
        }
      }
    } catch (err) {
      console.warn(`codex session discovery in ${claimant.cwd}: applying the result failed`, err)
    } finally {
      if (current()) this.scheduleLoop(folder)
    }
  }
}
