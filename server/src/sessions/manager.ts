// Agent sessions on the server. Session records live in the projects (through
// ProjectState.apply); their ptys live in a TerminalHost. Every agent command
// line is built here, never by a client.
import { randomUUID } from 'node:crypto'
import { discoverCodexSession } from '../../../src/host/agentService.ts'
import type { Project, Session, Worktree } from '../../../src/shared/model/types'
import { pollDelay } from '../../../src/shared/providers/discovery.ts'
import { getProvider } from '../../../src/shared/providers/registry.ts'
import {
  resolveGlobalLlm,
  resolveNewSessionLlm,
  sanitizeLlmSelection,
  sessionLaunch
} from '../../../src/shared/providers/selection.ts'
import type { LlmSelection } from '../../../src/shared/providers/types'
import type { ConfigStore } from '../configStore.ts'
import { codedError } from '../errors.ts'
import { assertNotRepository } from '../projects/model.ts'
import type { ProjectState } from '../projects/state.ts'
import { realOrResolved as real } from '../repos.ts'
import { requireBoolean, requireString } from '../validate.ts'
import { agentCommand, sessionEnv, shellLaunch } from './launch.ts'
import { findSession, findWorktree, sessionList } from './locate.ts'
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
  spawner?: PtySpawner
  discover?: (cwd: string, ageMs: number, exclude: string[]) => Promise<string | undefined>
  schedule?: (fn: () => void | Promise<void>, ms: number) => ScheduledJob
  newId?: () => string
  now?: () => number
}

function requireSize(p: any): { cols: number; rows: number } {
  const ok = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000
  if (!ok(p.cols) || !ok(p.rows)) throw bad('cols and rows must be integers from 1 to 1000')
  return { cols: p.cols, rows: p.rows }
}

/** One pending Codex discovery; `job` is the timer for its next poll. */
interface Discovery {
  job: ScheduledJob
}

export class SessionManager {
  readonly terminals: TerminalHost
  private readonly deps: SessionManagerDeps
  private readonly newId: () => string
  private readonly now: () => number
  private readonly discover: NonNullable<SessionManagerDeps['discover']>
  private readonly schedule: NonNullable<SessionManagerDeps['schedule']>
  /** ptyId → the session it runs */
  private readonly owners = new Map<string, { projectId: string; sessionId: string }>()
  /** sessionId → the pending Codex discovery */
  private readonly discoveries = new Map<string, Discovery>()
  /** realpaths a worktree.remove is working on */
  private readonly blocked = new Set<string>()
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
    this.terminals = new TerminalHost({ spawner: deps.spawner, onExit: (ptyId, code) => this.onExit(ptyId, code) })
  }

  /** While the returned function is not called, start/load on `path` are IN_USE. */
  blockPath(path: string): () => void {
    const key = real(path)
    this.blocked.add(key)
    return () => this.blocked.delete(key)
  }

  start(p: any): { sessionId: string; ptyId: string } {
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
      pick = sanitizeLlmSelection(p.llm)
      if (!pick) throw bad('llm must be an LLM selection')
    }
    const serverDefault = this.deps.store.llmSettings().llmDefault
    const llm = global
      ? pick ?? resolveGlobalLlm(settings.globalLlm, settings.llmDefault ?? serverDefault)
      : resolveNewSessionLlm({ pick, sessionType: sessionType?.llm, projectDefault: settings.llmDefault, appDefault: serverDefault })
    if (p.title !== undefined && typeof p.title !== 'string') throw bad('title must be a string')
    if (p.initialMessage !== undefined && typeof p.initialMessage !== 'string') throw bad('initialMessage must be a string')

    if (worktree && !worktree.loaded) this.loadWorktree({ projectId: project.id, worktreeId: worktree.id })

    // Loading replaced the project snapshot: count the sessions in the current one.
    const current = this.deps.projects.require(project.id)
    const list = worktree ? findWorktree(current, worktree.id).worktree.sessions : current.globalSessions
    const provider = getProvider(llm.provider)
    const sessionId = this.newId()
    const session: Session = {
      id: sessionId,
      title: p.title?.trim() || sessionType?.name || this.defaultTitle(provider.label, list.length, worktree),
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
    return null
  }

  markComplete(p: any): null {
    const complete = requireBoolean(p.complete, 'complete')
    this.mutate(p.projectId, p.sessionId, (s) => {
      if (complete) s.status = 'complete'
      else if (s.status === 'complete') s.status = 'idle'
    })
    return null
  }

  loadWorktree(p: any): null {
    const project = this.deps.projects.require(p.projectId)
    const worktree = this.usableWorktree(project, p.worktreeId)
    if (worktree.loaded) return null
    this.deps.projects.apply(project.id, (d) => { findWorktree(d, worktree.id).worktree.loaded = true }, { persist: false })
    // spawnSession re-reads each session from the current project; only the ids come from this snapshot.
    for (const session of worktree.sessions) {
      if (session.ptyId && this.terminals.has(session.ptyId)) continue
      this.spawnSession(project.id, session.id, { cols: LOAD_COLS, rows: LOAD_ROWS })
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
          if (s.status !== 'complete') s.status = 'idle'
        }
      },
      { persist: false }
    )
    return null
  }

  /** Server shutdown: kill every pty; their exits are ignored. */
  stopAll(): void {
    this.stopped = true
    for (const d of this.discoveries.values()) d.job.cancel()
    this.discoveries.clear()
    this.terminals.disposeAll()
  }

  // ---- internals ----

  /** A worktree a session may run in: present, inside the allowlist, not a registered repo of its own, not being removed. */
  private usableWorktree(project: Project, worktreeId: unknown): Worktree {
    const { worktree } = findWorktree(project, worktreeId)
    if (worktree.missing) throw bad(`${worktree.path} no longer exists`)
    this.deps.store.guard.check(worktree.path)
    if (!worktree.isMain) assertNotRepository(this.deps.store.config.repos, real(worktree.path), 'worktree')
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
    const project = this.deps.projects.require(projectId)
    const { session, worktree } = findSession(project, sessionId)
    const provider = getProvider(session.llm.provider)
    // A new session's preset id names a conversation the agent has not created yet: start it, don't resume it.
    const launch = run.fresh
      ? { sessionId: session.agentSessionId ?? this.newId(), resume: false }
      : sessionLaunch(provider.capabilities, session.agentSessionId, this.newId)
    const first = project.repositories[0]
    if (!worktree && !first) throw bad('the project has no repositories')
    const cwd = worktree ? worktree.path : (first.worktrees.find((w) => w.isMain) ?? first.worktrees[0])?.path ?? first.path
    const spec = agentCommand(
      {
        llm: session.llm,
        sessionId: launch.sessionId,
        resume: launch.resume,
        global: !worktree,
        systemPrompt: session.systemPrompt,
        initialMessage: launch.resume ? undefined : run.initialMessage,
        addDirs: worktree ? undefined : project.repositories.slice(1).map((r) => r.path)
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
    this.owners.set(ptyId, { projectId, sessionId })
    // A preset-id agent whose saved id was unusable got a fresh one: that must reach disk.
    const idChanged = provider.capabilities.presetSessionId && session.agentSessionId !== launch.sessionId
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
    if (!provider.capabilities.presetSessionId && provider.capabilities.resume && !launch.resume) {
      this.startDiscovery(projectId, sessionId, cwd, this.now())
    }
    return ptyId
  }

  private killSession(session: Session): void {
    if (!session.ptyId) return
    this.owners.delete(session.ptyId)
    if (this.terminals.has(session.ptyId)) this.terminals.kill(session.ptyId)
  }

  private onExit(ptyId: string, exitCode: number): void {
    const owner = this.owners.get(ptyId)
    this.owners.delete(ptyId)
    if (!owner || this.stopped) return
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
  }

  private mutate(projectId: unknown, sessionId: unknown, fn: (s: Session) => void, persist = true): void {
    this.deps.projects.apply(projectId, (d) => fn(findSession(d, sessionId).session), { persist })
  }

  private startDiscovery(projectId: string, sessionId: string, cwd: string, startedAt: number): void {
    this.stopDiscovery(sessionId)
    // Identity check: a poll still awaiting when this discovery is stopped (or replaced by a
    // restart's) must neither apply its result nor schedule another poll.
    const discovery: Discovery = { job: { cancel: () => {} } }
    const live = (): boolean => !this.stopped && this.discoveries.get(sessionId) === discovery
    const poll = async (): Promise<void> => {
      if (!live()) return
      const exclude: string[] = []
      for (const p of this.deps.projects.all()) {
        for (const s of [...p.globalSessions, ...p.repositories.flatMap((r) => r.worktrees.flatMap((w) => w.sessions))]) {
          if (s.agentSessionId) exclude.push(s.agentSessionId)
        }
      }
      let found: string | undefined
      try {
        found = await this.discover(cwd, this.now() - startedAt, exclude)
      } catch (err) {
        console.warn(`codex session discovery in ${cwd} failed`, err)
      }
      if (!live()) return
      if (found) {
        this.discoveries.delete(sessionId)
        try {
          this.mutate(projectId, sessionId, (s) => { s.agentSessionId = found })
        } catch {
          // the session is gone
        }
        return
      }
      discovery.job = this.schedule(poll, pollDelay(this.now() - startedAt))
    }
    this.discoveries.set(sessionId, discovery)
    discovery.job = this.schedule(poll, pollDelay(0))
  }

  private stopDiscovery(sessionId: string): void {
    this.discoveries.get(sessionId)?.job.cancel()
    this.discoveries.delete(sessionId)
  }
}
