// The campsite's server half (campsite part 2): core's activity feed in, through the reward rules,
// into camp.json; `state` answers the snapshot and every change is sent to every project's windows
// (throttled to once a second). The shop's handlers (part 3a) build a building's next tier and hire a
// walk-in; seen and awaySeen keep the "While you were away" card; gear and pin (part 3b) buy a
// member's next item and pin it to a kind of session, and journal answers a member's journal (not
// pushed with the snapshot). The host names projects and worktrees for the
// crew's journals. Trails (part 3c) move with the activity feed and are reconciled against the
// host's worktrees: the first time a project is heard from (an event, or a window's `state` naming
// it), after each worktree event, and every 10 minutes; before a commit or pull request event, only
// the missing trails are opened (a worktree made outside Trek). For TRAIL_GRACE_MS after start-up the
// host's branches come from the saved project file until its poller's first refresh, so only those
// pre-passes run (the events come after a refresh): no reconcile at start-up, for a window's `state`
// or the first word from a project, nor after a worktree event (camp.json holds the open trails). The
// first full reconcile is the first tick after it. A merge first paid sends `summit` for each trail it summits, and
// `trailLog` answers a project's history (not pushed). A minute tick pays working minutes, cools the fire and forgets sessions that
// are gone. The world (part 3d-1): each event stamps its project's last activity, and so does the
// tick for each working session's project (saved with it, so at most about once a minute); with the
// trails' checks it is pushed for the windows' weather. Wildlife (part 3d-2): `seen` also carries the
// window's time zone and Seasons setting (the camp's clock); each minute tick rolls a sighting for
// every project the camp knows (its last activity, or a window that asked for the state or pinged
// seen this run) where the plugin is on and that is active or has a window open, logs it and sends `sighting` to that project's windows
// only; `build` takes the ranger tower. Real chores (part 4): each session's latest tool call
// (session.tool) is kept in memory only (never in camp.json, and it pays nothing), sent as `tool` to
// that project's windows, and dropped (sent as null) when the session's agent starts again, stops,
// exits or the session closes; `state` answers a window's project's tools with the snapshot. Agents
// in the camp (part 5): two MCP tools, camp_note (a note on the project's noticeboard, sent as `note`
// to its windows) and camp_trail_report (the latest report on a worktree's trail, in its member's
// journal too), each at most once a minute per session (or project) and per trail, saved at once;
// a session's worktree and agent come from the activity feed (kept in memory); `notes` answers a
// project's notes (the snapshot carries only each project's newest note's time). New commits are
// counted with git (fast-forward only). Nothing here can stop the server: errors are logged and pay
// nothing.
import { basename } from 'node:path'
import type { ActivityEvent } from '../../../src/shared/plugins/activity.ts'
import type { AgentToolKind } from '../../../src/shared/plugins/agents.ts'
import { pluginError, type PluginInstance, type PluginMcpTool, type PluginWorktree, type ServerPluginHost } from '../../../src/shared/plugins/server.ts'
import { awaySeen, seen } from '../shared/away.ts'
import { snapshot, type CampSnapshot } from '../shared/camp.ts'
import { journalOf, memberOf, pinMember, type Where } from '../shared/crew.ts'
import { applyActivity, applyCommits, forget, tick, type Rules } from '../shared/economy.ts'
import { note } from '../shared/journal.ts'
import { NOTE_MAX, REPORT_MAX, addNote, cleanText, notesOf, takePost, whoLine, type Note } from '../shared/notes.ts'
import { build, buyGear, recruit, type ShopRefusal } from '../shared/shop.ts'
import { SUMMIT, freshOf, postReport, reconcile, trailKey, trailLogOf, trailProjects, trailsOn, type Fresh, type ReconcileMode } from '../shared/trails.ts'
import { rollSighting, setClock } from '../shared/wildlife.ts'
import { openCampStore } from './store.ts'

export type CampHost = Pick<ServerPluginHost, 'dataFile' | 'onActivity' | 'emit' | 'emitAll' | 'session' | 'checkedWorktree' | 'run' | 'log' | 'isEnabled' | 'projectName' | 'worktree' | 'worktrees' | 'subscriberCount'>

/** The host's names for the journal: a project's name (its id if the host can't say), a worktree's repository, branch and folder (null once it is gone). Never throws, as `Where` promises */
export function hostWhere(host: Pick<CampHost, 'projectName' | 'worktree'>): Where {
  return {
    project: (projectId) => {
      try {
        return host.projectName(projectId)
      } catch {
        return projectId
      }
    },
    worktree: (projectId, worktreeId) => {
      try {
        const w = host.worktree(projectId, worktreeId)
        return { repoId: w.repoId, branch: w.branch, name: basename(w.path) }
      } catch {
        return null
      }
    }
  }
}

export interface CampServerOptions {
  now?: () => number
  seed?: () => number
  /** A working minute; default TREK_CAMPSITE_MINUTE_MS when set (tests, smokes), else 60 s */
  minuteMs?: number
  schedule?: (fn: () => void, ms: number) => { cancel(): void }
  interval?: (fn: () => void, ms: number) => { clear(): void }
  /** A fresh camp's wood (it also gets 3 markers); default TREK_CAMPSITE_SEED_WOOD when set (smokes) */
  seedWood?: number
  /** The sightings' dice and an animal's side (default Math.random) */
  rand?: () => number
  /** Every minute roll is a sighting (the smokes); default TREK_CAMPSITE_FORCE_SIGHTINGS=1 */
  forceSightings?: boolean
}

/** A session's latest tool call as `tool` sends it (`at`: the server's ms) */
export interface ToolNote {
  kind: AgentToolKind
  label: string
  at: number
}
/** A window's project's tools as `state` answers them: by session, with their age (ms), so a window on another clock can place them */
export type ToolAges = Record<string, { kind: AgentToolKind; label: string; age: number }>

/** The `note` event: a project's new note */
export interface NoteEvent {
  projectId: string
  note: Note
}

export const CAMP_NOTE_TOOL = {
  name: 'camp_note',
  description:
    "Leave a short note for the user on this project's noticeboard at the camp (Trek's Campsite strip): one line of plain text, at most 140 characters (no markdown or links). At most one note a minute. Pass the TREK_TERMINAL_ID environment variable of your shell (echo $TREK_TERMINAL_ID) as terminalId, so the note says which agent and worktree it is from.",
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The note: one line, at most 140 characters' },
      terminalId: { type: 'string', description: 'Value of $TREK_TERMINAL_ID' }
    },
    required: ['text']
  }
}

export const CAMP_TRAIL_REPORT_TOOL = {
  name: 'camp_trail_report',
  description:
    "Post a short report on your worktree's trail at the camp (Trek's Campsite strip) when you finish a task: what you did and where it stands, plain text, at most 280 characters. The trail keeps only its latest report. A Global session has no trail: leave a camp_note instead. Pass the TREK_TERMINAL_ID environment variable of your shell (echo $TREK_TERMINAL_ID) as terminalId (or the worktree's id as worktreeId). At most one report a minute per trail.",
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'What you did and where it stands, at most 280 characters' },
      terminalId: { type: 'string', description: 'Value of $TREK_TERMINAL_ID' },
      worktreeId: { type: 'string', description: "The worktree's id, when there is no terminalId" }
    },
    required: ['summary']
  }
}

export const CAMP_MCP_INSTRUCTIONS = 'Campsite: you may post a trail report with camp_trail_report when you finish a task, and leave a short note for the user with camp_note.'

const EMIT_EVERY_MS = 1000
/** How often every known project's trails are reconciled against its worktrees */
export const TRAIL_EVERY_MS = 10 * 60_000
/**
 * After start-up, reconciles only open missing trails for this long: until core's poller first
 * refreshes, host.worktrees can report a branch from the saved project file that is no longer checked out
 */
export const TRAIL_GRACE_MS = 2 * 60_000

/** TREK_CAMPSITE_MINUTE_MS, read only when set (≥ 50 ms) */
function minuteFromEnv(): number {
  const v = Number(process.env.TREK_CAMPSITE_MINUTE_MS)
  return Number.isFinite(v) && v >= 50 ? v : 60_000
}

/** TREK_CAMPSITE_SEED_WOOD, read only when set: a finite number ≥ 0 */
export function seedWoodFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): number | undefined {
  const raw = env.TREK_CAMPSITE_SEED_WOOD
  if (raw === undefined || raw.trim() === '') return undefined
  const v = Number(raw)
  return Number.isFinite(v) && v >= 0 ? v : undefined
}
/**
 * TREK_CAMPSITE_FORCE_SIGHTINGS (test-only): '1' makes every minute roll a sighting, honoured only
 * with TREK_CAMPSITE_MINUTE_MS set too (the smokes set both), so it can't fill a real camp's guide alone
 */
export const forceSightingsFromEnv = (env: Readonly<Record<string, string | undefined>> = process.env): boolean =>
  env.TREK_CAMPSITE_FORCE_SIGHTINGS === '1' && (env.TREK_CAMPSITE_MINUTE_MS ?? '').trim() !== ''

/** A seeded camp's markers: enough for a cabin or the dock in a smoke */
const SEED_MARKERS = 3

const defaultSchedule = (fn: () => void, ms: number): { cancel(): void } => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}
const defaultInterval = (fn: () => void, ms: number): { clear(): void } => {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return { clear: () => clearInterval(timer) }
}

/** How many commits `to` is ahead of `from`, when it is a fast-forward of it; 0 otherwise */
async function countCommits(host: CampHost, e: Extract<ActivityEvent, { kind: 'worktree.head' }>): Promise<number> {
  const worktree = await host.checkedWorktree(e.projectId, e.worktreeId)
  try {
    await host.run('git', ['-C', worktree.path, 'merge-base', '--is-ancestor', e.from, e.to])
  } catch (err) {
    // `merge-base --is-ancestor` exits 1 when `from` is simply not an ancestor (a rewrite); anything else is a real failure
    if ((err as { exitCode?: number }).exitCode === 1) return 0
    throw err
  }
  const n = Number.parseInt((await host.run('git', ['-C', worktree.path, 'rev-list', '--count', `${e.from}..${e.to}`])).trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function createCampServer(host: CampHost, o: CampServerOptions = {}): PluginInstance {
  const now = o.now ?? Date.now
  const rules: Rules = { minuteMs: o.minuteMs ?? minuteFromEnv() }
  const schedule = o.schedule ?? defaultSchedule
  const seedWood = o.seedWood ?? seedWoodFromEnv()
  const rand = o.rand ?? Math.random
  const forceSightings = o.forceSightings ?? forceSightingsFromEnv()
  // Test-only: on a real camp it would fill the guide with a sighting every minute
  if (forceSightings) host.log.warn('[campsite] TREK_CAMPSITE_FORCE_SIGHTINGS is on: every minute roll is a sighting (test-only)')
  else if (o.forceSightings === undefined && process.env.TREK_CAMPSITE_FORCE_SIGHTINGS === '1') host.log.warn('[campsite] TREK_CAMPSITE_FORCE_SIGHTINGS is ignored without TREK_CAMPSITE_MINUTE_MS (test-only)')
  const store = openCampStore(host.dataFile('camp.json'), {
    now,
    seed: o.seed ?? (() => Math.floor(Math.random() * 2 ** 32)),
    warn: (m) => host.log.warn(m),
    schedule,
    rules,
    start: seedWood === undefined ? undefined : { wood: seedWood, markers: SEED_MARKERS }
  })
  const camp = store.camp
  const where = hostWhere(host)
  let disposed = false
  let lastEmit = -Infinity
  let lastJson = ''
  let pendingEmit: { cancel(): void } | null = null
  const warn = (what: string, err: unknown): void => host.log.warn(`[campsite] ${what}: ${err instanceof Error ? err.message : String(err)}`)
  const publish = (): void => {
    if (disposed || pendingEmit) return
    pendingEmit = schedule(() => {
      pendingEmit = null
      // A timer: a camp that can't be shown (or a push that fails) is logged, never thrown
      try {
        const snap = snapshot(camp, now(), where)
        const json = JSON.stringify(snap)
        if (json === lastJson) return
        lastJson = json
        lastEmit = now()
        host.emitAll('state', snap)
      } catch (err) {
        warn('publish', err)
      }
    }, Math.max(0, lastEmit + EMIT_EVERY_MS - now()))
  }
  const changed = (): void => {
    if (disposed) return
    store.changed()
    publish()
  }
  /** A request that would change the camp after dispose (its last save is done) */
  const open = (): void => {
    if (disposed) throw pluginError('CONFLICT', 'The camp is closing')
  }
  /** A purchase: refused with its code, or saved at once (it is final), pushed and answered with the new snapshot */
  const answer = (refusal: ShopRefusal | null): CampSnapshot => {
    if (refusal) throw pluginError(refusal.code, refusal.message)
    store.flush()
    publish()
    return snapshot(camp, now(), where)
  }

  /** The projects whose trails were reconciled this run (fully, or open-only before an event) */
  const reconciled = new Set<string>()
  /** The projects whose windows asked for the state or pinged seen this run: rolled for sightings with those the camp has heard from */
  const windows = new Set<string>()
  /** A window's project, kept only where the plugin is on (the id is the client's: an unknown one never grows the set) */
  const remember = (projectId: string): void => {
    try {
      if (host.isEnabled(projectId)) windows.add(projectId)
    } catch (err) {
      warn('sighting', err)
    }
  }
  const startedAt = now()
  /** Whether a full reconcile has run since start-up (the first tick after TRAIL_GRACE_MS) */
  let fullYet = false
  /** Full once the grace period is over (and its first full pass has run), else open-only */
  const mode = (): ReconcileMode => (fullYet ? 'full' : 'open-only')
  /** The first time this run a project is heard from, after the grace period (in it, the host's listing may be stale) */
  const firstHeard = (projectId: string): boolean => fullYet && !reconciled.has(projectId)
  /** A removed project's last activity, last species and noticeboard notes: dropped. Whether any was there */
  const forgetProject = (projectId: string): boolean => {
    const had = Object.hasOwn(camp.lastActive, projectId) || Object.hasOwn(camp.lastSeen, projectId) || Object.hasOwn(camp.notes, projectId)
    delete camp.lastActive[projectId]
    delete camp.lastSeen[projectId]
    delete camp.notes[projectId]
    return had
  }
  /**
   * A project's trails against the host's worktrees (no git refresh): a project that is gone
   * (NOT_FOUND) turns its trails back and drops its last activity, last species and notes (fully only); one where the plugin
   * is off is left as it is. True when a trail, the history, the done count, the last activity, species or notes changed.
   */
  const reconcileProject = (projectId: string, how: ReconcileMode = mode(), fresh?: Fresh): boolean => {
    let worktrees: PluginWorktree[] | null
    try {
      worktrees = host.worktrees(projectId)
    } catch (err) {
      if ((err as { code?: string }).code !== 'NOT_FOUND') {
        warn('reading the worktrees', err)
        return false
      }
      worktrees = null
    }
    if (worktrees !== null && !host.isEnabled(projectId)) return false
    if (worktrees === null && how === 'open-only') return false
    const before = JSON.stringify([camp.trails, camp.trailLog, camp.trailsDone])
    reconcile(camp, projectId, worktrees, now(), how, fresh)
    // A removed project's last activity, last species and notes go with it (nothing reads them again)
    const forgot = worktrees === null && forgetProject(projectId)
    if (worktrees === null) reconciled.delete(projectId)
    else reconciled.add(projectId)
    return forgot || JSON.stringify([camp.trails, camp.trailLog, camp.trailsDone]) !== before
  }
  /** Every project with trails, and every one reconciled this run; then (fully) the last activity, species and notes of the other projects that are gone. True when a trail, the history, the done count, a last activity or notes changed */
  const reconcileAll = (how: ReconcileMode = mode()): boolean => {
    let any = false
    const projects = new Set([...trailProjects(camp), ...reconciled])
    for (const projectId of projects) if (reconcileProject(projectId, how)) any = true
    if (how !== 'full') return any
    for (const projectId of new Set([...Object.keys(camp.lastActive), ...Object.keys(camp.lastSeen), ...Object.keys(camp.notes)])) {
      if (projects.has(projectId)) continue
      try {
        host.worktrees(projectId)
      } catch (err) {
        if ((err as { code?: string }).code !== 'NOT_FOUND') {
          warn('reading the worktrees', err)
          continue
        }
        if (forgetProject(projectId)) any = true
      }
    }
    return any
  }

  /** Sessions that are gone without a `session.closed` (a project, repo or worktree removed; the plugin off in their project) stop earning and free their members */
  const prune = (): void => {
    const projects = new Map<string, string>()
    for (const [id, a] of Object.entries(camp.assignments)) projects.set(id, a.project)
    for (const [id, s] of Object.entries(camp.spans)) projects.set(id, s.project)
    for (const [id, w] of Object.entries(camp.waiting)) projects.set(id, w.project)
    // `worked` has no project: a count is dropped once nothing else holds its session
    for (const id of Object.keys(camp.worked)) if (!projects.has(id)) delete camp.worked[id]
    for (const [terminalId, project] of projects) {
      try {
        if (!host.isEnabled(project)) forget(camp, terminalId, now())
        else host.session(project, terminalId)
      } catch (err) {
        if ((err as { code?: string }).code === 'NOT_FOUND') forget(camp, terminalId, now())
      }
    }
  }

  /** Each session's latest tool call (part 4), with its project: in memory only */
  const tools = new Map<string, ToolNote & { projectId: string }>()
  /** `tool` to the project's windows: a session's latest call, or null when it went */
  const sendTool = (projectId: string, terminalId: string, tool: ToolNote | null): void => {
    try {
      host.emit(projectId, 'tool', { terminalId, tool })
    } catch (err) {
      warn('tool', err)
    }
  }
  const dropTool = (terminalId: string): void => {
    const had = tools.get(terminalId)
    if (!had) return
    tools.delete(terminalId)
    sendTool(had.projectId, terminalId, null)
  }
  const toolsOf = (projectId: string): ToolAges => {
    const out: ToolAges = {}
    for (const [terminalId, t] of tools) if (t.projectId === projectId) out[terminalId] = { kind: t.kind, label: t.label, age: Math.max(0, now() - t.at) }
    return out
  }

  /** Each session's project, worktree and agent as the activity feed last said (part 5: who left a note): in memory only */
  const sessionFacts = new Map<string, { projectId: string; worktreeId: string | null; provider: string }>()

  const off = host.onActivity((e) => {
    if (e.kind.startsWith('session.')) {
      const s = e as Extract<ActivityEvent, { terminalId: string }>
      if (s.kind === 'session.closed') sessionFacts.delete(s.terminalId)
      else sessionFacts.set(s.terminalId, { projectId: s.projectId, worktreeId: s.worktreeId, provider: s.provider })
    }
    // A tool call is the hiker's chore only: not the camp's (no pay, no last activity, no save)
    if (e.kind === 'session.tool') {
      if (disposed) return
      const tool: ToolNote = { kind: e.tool.kind, label: e.tool.label, at: now() }
      tools.set(e.terminalId, { ...tool, projectId: e.projectId })
      sendTool(e.projectId, e.terminalId, tool)
      return
    }
    // A new run of the agent, or no agent running: its last tool call goes
    if (e.kind === 'session.started' || e.kind === 'session.stopped' || e.kind === 'session.closed' || (e.kind === 'session.status' && e.to === 'exited')) dropTool(e.terminalId)
    try {
      // The first word from a project this run (after the grace period): its trails exist before the event moves them
      if (firstHeard(e.projectId)) reconcileProject(e.projectId, 'full')
      // A commit or a pull request's event (it comes after the poller's refresh, so the listing is
      // fresh, even in the grace period): a worktree made outside Trek (no worktree.created) has its
      // trail before the event moves it; a commit vouches for its worktree's branch, so one summited
      // on another branch starts its new trail
      else if (e.kind === 'worktree.head' || e.kind.startsWith('pr.')) reconcileProject(e.projectId, 'open-only', freshOf(e))
      const paid = applyActivity(camp, e, now(), rules, where)
      // A worktree event: the worktrees changed, so the trails follow (none in the grace period)
      if (fullYet && e.kind.startsWith('worktree.')) reconcileProject(e.projectId, 'full')
      changed()
      if (e.kind === 'pr.ended' && e.result === 'merged' && paid.some((r) => r.key === `merged:${e.url}`)) {
        for (const t of trailsOn(camp, e)) if (t.stage === SUMMIT) host.emitAll('summit', { projectId: t.projectId, worktreeId: t.worktreeId, branch: t.branch })
      }
    } catch (err) {
      warn(e.kind, err)
    }
    if (e.kind === 'worktree.head') {
      countCommits(host, e)
        .then((count) => {
          if (disposed || count === 0) return
          applyCommits(camp, { worktreeId: e.worktreeId, head: e.to, count }, now())
          changed()
        })
        .catch((err: unknown) => {
          if (disposed) return
          warn('counting commits', err)
        })
    }
  })

  /** What camp.json would hold, less the clocks: lastTick need not be saved (a restart starts it again; nobody waits across one) */
  const saved = (): string => JSON.stringify({ ...camp, lastTick: 0, savedAt: 0 })

  // No reconcile at start-up: camp.json holds the open trails, and the host's saved listing may be
  // stale (a trail that already ended would open again, and end again into the history). The first
  // tick after the grace period reconciles fully, and then every 10 minutes.
  let trailsAt = now()

  /** Each known project's minute roll (where the plugin is on): its sightings, logged in the camp; sent after the camp is marked changed. One project's failure is logged and skips only its own roll */
  const rollSightings = (): { projectId: string; species: string; at: number }[] => {
    const out: { projectId: string; species: string; at: number }[] = []
    for (const projectId of new Set([...Object.keys(camp.lastActive), ...windows])) {
      try {
        if (!host.isEnabled(projectId)) continue
        const t = now()
        const id = rollSighting(camp, projectId, t, rand, { open: host.subscriberCount(projectId) > 0, force: forceSightings })
        if (id !== null) out.push({ projectId, species: id, at: t })
      } catch (err) {
        warn('sighting', err)
      }
    }
    return out
  }

  // The first tick prunes (and the camp starts out as restored, with no open spans). Saved only when
  // something saved changed (paid minutes, cooling, a prune, an hour's caps dropped, a trail), and every
  // minute while a span is open, so a restart closes it near where it was; otherwise not rewritten.
  const ticker = (o.interval ?? defaultInterval)(() => {
    try {
      const before = saved()
      prune()
      // A session gone without a word (its project, repo or worktree removed; the plugin off there) drops its tool call and its facts
      for (const [terminalId, t] of [...tools]) {
        try {
          if (!host.isEnabled(t.projectId)) dropTool(terminalId)
          else host.session(t.projectId, terminalId)
        } catch (err) {
          if ((err as { code?: string }).code === 'NOT_FOUND') dropTool(terminalId)
        }
      }
      for (const [terminalId, f] of [...sessionFacts]) {
        try {
          if (!host.isEnabled(f.projectId)) sessionFacts.delete(terminalId)
          else host.session(f.projectId, terminalId)
        } catch (err) {
          if ((err as { code?: string }).code === 'NOT_FOUND') sessionFacts.delete(terminalId)
        }
      }
      tick(camp, now(), rules)
      if (fullYet ? now() - trailsAt >= TRAIL_EVERY_MS : now() - startedAt >= TRAIL_GRACE_MS) {
        fullYet = true
        trailsAt = now()
        reconcileAll('full')
      }
      const sightings = rollSightings()
      if (Object.keys(camp.spans).length > 0 || saved() !== before) changed()
      // Time alone can change the snapshot (the away card falling due, its hours, a new day's
      // walk-ins): pushed (publish skips an unchanged one), not saved
      else publish()
      // To that project's windows only, from the left or the right edge; the snapshot (its guide) follows as usual
      for (const s of sightings) host.emit(s.projectId, 'sighting', { ...s, dir: rand() < 0.5 ? 'left' : 'right' })
    } catch (err) {
      warn('tick', err)
    }
  }, rules.minuteMs)

  /** A refusal as the tool's error result */
  const refuse = (r: ShopRefusal): never => {
    throw pluginError(r.code, r.message)
  }
  /**
   * The session `terminalId` names in the project (host.session throws for none, or another
   * project's): Global or not, its worktree and agent as the activity feed last said (unknown: null
   * and ''), its worktree's branch (or folder; "Global") and its member's name
   */
  const whoIs = (projectId: string, terminalId: unknown): { terminalId: string; global: boolean; worktreeId: string | null; agent: string; branch: string | undefined; member: string | undefined } => {
    const found = host.session(projectId, terminalId)
    const id = terminalId as string
    const heard = sessionFacts.get(id)
    const facts = heard?.projectId === projectId ? heard : null
    const worktreeId = found.global ? null : (facts?.worktreeId ?? null)
    let branch: string | undefined = found.global ? 'Global' : undefined
    if (worktreeId !== null) {
      const w = where.worktree(projectId, worktreeId)
      if (w) branch = w.branch ?? w.name
    }
    return { terminalId: id, global: found.global, worktreeId, agent: facts?.provider ?? '', branch, member: memberOf(camp, id)?.name }
  }
  /** One post a minute per key, or the tool's error result */
  const posts = new Map<string, number>()
  const limit = (key: string, what: 'note' | 'report'): void => {
    if (!takePost(posts, key, now())) throw pluginError('CONFLICT', `Please wait a minute before the next ${what}.`)
  }
  const optional = (x: unknown): boolean => x === undefined || x === null

  const mcpTools: PluginMcpTool[] = [
    {
      definition: CAMP_NOTE_TOOL,
      call: (args, ctx) => {
        open()
        const text = cleanText(args.text, NOTE_MAX, 'note')
        if (typeof text !== 'string') return refuse(text)
        const who = optional(args.terminalId) ? null : whoIs(ctx.projectId, args.terminalId)
        limit(who ? `note:session:${who.terminalId}` : `note:project:${ctx.projectId}`, 'note')
        const pinned = addNote(camp, ctx.projectId, {
          text,
          at: now(),
          ...(who?.agent ? { agent: who.agent } : {}),
          ...(who?.branch ? { branch: who.branch } : {}),
          ...(who?.member ? { member: who.member } : {})
        })
        // Saved at once, like a purchase; the snapshot's newest-note time follows
        store.flush()
        publish()
        const event: NoteEvent = { projectId: ctx.projectId, note: { ...pinned } }
        host.emit(ctx.projectId, 'note', event)
        return 'Pinned to the noticeboard.'
      }
    },
    {
      definition: CAMP_TRAIL_REPORT_TOOL,
      call: (args, ctx) => {
        open()
        const summary = cleanText(args.summary, REPORT_MAX, 'summary')
        if (typeof summary !== 'string') return refuse(summary)
        const who = optional(args.terminalId) ? null : whoIs(ctx.projectId, args.terminalId)
        if (who?.global) throw pluginError('BAD_REQUEST', 'This session has no trail (Global); leave a camp_note instead.')
        const worktreeId = who?.worktreeId ?? (typeof args.worktreeId === 'string' && args.worktreeId !== '' ? args.worktreeId : null)
        if (worktreeId === null) {
          throw pluginError('BAD_REQUEST', who ? "Trek can't tell this session's worktree yet; pass worktreeId too." : 'Pass terminalId (your $TREK_TERMINAL_ID) or worktreeId.')
        }
        const key = trailKey(ctx.projectId, worktreeId)
        if (!Object.hasOwn(camp.trails, key)) throw pluginError('NOT_FOUND', 'That worktree has no trail.')
        limit(`report:${key}`, 'report')
        const at = now()
        const by = who ? whoLine(who.agent || undefined, who.member) : ''
        const trail = postReport(camp, ctx.projectId, worktreeId, { summary, at, ...(by ? { by } : {}) })
        if ('code' in trail) return refuse(trail)
        const member = who ? memberOf(camp, who.terminalId) : undefined
        if (member) note(member, { kind: 'report', at, branch: trail.branch, summary })
        store.flush()
        publish()
        return `Report posted on ${trail.branch}.`
      }
    }
  ]

  return {
    mcpTools,
    mcpInstructions: CAMP_MCP_INSTRUCTIONS,
    handlers: {
      // A window naming its project (part 3c): its trails are reconciled the first time this run (after the grace period)
      state: (_params, ctx) => {
        if (!disposed && ctx?.projectId !== undefined) remember(ctx.projectId)
        if (!disposed && ctx?.projectId !== undefined && firstHeard(ctx.projectId)) {
          try {
            if (reconcileProject(ctx.projectId)) changed()
          } catch (err) {
            warn('trails', err)
          }
        }
        const snap = snapshot(camp, now(), where)
        // The window's project's tool calls (part 4) ride on its answer only: the pushed state goes to every project
        return ctx?.projectId === undefined || disposed ? snap : { ...snap, tools: toolsOf(ctx.projectId) }
      },
      build: (params) => {
        open()
        return answer(build(camp, params))
      },
      recruit: (params) => {
        open()
        return answer(recruit(camp, params, now()))
      },
      gear: (params) => {
        open()
        return answer(buyGear(camp, params, now()))
      },
      pin: (params) => {
        open()
        return answer(pinMember(camp, params, now()))
      },
      // A member's journal (part 3b): not in the pushed snapshot; a member view asks while it is open
      journal: (params) => {
        const out = journalOf(camp, params)
        if ('code' in out) throw pluginError(out.code, out.message)
        return out
      },
      // A project's ended trails (part 3c), and its open trails' reports (part 5): not in the pushed snapshot; the Trails tab asks
      trailLog: (params) => {
        const out = trailLogOf(camp, params)
        if ('code' in out) throw pluginError(out.code, out.message)
        return out
      },
      // A project's noticeboard (part 5): not in the pushed snapshot (its newest note's time is); the Noticeboard asks
      notes: (params) => {
        const out = notesOf(camp, params)
        if ('code' in out) throw pluginError(out.code, out.message)
        return out
      },
      // A visible window saw the camp; its time zone and Seasons setting (part 3d-2) gate the wildlife
      seen: (params, ctx) => {
        open()
        if (ctx?.projectId !== undefined) remember(ctx.projectId)
        const clock = setClock(camp, params)
        if (seen(camp, now()) || clock) changed()
        return { ok: true }
      },
      awaySeen: () => {
        open()
        awaySeen(camp, now())
        changed()
        return { ok: true }
      }
    },
    dispose: () => {
      disposed = true
      off()
      tools.clear()
      sessionFacts.clear()
      ticker.clear()
      pendingEmit?.cancel()
      store.dispose()
    }
  }
}
