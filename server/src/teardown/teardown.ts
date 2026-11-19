// Worktree teardown on the server (plugins E1): before a worktree is removed, promoted or moved,
// the participants (core's dev stack and Colima VM, participants.ts, and each plugin on in the
// project with a worktreeLifecycle) say what they would tear down (`worktree.teardownPlan`), and the
// request that does the operation runs the items the client chose, in participant order, before it.
// A participant whose plan throws or takes over TEARDOWN_PLAN_TIMEOUT_MS is left out (logged); one
// whose teardown throws stops the operation: TOOL_ERROR, `details.reason: 'teardown'`, naming it.
import type { Project, Repository, Worktree } from '../../../src/shared/model/types'
import type { PluginCallContext } from '../../../src/shared/plugins/server.ts'
import { WORKTREE_OPS, type TeardownItem, type WorktreeOp } from '../../../src/shared/teardown.ts'
import { codedError } from '../errors.ts'
import type { PluginLifecycle } from '../plugins/registry.ts'
import { pluginRepo, pluginWorktree } from '../plugins/worktrees.ts'

export const TEARDOWN_PLAN_TIMEOUT_MS = 10_000
/** At most this many ids in a request's `teardown` */
export const MAX_TEARDOWN_IDS = 50
const ITEM_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_LABEL = 200

export interface TeardownTarget {
  project: Project
  repo: Repository
  worktree: Worktree
}

/** One participant; its items' ids are `<id>:<item>` on the wire. */
export interface Participant {
  id: string
  plan(target: TeardownTarget, op: WorktreeOp): Promise<TeardownItem[]>
  /** Its own (un-namespaced) ids */
  teardown(target: TeardownTarget, op: WorktreeOp, ids: readonly string[]): Promise<void>
  beforeRepoRemove?(project: Project, repo: Repository): Promise<string | null>
}

export interface TeardownOptions {
  timeoutMs?: number
  warn?: (message: string) => void
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const warnOf = (options: TeardownOptions): ((message: string) => void) => options.warn ?? ((message) => console.warn(message))

/** A plugin's lifecycle as a participant: its hooks get the plugin's call context and the worktree, read only. */
export function pluginParticipant(entry: PluginLifecycle, caller: string): Participant {
  const ctx = (projectId: string): PluginCallContext => ({ projectId, caller })
  const { lifecycle } = entry
  const beforeRepoRemove = lifecycle.beforeRepoRemove?.bind(lifecycle)
  return {
    id: entry.id,
    plan: async (t, op) => lifecycle.plan(ctx(t.project.id), pluginWorktree(t.repo, t.worktree), op),
    teardown: async (t, op, ids) => lifecycle.teardown(ctx(t.project.id), pluginWorktree(t.repo, t.worktree), op, ids),
    ...(beforeRepoRemove ? { beforeRepoRemove: async (project: Project, repo: Repository) => beforeRepoRemove(ctx(project.id), pluginRepo(repo)) } : {})
  }
}

/** A request's `op`. */
export function requireOp(value: unknown): WorktreeOp {
  if (!(WORKTREE_OPS as readonly unknown[]).includes(value)) throw codedError('BAD_REQUEST', `op must be one of ${WORKTREE_OPS.join(', ')}`)
  return value as WorktreeOp
}

/** A request's optional `teardown`: the ids, once each. Absent is none: nothing is torn down (what an older client expects). */
export function optionalTeardown(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_TEARDOWN_IDS || value.some((v) => typeof v !== 'string' || v.length === 0 || v.length > 200)) {
    throw codedError('BAD_REQUEST', `teardown must be an array of at most ${MAX_TEARDOWN_IDS} item ids`)
  }
  return [...new Set(value as string[])]
}

/** `work`, or a rejection after `ms`. The timer is not unref'd: the caller is waiting on it (it is cleared once settled). */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** A participant's answer, checked: a bad item is dropped (logged); ids namespaced. */
function checkedItems(participant: Participant, raw: unknown, warn: (message: string) => void): TeardownItem[] {
  if (!Array.isArray(raw)) {
    warn(`[teardown] ${participant.id}'s plan is not a list; left out`)
    return []
  }
  const seen = new Set<string>()
  const out: TeardownItem[] = []
  for (const item of raw as unknown[]) {
    const i = item as Partial<TeardownItem> | null
    const ok =
      !!i && typeof i.id === 'string' && ITEM_ID_RE.test(i.id) && !seen.has(i.id) &&
      typeof i.label === 'string' && i.label.trim() !== '' && i.label.length <= MAX_LABEL && typeof i.checked === 'boolean'
    if (!ok) {
      warn(`[teardown] ${participant.id}: a plan item was left out: ${String(JSON.stringify(item)).slice(0, 200)}`)
      continue
    }
    seen.add(i.id!)
    out.push({ id: `${participant.id}:${i.id}`, label: i.label!.trim(), checked: i.checked! })
  }
  return out
}

/** Every participant's items, in participant order (asked at once). */
export async function planTeardown(participants: readonly Participant[], target: TeardownTarget, op: WorktreeOp, options: TeardownOptions = {}): Promise<TeardownItem[]> {
  const warn = warnOf(options)
  const timeoutMs = options.timeoutMs ?? TEARDOWN_PLAN_TIMEOUT_MS
  const plans = await Promise.all(
    participants.map(async (p) => {
      try {
        return checkedItems(p, await withTimeout(Promise.resolve().then(() => p.plan(target, op)), timeoutMs), warn)
      } catch (err) {
        warn(`[teardown] ${p.id}'s plan was left out: ${messageOf(err)}`)
        return []
      }
    })
  )
  return plans.flat()
}

/**
 * Runs the chosen items before the operation: each participant once, with its own ids, in
 * participant order. An id whose participant is not here is BAD_REQUEST before anything runs; one
 * its participant no longer plans (the VM was deleted meanwhile) is skipped. A throw stops it.
 */
export async function runTeardown(participants: readonly Participant[], target: TeardownTarget, op: WorktreeOp, ids: readonly string[], options: TeardownOptions = {}): Promise<void> {
  if (ids.length === 0) return
  const warn = warnOf(options)
  const known = new Set(participants.map((p) => p.id))
  for (const id of ids) {
    const at = id.indexOf(':')
    if (at <= 0 || !known.has(id.slice(0, at))) throw codedError('BAD_REQUEST', `unknown teardown item ${JSON.stringify(id)}`)
  }
  const involved = participants.filter((p) => ids.some((id) => id.startsWith(`${p.id}:`)))
  const planned = new Map((await planTeardown(involved, target, op, options)).map((item) => [item.id, item]))
  for (const p of involved) {
    const mine = ids.filter((id) => id.startsWith(`${p.id}:`))
    for (const gone of mine.filter((id) => !planned.has(id))) warn(`[teardown] ${gone} is no longer planned for ${target.worktree.path}; skipped`)
    const now = mine.filter((id) => planned.has(id))
    if (now.length === 0) continue
    try {
      await p.teardown(target, op, now.map((id) => id.slice(p.id.length + 1)))
    } catch (err) {
      const what = now.map((id) => planned.get(id)!.label).join('; ')
      throw codedError('TOOL_ERROR', `Couldn't ${what.charAt(0).toLowerCase()}${what.slice(1)}: ${messageOf(err)}`, { reason: 'teardown' })
    }
  }
}

/** The first participant's reason the repository can't leave its project now, or null. A check that fails or hangs refuses too. */
export async function repoRemoveVeto(participants: readonly Participant[], project: Project, repo: Repository, options: TeardownOptions = {}): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? TEARDOWN_PLAN_TIMEOUT_MS
  for (const p of participants) {
    const check = p.beforeRepoRemove
    if (!check) continue
    let reason: string | null
    try {
      reason = await withTimeout(Promise.resolve().then(() => check(project, repo)), timeoutMs)
    } catch (err) {
      return `${p.id} could not check it: ${messageOf(err)}`
    }
    if (typeof reason === 'string' && reason.trim() !== '') return reason.trim()
  }
  return null
}
