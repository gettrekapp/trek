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
// trails' checks it is pushed for the windows' weather. New commits are counted with git (fast-forward only). Nothing here can stop the server:
// errors are logged and pay nothing.
import { basename } from 'node:path'
import type { ActivityEvent } from '../../../src/shared/plugins/activity.ts'
import { pluginError, type PluginInstance, type PluginWorktree, type ServerPluginHost } from '../../../src/shared/plugins/server.ts'
import { awaySeen, seen } from '../shared/away.ts'
import { snapshot, type CampSnapshot } from '../shared/camp.ts'
import { journalOf, pinMember, type Where } from '../shared/crew.ts'
import { applyActivity, applyCommits, forget, tick, type Rules } from '../shared/economy.ts'
import { build, buyGear, recruit, type ShopRefusal } from '../shared/shop.ts'
import { SUMMIT, freshOf, reconcile, trailLogOf, trailProjects, trailsOn, type Fresh, type ReconcileMode } from '../shared/trails.ts'
import { openCampStore } from './store.ts'

export type CampHost = Pick<ServerPluginHost, 'dataFile' | 'onActivity' | 'emitAll' | 'session' | 'checkedWorktree' | 'run' | 'log' | 'isEnabled' | 'projectName' | 'worktree' | 'worktrees'>

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
}

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
  const startedAt = now()
  /** Whether a full reconcile has run since start-up (the first tick after TRAIL_GRACE_MS) */
  let fullYet = false
  /** Full once the grace period is over (and its first full pass has run), else open-only */
  const mode = (): ReconcileMode => (fullYet ? 'full' : 'open-only')
  /** The first time this run a project is heard from, after the grace period (in it, the host's listing may be stale) */
  const firstHeard = (projectId: string): boolean => fullYet && !reconciled.has(projectId)
  /**
   * A project's trails against the host's worktrees (no git refresh): a project that is gone
   * (NOT_FOUND) turns its trails back (fully only); one where the plugin is off is left as it is. True
   * when a trail, the history or the done count changed.
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
    if (worktrees === null) reconciled.delete(projectId)
    else reconciled.add(projectId)
    return JSON.stringify([camp.trails, camp.trailLog, camp.trailsDone]) !== before
  }
  /** Every project with trails, and every one reconciled this run; true when a trail, the history or the done count changed */
  const reconcileAll = (how: ReconcileMode = mode()): boolean => {
    let any = false
    for (const projectId of new Set([...trailProjects(camp), ...reconciled])) if (reconcileProject(projectId, how)) any = true
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

  const off = host.onActivity((e) => {
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

  // The first tick prunes (and the camp starts out as restored, with no open spans). Saved only when
  // something saved changed (paid minutes, cooling, a prune, an hour's caps dropped, a trail), and every
  // minute while a span is open, so a restart closes it near where it was; otherwise not rewritten.
  const ticker = (o.interval ?? defaultInterval)(() => {
    try {
      const before = saved()
      prune()
      tick(camp, now(), rules)
      if (fullYet ? now() - trailsAt >= TRAIL_EVERY_MS : now() - startedAt >= TRAIL_GRACE_MS) {
        fullYet = true
        trailsAt = now()
        reconcileAll('full')
      }
      if (Object.keys(camp.spans).length > 0 || saved() !== before) changed()
      // Time alone can change the snapshot (the away card falling due, its hours, a new day's
      // walk-ins): pushed (publish skips an unchanged one), not saved
      else publish()
    } catch (err) {
      warn('tick', err)
    }
  }, rules.minuteMs)

  return {
    handlers: {
      // A window naming its project (part 3c): its trails are reconciled the first time this run (after the grace period)
      state: (_params, ctx) => {
        if (!disposed && ctx?.projectId !== undefined && firstHeard(ctx.projectId)) {
          try {
            if (reconcileProject(ctx.projectId)) changed()
          } catch (err) {
            warn('trails', err)
          }
        }
        return snapshot(camp, now(), where)
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
      // A project's ended trails (part 3c): not in the pushed snapshot; the Trails tab asks
      trailLog: (params) => {
        const out = trailLogOf(camp, params)
        if ('code' in out) throw pluginError(out.code, out.message)
        return out
      },
      seen: () => {
        open()
        if (seen(camp, now())) changed()
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
      ticker.clear()
      pendingEmit?.cancel()
      store.dispose()
    }
  }
}
