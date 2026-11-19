// Worktree teardown on the server (plugins E1): before a worktree is removed, promoted or moved,
// the participants (core's dev stack and Colima VM, participants.ts, and each plugin on in the
// project with a worktreeLifecycle) say what they would tear down (`worktree.teardownPlan`), and the
// request that does the operation runs the items the client chose, in participant order, before it.
// A participant whose plan throws or takes over TEARDOWN_PLAN_TIMEOUT_MS is left out (logged); one
// whose teardown throws, or runs past the whole teardown's deadline (TEARDOWN_RUN_TIMEOUT_MS, shared
// by the participants), stops the operation: TOOL_ERROR, `details.reason: 'teardown'`, naming it.
// At the run, a chosen participant whose re-check fails stops it too, before anything is torn down.
import type { Project, Repository, Worktree } from '../../../src/shared/model/types'
import type { PluginCallContext } from '../../../src/shared/plugins/server.ts'
import { TEARDOWN_REQUEST_TIMEOUT_MS, WORKTREE_OPS, type TeardownItem, type WorktreeOp } from '../../../src/shared/teardown.ts'
import { codedError } from '../errors.ts'
import type { PluginLifecycle } from '../plugins/registry.ts'
import { pluginRepo, pluginWorktree } from '../plugins/worktrees.ts'
import { realOrResolved } from '../repos.ts'

export const TEARDOWN_PLAN_TIMEOUT_MS = 10_000
/**
 * How long a whole teardown may take, all its participants together: a minute under the clients'
 * wait for the request (TEARDOWN_REQUEST_TIMEOUT_MS), whose clock starts first and which still has
 * the operation itself to do, so a slow teardown fails here, naming it, not as the client's TIMEOUT.
 */
export const TEARDOWN_RUN_TIMEOUT_MS = TEARDOWN_REQUEST_TIMEOUT_MS - 60_000
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
  /** Why the repository can't leave its project now; null (or undefined) for no veto */
  beforeRepoRemove?(project: Project, repo: Repository): Promise<string | null | undefined>
}

export interface TeardownOptions {
  /** A plan's (and a repository check's) limit; TEARDOWN_PLAN_TIMEOUT_MS */
  timeoutMs?: number
  /** The whole teardown's limit, shared by its participants (each gets what is left); TEARDOWN_RUN_TIMEOUT_MS */
  teardownTimeoutMs?: number
  /** runTeardown inside holdWorktree: the hold, so the teardown runs under it (else it holds the worktree itself) */
  hold?: WorktreeHold
  /** runTeardown: participants that are known but not taking part (a plugin now off in the project); their ids are skipped, not refused */
  inactive?: Iterable<string>
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

/** `ms` in seconds for a message: whole seconds from 10 s up, else to two places ("0.05"). */
const seconds = (ms: number): string => (ms >= 10_000 ? String(Math.round(ms / 1000)) : String(Math.round(ms / 10) / 100))

/** `work`, or a rejection after `ms`. The timer is not unref'd: the caller is waiting on it (it is cleared once settled). */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${seconds(ms)} s`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** Two participants under one id would mix their items: core's wiring is wrong. */
function requireDistinct(participants: readonly Participant[]): void {
  const ids = new Set<string>()
  for (const p of participants) {
    if (ids.has(p.id)) throw new Error(`teardown participant ${JSON.stringify(p.id)} is listed twice`)
    ids.add(p.id)
  }
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
      typeof i.label === 'string' && i.label.trim() !== '' && i.label.length <= MAX_LABEL && typeof i.checked === 'boolean' &&
      (i.running === undefined || typeof i.running === 'boolean')
    if (!ok) {
      warn(`[teardown] ${participant.id}: a plan item was left out: ${String(JSON.stringify(item)).slice(0, 200)}`)
      continue
    }
    seen.add(i.id!)
    out.push({ id: `${participant.id}:${i.id}`, label: i.label!.trim(), checked: i.checked!, ...(i.running === true ? { running: true } : {}) })
  }
  return out
}

/** One participant's plan: its checked items, or why it gave none (a throw, or no answer in time). */
type PlanResult = { items: TeardownItem[] } | { error: string }

/** Each participant's plan, asked at once, in participant order. */
async function planEach(participants: readonly Participant[], target: TeardownTarget, op: WorktreeOp, options: TeardownOptions): Promise<PlanResult[]> {
  requireDistinct(participants)
  const warn = warnOf(options)
  const timeoutMs = options.timeoutMs ?? TEARDOWN_PLAN_TIMEOUT_MS
  return Promise.all(
    participants.map(async (p): Promise<PlanResult> => {
      try {
        return { items: checkedItems(p, await withTimeout(Promise.resolve().then(() => p.plan(target, op)), timeoutMs), warn) }
      } catch (err) {
        return { error: messageOf(err) }
      }
    })
  )
}

/** Every participant's items, in participant order (asked at once). One whose plan fails is left out (logged). */
export async function planTeardown(participants: readonly Participant[], target: TeardownTarget, op: WorktreeOp, options: TeardownOptions = {}): Promise<TeardownItem[]> {
  const warn = warnOf(options)
  const plans = await planEach(participants, target, op, options)
  return plans.flatMap((plan, i) => {
    if ('items' in plan) return plan.items
    warn(`[teardown] ${participants[i].id}'s plan was left out: ${plan.error}`)
    return []
  })
}

/** A label inside "Couldn't …": its first letter lowercased only when it starts an ordinary word ("Tear down" → "tear down"; "VM …" stays). */
function inSentence(label: string): string {
  return /^\p{Lu}\p{Ll}/u.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label
}

/**
 * The worktrees (by real path) being torn down or held for an operation: one at a time each, with
 * what holds it ("removing it"). `finishing`: a participant hit the cap and is still running; the
 * entry goes once it settles.
 */
const running = new Map<string, { label: string } | 'finishing'>()

/** A worktree held for one operation (holdWorktree): runTeardown inside it takes this instead of its own hold. */
export class WorktreeHold {
  /** Set when a participant hit the cap: the entry outlives the hold, until that work settles */
  #lingering = false
  readonly key: string
  constructor(key: string) {
    this.key = key
  }
  /** @internal */
  linger(work: Promise<unknown>): void {
    this.#lingering = true
    running.set(this.key, 'finishing')
    const clear = (): void => void running.delete(this.key)
    work.then(clear, clear)
  }
  /** @internal */
  get lingering(): boolean {
    return this.#lingering
  }
}

const busyMessage = (busy: { label: string } | 'finishing'): string =>
  busy === 'finishing' ? 'a teardown is still finishing for this worktree' : `this worktree is busy: ${busy.label}; try again once it is done`

function assertFree(key: string): void {
  const busy = running.get(key)
  if (busy) throw codedError('CONFLICT', busyMessage(busy))
}

/** Whether any worktree is held or finishing now: busyWorktrees' fast path (plugins E2). */
export function anyBusy(): boolean {
  return running.size > 0
}

/** Why the worktree at `path` is busy now (the CONFLICT message), or null (plugins E2: host.busyWorktrees). */
export function busyReason(path: string): string | null {
  const busy = running.get(realOrResolved(path))
  return busy ? busyMessage(busy) : null
}

/**
 * `err`, thrown after the chosen items were torn down (`tornDown`, their labels), with
 * `details.tornDown` added: its code, message and other details as they were. None torn down: as it is.
 */
export function withTornDown(err: unknown, tornDown: readonly string[]): unknown {
  if (tornDown.length === 0) return err
  const out = err instanceof Error ? err : new Error(String(err))
  const details = (out as { details?: unknown }).details
  ;(out as { details?: unknown }).details = { ...(details && typeof details === 'object' ? details : {}), tornDown: [...tornDown] }
  return out
}

/** CONFLICT while the worktree at `path` is being torn down, or a timed-out teardown of it is still finishing. */
export function assertNotTearingDown(path: string): void {
  assertFree(realOrResolved(path))
}

/**
 * Runs `fn` (an operation on the worktree at `path`: its teardown and then its removal, promote or
 * move) with the worktree held: CONFLICT if it is busy, and any other teardown or hold of it is
 * CONFLICT until `fn` ends (or, past a teardown that hit the cap, until that teardown settles).
 * `label` says what holds it, for that CONFLICT: "this worktree is busy: <label>" ("removing it").
 */
export async function holdWorktree<T>(path: string, label: string, fn: (hold: WorktreeHold) => Promise<T>): Promise<T> {
  const key = realOrResolved(path)
  assertFree(key)
  running.set(key, { label })
  const hold = new WorktreeHold(key)
  try {
    return await fn(hold)
  } finally {
    if (!hold.lingering) running.delete(key)
  }
}

/**
 * Runs the chosen items before the operation: each participant once, with its own ids, in
 * participant order. An id with no participant here (and not one of `options.inactive`) is
 * BAD_REQUEST before anything runs. Each involved participant is asked again first: one that throws
 * or hangs stops it (TOOL_ERROR) before anything is torn down; an item its answer no longer lists
 * (the VM was deleted meanwhile), or one of an inactive participant, is skipped (logged). A
 * teardown that throws, or runs past the whole teardown's deadline (`teardownTimeoutMs` from the
 * start, shared by the participants: each gets what is left), stops it: TOOL_ERROR, `details.tornDown`
 * the labels already done; one still running then keeps the worktree 'finishing' until it settles. One at a time per worktree: CONFLICT while it is busy (even with no ids),
 * unless `options.hold` is this worktree's hold (holdWorktree), which it then uses. Resolves with
 * the labels of the items it tore down, in order (skipped ones left out).
 */
export async function runTeardown(participants: readonly Participant[], target: TeardownTarget, op: WorktreeOp, ids: readonly string[], options: TeardownOptions = {}): Promise<string[]> {
  requireDistinct(participants)
  const key = realOrResolved(target.worktree.path)
  if (options.hold) {
    if (options.hold.key !== key) throw new Error(`teardown of ${target.worktree.path} under another worktree's hold`)
  } else {
    assertFree(key)
  }
  if (ids.length === 0) return []
  const warn = warnOf(options)
  const known = new Set(participants.map((p) => p.id))
  const inactive = new Set(options.inactive ?? [])
  for (const id of ids) {
    const at = id.indexOf(':')
    const owner = at > 0 ? id.slice(0, at) : ''
    if (!known.has(owner) && !inactive.has(owner)) throw codedError('BAD_REQUEST', `${JSON.stringify(id)} is not offered for this worktree; reopen the confirm`)
  }
  for (const id of ids) {
    if (!known.has(id.slice(0, id.indexOf(':')))) warn(`[teardown] ${id} is no longer planned for ${target.worktree.path} (its plugin is off); skipped`)
  }
  if (!options.hold) return holdWorktree(target.worktree.path, 'tearing it down', (hold) => tearDown(participants, target, op, ids, options, hold))
  return tearDown(participants, target, op, ids, options, options.hold)
}

/** runTeardown's work, with the worktree held. */
async function tearDown(participants: readonly Participant[], target: TeardownTarget, op: WorktreeOp, ids: readonly string[], options: TeardownOptions, hold: WorktreeHold): Promise<string[]> {
  const warn = warnOf(options)
  const deadline = Date.now() + (options.teardownTimeoutMs ?? TEARDOWN_RUN_TIMEOUT_MS)
  const involved = participants.filter((p) => ids.some((id) => id.startsWith(`${p.id}:`)))
  const plans = await planEach(involved, target, op, options)
  const planned = new Map<string, TeardownItem>()
  plans.forEach((plan, i) => {
    if ('error' in plan) throw codedError('TOOL_ERROR', `Couldn't check ${involved[i].id} before tearing it down: ${plan.error}`, { reason: 'teardown' })
    for (const item of plan.items) planned.set(item.id, item)
  })
  const tornDown: string[] = []
  for (const p of involved) {
    const mine = ids.filter((id) => id.startsWith(`${p.id}:`))
    for (const gone of mine.filter((id) => !planned.has(id))) warn(`[teardown] ${gone} is no longer planned for ${target.worktree.path}; skipped`)
    const now = mine.filter((id) => planned.has(id))
    if (now.length === 0) continue
    const labels = now.map((id) => planned.get(id)!.label)
    const done = tornDown.length > 0 ? ` (already done: ${tornDown.join('; ')})` : ''
    const left = deadline - Date.now()
    if (left <= 0) {
      // The time ran out before this one: it isn't started, so nothing of it lingers.
      throw codedError('TOOL_ERROR', `Couldn't ${inSentence(labels.join('; '))}: no time was left for it${done}`, { reason: 'teardown', tornDown: [...tornDown] })
    }
    const work = Promise.resolve().then(() => p.teardown(target, op, now.map((id) => id.slice(p.id.length + 1))))
    let settled = false
    const settle = (): void => {
      settled = true
    }
    work.then(settle, settle)
    try {
      await withTimeout(work, left)
    } catch (err) {
      if (!settled) hold.linger(work)
      throw codedError('TOOL_ERROR', `Couldn't ${inSentence(labels.join('; '))}: ${messageOf(err)}${done}`, { reason: 'teardown', tornDown: [...tornDown] })
    }
    tornDown.push(...labels)
  }
  return tornDown
}

/** The first participant's reason the repository can't leave its project now, or null. A check that fails, hangs or answers something other than a string, null or undefined refuses too. */
export async function repoRemoveVeto(participants: readonly Participant[], project: Project, repo: Repository, options: TeardownOptions = {}): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? TEARDOWN_PLAN_TIMEOUT_MS
  for (const p of participants) {
    const check = p.beforeRepoRemove
    if (!check) continue
    let reason: unknown
    try {
      reason = await withTimeout(Promise.resolve().then(() => check(project, repo)), timeoutMs)
    } catch (err) {
      return `${p.id} could not check it: ${messageOf(err)}`
    }
    if (reason === null || reason === undefined) continue
    if (typeof reason !== 'string') return `${p.id} could not check it: not a reason`
    if (reason.trim() !== '') return reason.trim()
  }
  return null
}
