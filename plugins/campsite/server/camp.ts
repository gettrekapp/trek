// The campsite's server half (campsite part 2): core's activity feed in, through the reward rules,
// into camp.json; `state` answers the snapshot and every change is sent to every project's windows
// (throttled to once a second). A minute tick pays working minutes, cools the fire and forgets
// sessions that are gone. New commits are counted with git (fast-forward only). Nothing here can
// stop the server: errors are logged and pay nothing.
import type { ActivityEvent } from '../../../src/shared/plugins/activity.ts'
import type { PluginInstance, ServerPluginHost } from '../../../src/shared/plugins/server.ts'
import { snapshot } from '../shared/camp.ts'
import { applyActivity, applyCommits, forget, tick, type Rules } from '../shared/economy.ts'
import { openCampStore } from './store.ts'

export type CampHost = Pick<ServerPluginHost, 'dataFile' | 'onActivity' | 'emitAll' | 'session' | 'checkedWorktree' | 'run' | 'log' | 'isEnabled'>

export interface CampServerOptions {
  now?: () => number
  seed?: () => number
  /** A working minute; default TREK_CAMPSITE_MINUTE_MS when set (tests, smokes), else 60 s */
  minuteMs?: number
  schedule?: (fn: () => void, ms: number) => { cancel(): void }
  interval?: (fn: () => void, ms: number) => { clear(): void }
}

const EMIT_EVERY_MS = 1000

/** TREK_CAMPSITE_MINUTE_MS, read only when set (≥ 50 ms) */
function minuteFromEnv(): number {
  const v = Number(process.env.TREK_CAMPSITE_MINUTE_MS)
  return Number.isFinite(v) && v >= 50 ? v : 60_000
}

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
    // git says nothing when `from` is simply not an ancestor (a rewrite); anything else is a real failure
    if (err instanceof Error && err.message !== '') throw err
    return 0
  }
  const n = Number.parseInt((await host.run('git', ['-C', worktree.path, 'rev-list', '--count', `${e.from}..${e.to}`])).trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function createCampServer(host: CampHost, o: CampServerOptions = {}): PluginInstance {
  const now = o.now ?? Date.now
  const rules: Rules = { minuteMs: o.minuteMs ?? minuteFromEnv() }
  const schedule = o.schedule ?? defaultSchedule
  const store = openCampStore(host.dataFile('camp.json'), {
    now,
    seed: o.seed ?? (() => Math.floor(Math.random() * 2 ** 32)),
    warn: (m) => host.log.warn(m),
    schedule,
    rules
  })
  const camp = store.camp
  let disposed = false
  let lastEmit = -Infinity
  let lastJson = ''
  let pendingEmit: { cancel(): void } | null = null
  const publish = (): void => {
    if (disposed || pendingEmit) return
    pendingEmit = schedule(() => {
      pendingEmit = null
      const snap = snapshot(camp)
      const json = JSON.stringify(snap)
      if (json === lastJson) return
      lastJson = json
      lastEmit = now()
      host.emitAll('state', snap)
    }, Math.max(0, lastEmit + EMIT_EVERY_MS - now()))
  }
  const changed = (): void => {
    if (disposed) return
    store.changed()
    publish()
  }
  const warn = (what: string, err: unknown): void => host.log.warn(`[campsite] ${what}: ${err instanceof Error ? err.message : String(err)}`)

  /** Sessions that are gone without a `session.closed` (a project, repo or worktree removed; the plugin off in their project) stop earning and free their members */
  const prune = (): void => {
    const projects = new Map<string, string>()
    for (const [id, a] of Object.entries(camp.assignments)) projects.set(id, a.project)
    for (const [id, s] of Object.entries(camp.spans)) projects.set(id, s.project)
    for (const [id, w] of Object.entries(camp.waiting)) projects.set(id, w.project)
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
      applyActivity(camp, e, now(), rules)
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
        .catch((err: unknown) => warn('counting commits', err))
    }
  })

  // No prune at start: projects may not be loaded yet, and the tick retries
  const ticker = (o.interval ?? defaultInterval)(() => {
    try {
      prune()
      tick(camp, now(), rules)
      changed()
    } catch (err) {
      warn('tick', err)
    }
  }, rules.minuteMs)

  return {
    handlers: { state: () => snapshot(camp) },
    dispose: () => {
      disposed = true
      off()
      ticker.clear()
      pendingEmit?.cancel()
      store.dispose()
    }
  }
}
