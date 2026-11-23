// Agent sessions on the server. Session records live in the projects (through
// ProjectState.apply); their ptys live in a TerminalHost. Every agent command
// line is built here, never by a client.
import { randomUUID } from 'node:crypto'
import type { AttentionTopic } from '../../../src/shared/model/topics'
import type { Project, Session, SessionContext, SessionStatus, Worktree } from '../../../src/shared/model/types'
import { pickClaimant, pollDelay } from '../../../src/shared/providers/discovery.ts'
import { resolveGlobalAgent, resolveNewSessionLlm, sanitizeAgentSelection, sessionLaunch, type AgentLookup } from '../../../src/shared/agents/selection.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import { DEFAULT_AGENT_ID, agentTool, type AgentActivitySession, type AgentModel, type AgentProvider, type AgentTool } from '../../../src/shared/plugins/agents.ts'
import type { LlmSelection } from '../../../src/shared/providers/types'
import type { ConfigStore } from '../configStore.ts'
import { codedError } from '../errors.ts'
import { assertNotRepository, findRegistered } from '../projects/model.ts'
import type { ProjectState } from '../projects/state.ts'
import { realOrResolved as real } from '../repos.ts'
import type { TopicHub } from '../topicHub.ts'
import { checkExpected, isRecord, requireBoolean, requireName, requireString } from '../validate.ts'
import type { McpAccess } from '../mcp/access.ts'
import { agentLaunch, sessionEnv, sessionProcess } from './launch.ts'
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
import { commandBinary, CommandProbe, platformCommandExists } from './agents.ts'
import type { ServerAgents } from '../../../src/shared/protocolV2'
import type { ActivityEvent, ActivitySessionType, SessionCause } from '../../../src/shared/plugins/activity.ts'

export const LOAD_COLS = 120
export const LOAD_ROWS = 32

const bad = (message: string): Error => codedError('BAD_REQUEST', message)
/** A copy of a model fact (the agent's own objects never go out to be changed) */
const copyModel = (m: AgentModel): AgentModel => ({ ...m, ...(m.efforts ? { efforts: [...m.efforts] } : {}) })
/** How long agents.models keeps an endpoint's answer (a picker opened twice asks once). */
const MODELS_TTL_MS = 10_000
/** A session's tool calls reach the activity feed at most this often (campsite part 4): the latest wins, sent when the wait ends */
export const TOOL_EVERY_MS = 2000

export interface ScheduledJob {
  cancel(): void
}

export interface SessionManagerDeps {
  /** The agents this server can launch (plugins A1: its set-up plugins'; server/src/agents/registry.ts) */
  agents: AgentRegistry
  projects: ProjectState
  store: ConfigStore
  /** Where the `attention` topic is published; without it the topic is not published */
  hub?: TopicHub
  spawner?: PtySpawner
  /** Tests: stands in for the session's agent's discoverSessionId (plugins A1) */
  discover?: (cwd: string, ageMs: number, exclude: string[], agentId: string) => Promise<string | undefined>
  schedule?: (fn: () => void | Promise<void>, ms: number) => ScheduledJob
  newId?: () => string
  now?: () => number
  /** The MCP access a project's sessions launch with; without it sessions launch without MCP */
  mcpAccess?: (projectId: string) => McpAccess | undefined
  /** Added to the prompt of a session that has the MCP tools: the plugins' prompts in its project (plugin system phase 1) */
  pluginPrompt?: (projectId: string) => string | undefined
  /** Whether a program is installed (server.agents); default platformCommandExists for `platform` (the login shell, or Windows' launch lookup) */
  commandExists?: (binary: string) => Promise<boolean>
  /** A session's process ended by itself (not closed, restarted or unloaded): the push (6b) */
  onSessionExit?: (p: { projectId: string; projectName: string; worktreeId: string | null; sessionId: string }) => void
  /** Default process.platform: how a session is launched (a shell, or Windows' no-shell plan), its env, its pty's kill */
  platform?: NodeJS.Platform
  /** Core's activity feed (campsite part 2): sessions starting, changing status, deciding, closing */
  activity?: { emit(event: ActivityEvent): void }
}

/** An optional agent pick from a client: one this server has. */
export function checkLlm(value: unknown, agents: AgentLookup): LlmSelection | undefined {
  if (value === undefined) return undefined
  // sanitizeAgentSelection turns an unknown agent into the default one: refuse it instead.
  if (!isRecord(value) || typeof value.provider !== 'string' || !agents.has(value.provider)) throw bad('llm.provider must be a known provider')
  const pick = sanitizeAgentSelection(value, (id) => agents.has(id))
  if (!pick) throw bad('llm must be an LLM selection')
  return pick
}

/** A new session's context: an existing automation's, on a Global session; an automation has at most one. */
function checkContext(project: Project, value: unknown, global: boolean): SessionContext {
  if (!isRecord(value) || value.kind !== 'automation' || typeof value.automationId !== 'string') {
    throw bad("context must be { kind: 'automation', automationId }")
  }
  const automationId = value.automationId
  if (!global) throw bad('only a Global session can be an automation\'s run tab')
  if (!project.automations?.some((a) => a.id === automationId)) throw bad(`No automation with id "${automationId}"`)
  if (project.globalSessions.some((s) => s.context?.automationId === automationId)) {
    throw codedError('CONFLICT', 'the automation already has a run tab')
  }
  return { kind: 'automation', automationId }
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
  /** The agent whose discoverSessionId finds its id */
  agentId: string
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

/** What a change did to one session, for the activity feed */
interface SessionChange {
  projectId: string
  id: string
  worktreeId: string | null
  /** An automation's run tab */
  automation: boolean
  provider: string
  sessionType: ActivitySessionType | null
  from: SessionStatus
  to: SessionStatus
  had: boolean
  has: boolean
  /** Its running agent was stopped (stopRecord on a record with a pty) */
  stopped?: boolean
}

/** An agent's tool calls being followed for one session's run (campsite part 4) */
interface ToolWatch {
  /** The agent's stop function */
  stop: () => void
  /** When this run's last session.tool was sent */
  sentAt: number
  /** The latest call held back until TOOL_EVERY_MS has passed */
  pending?: AgentTool
  timer?: ScheduledJob
  /** A failure was logged (once per run) */
  warned: boolean
}

/** Whether the session is an automation's run tab */
const isAutomation = (s: Session): boolean => s.context?.kind === 'automation'

/** The session's agent and type for the activity feed (campsite part 3b): the type named as the project's settings name it now; null with none, or one since removed */
function kindOf(project: Pick<Project, 'settings'>, s: Session): { provider: string; sessionType: ActivitySessionType | null } {
  const type = s.sessionTypeId === undefined ? undefined : project.settings.sessionTypes?.find((t) => t.id === s.sessionTypeId)
  return { provider: s.llm.provider, sessionType: type ? Object.freeze({ id: type.id, name: type.name }) : null }
}

/**
 * A record whose agent was stopped (unload, suspend, stale Global sessions): no pty or exit code,
 * no decision (the agent that asked is gone; its question would outlive it), idle unless complete.
 * Returns what it changed, for the activity feed.
 */
function stopRecord(s: Session, project: Project, worktreeId: string | null): SessionChange {
  const from = s.status
  const had = s.decision !== undefined
  const stopped = s.ptyId !== undefined
  delete s.ptyId
  delete s.exitCode
  delete s.decision
  if (s.status !== 'complete') s.status = 'idle'
  return { projectId: project.id, id: s.id, worktreeId, automation: isAutomation(s), ...kindOf(project, s), from, to: s.status, had, has: false, stopped }
}

export class SessionManager {
  readonly terminals: TerminalHost
  /** The agents (plugins A1): move, promote, the automations and the MCP tools reach them here */
  readonly agentRegistry: AgentRegistry
  private readonly deps: SessionManagerDeps
  private readonly newId: () => string
  private readonly now: () => number
  private readonly discover: NonNullable<SessionManagerDeps['discover']>
  private readonly schedule: NonNullable<SessionManagerDeps['schedule']>
  /** ptyId → the session it runs */
  private readonly owners = new Map<string, Owner>()
  /** sessionId → its pending session-id discovery (an agent with the discoverSessionId hook: Codex's) */
  private readonly pending = new Map<string, PendingDiscovery>()
  /** folder → its poll loop, while it has pending sessions */
  private readonly loops = new Map<string, FolderLoop>()
  /** realpath → how many worktree.remove calls are working on it */
  private readonly blocked = new Map<string, number>()
  /** sessionId → live activity (marker scan) and its quiet timer */
  private readonly activity = new Map<string, { activity: Activity; quiet?: ScheduledJob }>()
  /** sessionId → its agent's tool calls being followed (campsite part 4: an agent with `activity`, while the feed is on) */
  private readonly toolWatches = new Map<string, ToolWatch>()
  /** Sessions whose current pty run has printed live output */
  private readonly outputSeen = new Set<string>()
  /** sessionId → when it entered attention or done */
  private readonly since = new Map<string, number>()
  private readonly probe: CommandProbe
  /** agents.models' asks by agent and config: one in flight is shared; an answer is kept until `until`, a failure dropped. */
  private readonly modelAsks = new Map<string, { models: Promise<AgentModel[]>; until: number }>()
  private stopped = false

  constructor(deps: SessionManagerDeps) {
    this.deps = deps
    this.agentRegistry = deps.agents
    this.newId = deps.newId ?? randomUUID
    this.now = deps.now ?? Date.now
    this.discover =
      deps.discover ??
      ((cwd, ageMs, exclude, agentId) => this.deps.agents.get(agentId).discoverSessionId?.({ cwd, ageMs, exclude }) ?? Promise.resolve(undefined))
    const platform = deps.platform ?? process.platform
    this.probe = new CommandProbe(deps.commandExists ?? ((binary) => platformCommandExists(binary, platform)), this.now)
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(() => void fn(), ms)
        timer.unref()
        return { cancel: () => clearTimeout(timer) }
      })
    this.terminals = new TerminalHost({
      spawner: deps.spawner,
      platform: deps.platform,
      onExit: (ptyId, code) => this.onExit(ptyId, code),
      onOutput: (ptyId, data, changed) => this.onPtyOutput(ptyId, data, changed),
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

  /** Whether another operation has `path` blocked now (blockPath). */
  isBlocked(path: string): boolean {
    return this.blocked.has(real(path))
  }

  /**
   * `p` is the client's `session.start`; `options` are the server's own (the scheduler's), out of a
   * client's reach: `context` marks an automation's run tab.
   */
  start(p: any, options: { context?: SessionContext } = {}): { sessionId: string; ptyId: string } {
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
    const pick = checkLlm(p.llm, this.deps.agents)
    if (p.context !== undefined) throw bad('context is set by the server')
    const context = options.context === undefined ? undefined : checkContext(project, options.context, global)
    const llm = this.defaultLlm(project, global, pick, sessionType?.llm)
    if (p.title !== undefined && typeof p.title !== 'string') throw bad('title must be a string')
    const title = p.title?.trim() ? checkTitle(p.title.trim(), 'title') : undefined
    const typeTitle = sessionType?.name ? checkTitle(sessionType.name, `session type "${sessionType.id}" name`) : undefined
    if (p.initialMessage !== undefined && typeof p.initialMessage !== 'string') throw bad('initialMessage must be a string')

    // Before the lazy load: at the cap, loading would only mark the worktree's sessions exited -1.
    this.assertRoomFor(project.id)
    if (worktree && !worktree.loaded) this.loadWorktree({ projectId: project.id, worktreeId: worktree.id })

    // Loading replaced the project snapshot: count the sessions in the current one.
    const current = this.deps.projects.require(project.id)
    const list = worktree ? findWorktree(current, worktree.id).worktree.sessions : current.globalSessions
    const provider = this.deps.agents.get(llm.provider)
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
    if (context) session.context = context
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

  /**
   * Starts the session over as a brand-new agent conversation (an automation's next run in its run
   * tab): its pty, if running, is stopped; queue, decision and exit code are cleared; the agent is
   * launched fresh, never resumed, with `initialMessage`. The session keeps its id. `llm`: the
   * agent to run (absent: its own; null: the default a new session there would get).
   */
  renew(p: any): { ptyId: string } {
    this.assertRunning()
    const { cols, rows } = requireSize(p)
    const project = this.deps.projects.require(p.projectId)
    const found = findSession(project, p.sessionId)
    // llm null resolves as for a Global session, and an automation's run tab is one.
    if (found.worktree) throw bad('only a Global session can be renewed')
    // spawnSession's cheap checks, made before the running pty is killed.
    this.globalCwd(project)
    const title = checkTitle(requireName(p.title, 'title'), 'title')
    if (typeof p.initialMessage !== 'string') throw bad('initialMessage must be a string')
    // null: the default for a new session of its kind, as start resolves it without a pick.
    const llm = p.llm === null ? this.defaultLlm(project, !found.worktree) : checkLlm(p.llm, this.deps.agents) ?? found.session.llm
    // A run that names its agent (an automation's) needs it on (plugins A1b): a scheduled run records
    // the refusal as its failure. Its own agent (no llm) runs as a restart would.
    if (p.llm !== null && p.llm !== undefined) this.deps.agents.checkOn(project.id, llm.provider)
    // Checked before the running pty is killed: a killed pty holds its slot until it exits.
    this.assertCapacity()
    const sessionId = found.session.id
    this.stopDiscovery(sessionId)
    this.killSession(found.session)
    this.change(project.id, sessionId, (s) => {
      delete s.ptyId
      delete s.exitCode
      delete s.decision
      s.queue = []
      s.status = 'idle'
      s.title = title
      s.llm = llm
      // A preset-id agent gets a new conversation id; a discovered one (Codex) is discovered again.
      if (this.deps.agents.get(llm.provider).capabilities.presetSessionId) s.agentSessionId = this.newId()
      else delete s.agentSessionId
    }, 'other')
    let ptyId: string
    try {
      ptyId = this.spawnSession(project.id, sessionId, { cols, rows, fresh: true, initialMessage: p.initialMessage })
    } catch (err) {
      try {
        this.change(project.id, sessionId, (s) => {
          s.status = 'exited'
          s.exitCode = -1
          // The id names a conversation that never started: a restart must not resume it.
          if (this.deps.agents.get(s.llm.provider).capabilities.presetSessionId) delete s.agentSessionId
        }, 'other')
      } catch {
        // the session is gone
      }
      this.publishAttention()
      throw err
    }
    this.publishAttention()
    return { ptyId }
  }

  close(p: any): null {
    const project = this.deps.projects.require(p.projectId)
    const found = findSession(project, p.sessionId)
    this.stopDiscovery(found.session.id)
    this.killSession(found.session)
    this.removeSession(project.id, found.session.id)
    this.emitActivity({ kind: 'session.closed', projectId: project.id, at: this.now(), terminalId: found.session.id, worktreeId: found.worktree?.id ?? null, automation: isAutomation(found.session), ...kindOf(project, found.session) })
    this.since.delete(found.session.id)
    this.publishAttention()
    return null
  }

  markComplete(p: any): null {
    const complete = requireBoolean(p.complete, 'complete')
    this.change(p.projectId, p.sessionId, (s) => {
      if (complete) s.status = 'complete'
      else if (s.status === 'complete') s.status = 'idle'
    }, 'marked')
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

  /**
   * Types `text` into the running session as the desktop pastes it (without its control
   * characters but tabs and line breaks), then presses enter.
   */
  async sendPrompt(p: any): Promise<null> {
    const text = requireString(p.text, 'text')
    if (text.length > MAX_PTY_WRITE) throw bad(`text must be at most ${MAX_PTY_WRITE} characters`)
    const { session } = findSession(this.deps.projects.require(p.projectId), p.sessionId)
    const ptyId = session.ptyId
    if (!ptyId || !this.terminals.has(ptyId)) throw bad('the session is not running')
    await this.terminals.settled(ptyId)
    if (!this.terminals.has(ptyId)) throw bad('the session is not running')
    // Typed as text: an escape or another control character (but a tab or a line break) could move
    // the cursor, or end the bracketed paste early and run the rest as keys. They are dropped.
    // eslint-disable-next-line no-control-regex
    const normalized = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').replace(/\r?\n/g, '\r')
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
    this.change(
      p.projectId,
      p.sessionId,
      (s) => {
        if (s.status === 'attention' || s.status === 'done') s.status = 'idle'
      },
      'seen',
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
    this.change(p.projectId, p.sessionId, (s) => { s.decision = { question, at: this.now() } }, 'other', false)
    this.publishAttention()
    return null
  }

  /** A client dismissed the session's decision without answering it in the terminal. */
  dismissDecision(p: any): null {
    this.change(p.projectId, p.sessionId, (s) => { delete s.decision }, 'other', false, 'dismissed')
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

  /** The agents this server can launch, and its default (server.agents). */
  async agents(p: any): Promise<ServerAgents> {
    const settings = p.projectId === undefined ? undefined : this.deps.projects.require(p.projectId).settings
    const registry = this.deps.agents
    const agents = await Promise.all(
      registry.all().map(async (agent) => {
        const binary = commandBinary(agent.command(registry.config(agent.id, settings)), this.deps.platform)
        return {
          provider: agent.id,
          label: agent.label,
          installed: binary ? await this.probe.installed(binary) : false,
          // agentInfo (plugins A1b): what a client builds its pickers from.
          glyph: agent.glyph,
          plugin: registry.pluginOf(agent.id),
          capabilities: { ...agent.capabilities },
          models: agent.models.map(copyModel),
          efforts: [...agent.efforts],
          approvalModes: agent.approvalModes.map((m) => ({ ...m })),
          ...(agent.defaultApprovalMode ? { defaultApprovalMode: agent.defaultApprovalMode } : {}),
          listsModels: agent.listModels !== undefined,
          ...(p.projectId !== undefined ? { on: registry.isOn(p.projectId, agent.id) } : {})
        }
      })
    )
    return { llmDefault: this.deps.store.llmDefault(registry), agents }
  }

  /**
   * An agent's models (agents.models, plugins A1b): its endpoint's (listModels: Local's, at the
   * server config's URL only; the client names no URL), else its static list. Concurrent callers
   * share one ask, and its answer serves MODELS_TTL_MS; a failure is not kept.
   */
  async agentModels(p: any): Promise<{ models: AgentModel[] }> {
    const provider = requireString(p.provider, 'provider')
    const registry = this.deps.agents
    if (!registry.has(provider)) throw bad(`No agent "${provider}" on this server`)
    const settings = p.projectId === undefined ? undefined : this.deps.projects.require(p.projectId).settings
    const agent = registry.get(provider)
    if (!agent.listModels) return { models: agent.models.map(copyModel) }
    const config = registry.config(agent.id, settings)
    const key = `${agent.id}\n${JSON.stringify(config)}`
    let ask = this.modelAsks.get(key)
    if (!ask || ask.until <= this.now()) {
      const listModels = agent.listModels
      const entry = { models: (async () => listModels(config))(), until: Infinity }
      entry.models.then(
        () => { if (this.modelAsks.get(key) === entry) entry.until = this.now() + MODELS_TTL_MS },
        () => { if (this.modelAsks.get(key) === entry) this.modelAsks.delete(key) }
      )
      this.modelAsks.set(key, entry)
      ask = entry
    }
    try {
      return { models: (await ask.models).map(copyModel) }
    } catch (err) {
      throw codedError('TOOL_ERROR', `${agent.label}'s models could not be listed: ${err instanceof Error ? err.message : String(err)}`)
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
          this.change(project.id, session.id, (s) => {
            delete s.ptyId
            s.status = 'exited'
            s.exitCode = -1
          }, 'other', false)
        } catch {
          // the session is gone
        }
      }
    }
    return null
  }

  /**
   * Stops these sessions' agents (5e: a promote or demote hands them to the other checkout) as
   * unloadWorktree does for a whole worktree: their records stay, idle, with no pty.
   */
  suspendSessions(projectId: string, sessionIds: readonly string[]): void {
    const project = this.deps.projects.require(projectId)
    const ids = new Set(sessionIds)
    for (const repo of project.repositories) {
      for (const worktree of repo.worktrees) {
        for (const session of worktree.sessions) {
          if (!ids.has(session.id)) continue
          this.stopDiscovery(session.id)
          this.killSession(session)
        }
      }
    }
    const changes: SessionChange[] = []
    this.deps.projects.apply(
      projectId,
      (d) => {
        for (const repo of d.repositories) {
          for (const worktree of repo.worktrees) {
            for (const s of worktree.sessions) {
              if (ids.has(s.id)) changes.push(stopRecord(s, d, worktree.id))
            }
          }
        }
      },
      { persist: false }
    )
    for (const c of changes) this.reportChange(c, 'other', 'dismissed')
    this.publishAttention()
  }

  /**
   * Resumes these sessions where their records now are (5e: in the checkout a promote or demote
   * handed them to, already loaded). One that can't start shows as exited, as loadWorktree's do.
   */
  resumeSessions(projectId: string, sessionIds: readonly string[]): void {
    this.assertRunning()
    for (const id of sessionIds) {
      try {
        this.spawnSession(projectId, id, { cols: LOAD_COLS, rows: LOAD_ROWS })
      } catch (err) {
        console.error(`could not resume session ${id}`, err)
        try {
          this.change(projectId, id, (s) => {
            delete s.ptyId
            s.status = 'exited'
            s.exitCode = -1
          }, 'other', false)
        } catch {
          // the session is gone
        }
      }
    }
  }

  unloadWorktree(p: any): null {
    const project = this.deps.projects.require(p.projectId)
    const { worktree } = findWorktree(project, p.worktreeId)
    for (const session of worktree.sessions) {
      this.stopDiscovery(session.id)
      this.killSession(session)
    }
    const changes: SessionChange[] = []
    this.deps.projects.apply(
      project.id,
      (d) => {
        const target = findWorktree(d, worktree.id).worktree
        target.loaded = false
        for (const s of target.sessions) changes.push(stopRecord(s, d, target.id))
      },
      { persist: false }
    )
    for (const c of changes) this.reportChange(c, 'other', 'dismissed')
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
    const changes: SessionChange[] = []
    try {
      this.deps.projects.apply(
        projectId,
        (d) => {
          for (const s of d.globalSessions) changes.push(stopRecord(s, d, null))
        },
        { persist: false }
      )
    } catch {
      // the project is gone
    }
    for (const c of changes) this.reportChange(c, 'other', 'dismissed')
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
    for (const id of [...this.toolWatches.keys()]) this.stopTools(id)
    this.outputSeen.clear()
    this.since.clear()
    this.terminals.disposeAll()
  }

  // ---- internals ----

  private assertRunning(): void {
    if (this.stopped) throw codedError('INTERNAL', 'the server is shutting down')
  }

  /**
   * CAPACITY unless the server and the project have room for one more session (what start checks;
   * task.start asks before its git work).
   */
  assertRoomFor(projectId: string): void {
    this.assertRunning()
    this.assertCapacity()
    const project = this.deps.projects.require(projectId)
    const records = project.globalSessions.length + project.repositories.reduce((n, r) => n + r.worktrees.reduce((m, w) => m + w.sessions.length, 0), 0)
    if (records >= MAX_SESSIONS_PER_PROJECT) throw codedError('CAPACITY', `a project holds at most ${MAX_SESSIONS_PER_PROJECT} sessions; close some first`)
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

  /**
   * The agent a new session runs: the pick, else the project's Global agent or the session type's /
   * project's default. BAD_REQUEST when the agent it comes to is turned off in the project.
   */
  private defaultLlm(project: Project, global: boolean, pick?: LlmSelection, typeLlm?: LlmSelection): LlmSelection {
    const settings = project.settings
    const agents = this.deps.agents
    // A default naming an agent turned off in the project is passed over (plugins A1b), down to
    // Claude, which is always on; a pick or a session type's agent is not: the start is refused.
    const on = (s: LlmSelection | undefined): LlmSelection | undefined => (s && agents.isOn(project.id, agents.get(s.provider).id) ? s : undefined)
    const serverDefault = on(this.deps.store.llmDefault(agents))
    const llm = global
      ? pick ?? resolveGlobalAgent(on(settings.globalLlm), on(settings.llmDefault) ?? serverDefault, agents)
      : resolveNewSessionLlm({ pick, sessionType: typeLlm, projectDefault: on(settings.llmDefault), appDefault: serverDefault })
    agents.checkOn(project.id, llm.provider)
    return llm
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
    const provider = this.deps.agents.get(session.llm.provider)
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
      cwd = this.globalCwd(project)
      const first = project.repositories[0]!
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
    const spec = agentLaunch(
      {
        mcp,
        llm: session.llm,
        sessionId: launch.sessionId,
        resume: launch.resume,
        global: !worktree,
        systemPrompt: session.systemPrompt,
        pluginPrompt: this.deps.pluginPrompt?.(projectId),
        initialMessage: launch.resume ? undefined : run.initialMessage,
        addDirs
      },
      project.settings,
      this.deps.agents,
      this.deps.platform ?? process.platform
    )
    const ptyId = this.newId()
    this.terminals.spawn(ptyId, {
      ...sessionProcess(spec, cwd, this.deps.platform),
      cwd,
      env: sessionEnv(session.id, worktree ? { id: worktree.id, path: worktree.path } : undefined, spec.env ?? {}, this.deps.platform),
      cols: run.cols,
      rows: run.rows
    })
    this.owners.set(ptyId, { projectId, sessionId, repoId: repo?.id })
    // A preset-id agent whose saved id was unusable got a fresh one: that must reach disk.
    const idChanged = provider.capabilities.presetSessionId && session.agentSessionId !== launch.sessionId
    let revived = false
    try {
      this.deps.projects.apply(
        projectId,
        (d) => {
          const s = findSession(d, sessionId).session
          s.ptyId = ptyId
          delete s.exitCode
          revived = s.status === 'exited'
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
    const fact = { projectId, at: this.now(), terminalId: sessionId, worktreeId: worktree?.id ?? null, automation: isAutomation(session), ...kindOf(project, session) }
    if (revived) this.emitActivity({ kind: 'session.status', ...fact, from: 'exited', to: 'idle', cause: 'other' })
    // Every launch of the session's agent (start, restart, renew, a resume on load): one session.started
    this.emitActivity({ kind: 'session.started', ...fact })
    this.watchTools(provider, projectId, { sessionId: launch.sessionId, cwd, terminalId: sessionId })
    // A quick renew of a Codex run tab (within the scan's 2 s skew of its previous launch, before that
    // launch's id was found) can bind the killed run's rollout: the dead id is no session's, so it is
    // not excluded. restart has the same race; automation runs are minutes apart.
    if (!provider.capabilities.presetSessionId && provider.capabilities.resume && !launch.resume && provider.discoverSessionId) {
      this.startDiscovery({ projectId, sessionId, agentId: provider.id, repoId: repo?.id, cwd, folder: real(cwd), startedAt: this.now() })
    }
    return ptyId
  }

  /** Where a Global session runs: the first repository's main worktree (BAD_REQUEST without one). */
  private globalCwd(project: Project): string {
    const first = project.repositories[0]
    if (!first) throw bad('the project has no repositories')
    const main = first.worktrees.find((w) => w.isMain) ?? first.worktrees[0]
    if (main?.missing) throw bad(`${main.path} no longer exists`)
    return main?.path ?? first.path
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
    let exited: { projectName: string; worktreeId: string | null; automation: boolean; agent: ReturnType<typeof kindOf> } | undefined
    let from: SessionStatus | undefined
    try {
      this.deps.projects.apply(
        owner.projectId,
        (d) => {
          const found = findSession(d, owner.sessionId)
          const s = found.session
          if (s.ptyId !== ptyId) return
          delete s.ptyId
          from = s.status
          s.status = 'exited'
          s.exitCode = exitCode
          exited = { projectName: d.name, worktreeId: found.worktree?.id ?? null, automation: isAutomation(s), agent: kindOf(d, s) }
        },
        { persist: false }
      )
    } catch {
      // the project or session is gone
    }
    if (exited && from !== undefined && from !== 'exited') {
      this.emitActivity({ kind: 'session.status', projectId: owner.projectId, at: this.now(), terminalId: owner.sessionId, worktreeId: exited.worktreeId, automation: exited.automation, ...exited.agent, from, to: 'exited', cause: 'other' })
    }
    this.publishAttention()
    if (exited) {
      try {
        this.deps.onSessionExit?.({ projectId: owner.projectId, sessionId: owner.sessionId, projectName: exited.projectName, worktreeId: exited.worktreeId })
      } catch (err) {
        console.warn('onSessionExit failed', err)
      }
    }
  }

  // ---- live status ----

  /** The agent's status markers; none when the server has neither it nor the default agent (pty output must never throw). */
  private statusMarkers(agentId: string): readonly string[] {
    const registry = this.deps.agents
    return registry.has(agentId) || registry.has(DEFAULT_AGENT_ID) ? registry.get(agentId).statusMarkers : []
  }

  private onPtyOutput(ptyId: string, data: string, changed: boolean): void {
    if (this.stopped) return
    const owner = this.owners.get(ptyId)
    const session = owner && this.sessionOf(owner)
    if (!owner || !session) return
    this.outputSeen.add(owner.sessionId)
    const markers = this.statusMarkers(session.llm.provider)
    const entry = this.activity.get(owner.sessionId) ?? { activity: newActivity() }
    const r = onOutput(session.status, entry.activity, data, markers, changed)
    entry.activity = r.activity
    this.activity.set(owner.sessionId, entry)
    if (r.restartTimer) this.armQuiet(ptyId, entry)
    if (r.status !== session.status) this.setStatus(owner, r.status, 'output')
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
    this.setStatus(owner, status, 'input', answered)
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
    if (r.status !== session.status) this.setStatus(owner, r.status, 'quiet')
  }

  private onPtyBell(ptyId: string): void {
    if (this.stopped) return
    const owner = this.owners.get(ptyId)
    const session = owner && this.sessionOf(owner)
    if (!owner || !session) return
    const status = onBell(session.status)
    if (status !== session.status) this.setStatus(owner, status, 'bell')
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
  private setStatus(owner: Owner, status: SessionStatus, cause: SessionCause, clearDecision = false): void {
    let c: SessionChange | undefined
    try {
      this.deps.projects.apply(
        owner.projectId,
        (d) => {
          const found = findSession(d, owner.sessionId)
          const s = found.session
          const from = s.status
          const had = s.decision !== undefined
          s.status = status
          if (clearDecision) delete s.decision
          c = { projectId: d.id, id: s.id, worktreeId: found.worktree?.id ?? null, automation: isAutomation(s), ...kindOf(d, s), from, to: s.status, had, has: s.decision !== undefined }
        },
        { persist: false }
      )
    } catch {
      return
    }
    if (!c) return
    if (c.from !== c.to) {
      if (status === 'attention' || status === 'done') this.since.set(owner.sessionId, this.now())
      else this.since.delete(owner.sessionId)
    }
    this.reportChange(c, cause, 'answered')
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

  /** The session's pty ended or was dropped: forget its activity, output flag, quiet timer and `since`; stop following its tool calls. */
  private dropActivity(sessionId: string): void {
    this.activity.get(sessionId)?.quiet?.cancel()
    this.activity.delete(sessionId)
    this.stopTools(sessionId)
    this.outputSeen.delete(sessionId)
    this.since.delete(sessionId)
  }

  /**
   * A project's name or settings changed (project.rename, project.updateSettings):
   * the `attention` topic labels its entries with both, so it is republished.
   */
  refreshAttention(): void {
    this.publishAttention()
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

  private emitActivity(event: ActivityEvent): void {
    this.deps.activity?.emit(event)
  }

  /**
   * Follows a launched agent's tool calls (campsite part 4): only an agent with `activity`, and only
   * while the server has an activity feed. A throwing `watch` is logged once; the session runs on.
   */
  private watchTools(provider: AgentProvider, projectId: string, run: AgentActivitySession): void {
    this.stopTools(run.terminalId)
    if (!this.deps.activity || !provider.activity) return
    const watch: ToolWatch = { stop: () => {}, sentAt: -Infinity, warned: false }
    this.toolWatches.set(run.terminalId, watch)
    try {
      const stop = provider.activity.watch({ ...run }, (tool) => {
        try {
          this.onTool(projectId, run.terminalId, watch, tool)
        } catch (err) {
          this.warnTools(watch, run.terminalId, err)
        }
      })
      if (typeof stop === 'function') watch.stop = stop
    } catch (err) {
      if (this.toolWatches.get(run.terminalId) === watch) this.toolWatches.delete(run.terminalId)
      this.warnTools(watch, run.terminalId, err)
    }
  }

  /**
   * Logs a watch's first failure. Later failures in the same run are deliberately silent (a feed
   * that throws on every call would flood the log); the next launch (a restart, a resume) gets a
   * fresh watch and so logs again.
   */
  private warnTools(watch: ToolWatch, sessionId: string, err: unknown): void {
    if (watch.warned) return
    watch.warned = true
    console.warn(`following the tool calls of session ${sessionId} failed`, err)
  }

  /** One tool call: sent at once, or held as the latest until TOOL_EVERY_MS after the last one sent */
  private onTool(projectId: string, sessionId: string, watch: ToolWatch, value: unknown): void {
    if (this.stopped || this.toolWatches.get(sessionId) !== watch) return
    const tool = agentTool(value)
    if (!tool) return
    const wait = watch.sentAt + TOOL_EVERY_MS - this.now()
    if (wait <= 0 && !watch.timer) {
      this.sendTool(projectId, sessionId, watch, tool)
      return
    }
    watch.pending = tool
    watch.timer ??= this.schedule(() => {
      watch.timer = undefined
      const latest = watch.pending
      watch.pending = undefined
      if (!latest || this.stopped || this.toolWatches.get(sessionId) !== watch) return
      // Off the agent's call stack: a throwing feed is contained here as on the synchronous path
      try {
        this.sendTool(projectId, sessionId, watch, latest)
      } catch (err) {
        this.warnTools(watch, sessionId, err)
      }
    }, Math.max(0, wait))
  }

  /** A session.tool with the session's facts as they are now (none once the session is gone) */
  private sendTool(projectId: string, sessionId: string, watch: ToolWatch, tool: AgentTool): void {
    watch.sentAt = this.now()
    let found: ReturnType<typeof findSession>
    let project: Project
    try {
      project = this.deps.projects.require(projectId)
      found = findSession(project, sessionId)
    } catch {
      return
    }
    const fact = { projectId, at: this.now(), terminalId: sessionId, worktreeId: found.worktree?.id ?? null, automation: isAutomation(found.session), ...kindOf(project, found.session) }
    this.emitActivity({ kind: 'session.tool', ...fact, tool: Object.freeze(tool) })
  }

  /** Stops following the session's tool calls (a held one is dropped); a throwing stop is logged */
  private stopTools(sessionId: string): void {
    const watch = this.toolWatches.get(sessionId)
    if (!watch) return
    this.toolWatches.delete(sessionId)
    watch.timer?.cancel()
    watch.pending = undefined
    try {
      watch.stop()
    } catch (err) {
      this.warnTools(watch, sessionId, err)
    }
  }

  /** Reports a change: the status (with its cause), and a decision asked or cleared (`cleared`: how) */
  private reportChange(c: SessionChange, cause: SessionCause, cleared: 'answered' | 'dismissed'): void {
    const base = { projectId: c.projectId, at: this.now(), terminalId: c.id, worktreeId: c.worktreeId, automation: c.automation, provider: c.provider, sessionType: c.sessionType }
    if (c.from !== c.to) this.emitActivity({ kind: 'session.status', ...base, from: c.from, to: c.to, cause })
    if (!c.had && c.has) this.emitActivity({ kind: 'session.decision', ...base, state: 'asked' })
    if (c.had && !c.has) this.emitActivity({ kind: 'session.decision', ...base, state: cleared })
    if (c.stopped) this.emitActivity({ kind: 'session.stopped', ...base })
  }

  /** `mutate`, reporting what it changed to the activity feed */
  private change(
    projectId: unknown,
    sessionId: unknown,
    fn: (s: Session) => void,
    cause: SessionCause,
    persist = true,
    cleared: 'answered' | 'dismissed' = 'dismissed'
  ): void {
    let c: SessionChange | undefined
    this.deps.projects.apply(
      projectId,
      (d) => {
        const found = findSession(d, sessionId)
        const s = found.session
        const from = s.status
        const had = s.decision !== undefined
        fn(s)
        c = { projectId: d.id, id: s.id, worktreeId: found.worktree?.id ?? null, automation: isAutomation(s), ...kindOf(d, s), from, to: s.status, had, has: s.decision !== undefined }
      },
      { persist }
    )
    if (c) this.reportChange(c, cause, cleared)
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
      found = await this.discover(claimant.cwd, this.now() - claimant.startedAt, [...this.claimedIds()], claimant.agentId)
    } catch (err) {
      console.warn(`session id discovery in ${claimant.cwd} failed`, err)
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
      console.warn(`session id discovery in ${claimant.cwd}: applying the result failed`, err)
    } finally {
      if (current()) this.scheduleLoop(folder)
    }
  }
}
