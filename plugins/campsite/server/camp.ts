// The campsite's server half (campsite part 2): core's activity feed in, through the reward rules,
// into camp.json; `state` answers the snapshot and every change is sent to every project's windows
// (throttled to once a second). The shop's handlers (part 3a) build a building's next tier and hire a
// walk-in; seen and awaySeen keep the "While you were away" card; gear and pin (part 3b) buy a
// member's next item and pin it to a kind of session, and journal answers a member's journal (not
// pushed with the snapshot). The host names projects and worktrees for the
// crew's journals. A minute tick pays working minutes, cools the fire and forgets sessions that are
// gone. New commits are counted with git (fast-forward only). Nothing here can stop the server:
// errors are logged and pay nothing.
import { basename } from 'node:path'
import type { ActivityEvent } from '../../../src/shared/plugins/activity.ts'
import { pluginError, type PluginInstance, type ServerPluginHost } from '../../../src/shared/plugins/server.ts'
import { awaySeen, seen } from '../shared/away.ts'
import { snapshot, type CampSnapshot } from '../shared/camp.ts'
import { journalOf, pinMember, type Where } from '../shared/crew.ts'
import { applyActivity, applyCommits, forget, tick, type Rules } from '../shared/economy.ts'
import { build, buyGear, recruit, type ShopRefusal } from '../shared/shop.ts'
import { openCampStore } from './store.ts'

export type CampHost = Pick<ServerPluginHost, 'dataFile' | 'onActivity' | 'emitAll' | 'session' | 'checkedWorktree' | 'run' | 'log' | 'isEnabled' | 'projectName' | 'worktree'>

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
        const snap = snapshot(camp, now())
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
    return snapshot(camp, now())
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
      applyActivity(camp, e, now(), rules, where)
      changed()
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

  // The first tick prunes (and the camp starts out as restored, with no open spans). Saved only when
  // something saved changed (paid minutes, cooling, a prune, an hour's caps dropped), and every
  // minute while a span is open, so a restart closes it near where it was; otherwise not rewritten.
  const ticker = (o.interval ?? defaultInterval)(() => {
    try {
      const before = saved()
      prune()
      tick(camp, now(), rules)
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
      state: () => snapshot(camp, now()),
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
