// A server window's settings edits: each is a compare-and-set on one field
// (a settings key, the project's name, a repository's linked directories),
// shown as pending until the server has it. Pure: installV2.ts supplies the
// mirror's project, the re-projection and the dialogs.
//
// - One request per field at a time. An edit made while one is in flight
//   waits, and only the latest such edit is sent, with the value just written
//   as `expected`: the user built it on that value, which they already saw.
// - The window shows a pending edit at once (`overlay`, applied to the
//   mirror's project before the projector), so the next edit builds on it and
//   an unrelated patch does not hide it. It goes when the server has answered:
//   on success the mirror already holds the value (the send waits for its rev).
// - A CONFLICT means another client changed the field first. It is looked up
//   again: if the server already holds what the user wanted, nothing more
//   happens; otherwise the user picks Reload (the panel re-reads the mirror) or
//   Keep Mine (sent again over the newer value). One dialog at a time. Keep
//   Mine does nothing when the field was written again since the conflict was
//   raised (a per-field write count): that edit is newer, finished or not.
// - A field with `rebase` (an operation, not a value: a favourite toggled, an
//   environment sub-field set) is not asked about: its change is re-applied
//   to the newer value and sent again, once, silently. Only a clash (the other
//   client changed the same part) asks, and Keep Mine then sends the rebased
//   value, so the other client's other changes stay.
// - A text field's draft whose value changed elsewhere while it was being
//   typed (`textCommit` says 'stale', SettingText commits it through
//   `commitStale`) is not sent over the newer value: it asks the same dialog.
// - Any other failure goes to `reportEdit` (NOT_CONNECTED: "may not have been
//   saved"); no retry.
import { deepEqual } from '../../../shared/sync/jsonDiff.ts'
import { errorCode } from './errors.ts'
import type { Project } from '../../../shared/model/types'

export interface SettingsField {
  /** One per field: `settings.<key>`, `name`, `repo:<id>.linkedDirs` */
  key: string
  /** The field's name in the conflict dialog, e.g. "Session types" */
  label: string
  /** The failure dialog's title */
  title: string
  /** The field's value in `project` (null when absent) */
  current(project: Project): unknown
  /** `project` with the field set to `value` (null removes it) */
  apply(project: Project, value: unknown): Project
  /** Sends the edit; resolves once the window's mirror holds the result */
  send(value: unknown, expected: unknown): Promise<void>
  /**
   * The user's change (`base` to `wanted`) re-applied to `latest`, the newer
   * value another client wrote. `clash`: that client changed the same part,
   * so the user is asked. Without it, a CONFLICT asks Reload or Keep Mine.
   */
  rebase?(latest: unknown, wanted: unknown, base: unknown): Rebased
}

export interface Rebased {
  value: unknown
  clash: boolean
}

export type ConflictChoice = 'reload' | 'keep'

export interface SettingsWriterDeps {
  /** The project as the window's mirror holds it now, or undefined */
  project(): Project | undefined
  /** The pending edits changed: project the mirror again (through `overlay`) */
  changed(): void
  /** Another client changed `label` first: Reload or Keep Mine */
  askConflict(label: string): Promise<ConflictChoice>
  /** Reload: the panel drops its drafts and shows the mirror's values */
  reload(): void
  reportEdit(title: string, err: unknown): void
}

export interface WriteOptions {
  /**
   * The value was built on one the field no longer holds (another client changed
   * it while the user typed): ask Reload or Keep Mine instead of sending it.
   * Defaults to whether the write runs inside `commitStale`.
   */
  stale?: boolean
}

export interface SettingsWriter {
  write(field: SettingsField, value: unknown, options?: WriteOptions): void
  /** `project` with every pending edit applied */
  overlay(project: Project): Project
  /** The window left: pending edits are forgotten and their answers ignored */
  clear(): void
}

interface Pending {
  field: SettingsField
  /** In flight */
  sent: unknown
  /** The `expected` it went with: the value the user's change was built on */
  base: unknown
  /** A silent rebase's resend: its own CONFLICT asks */
  rebased: boolean
  /** The latest edit made meanwhile, sent next */
  next: { value: unknown } | null
}

/** null and absent are the same value, as on the server. */
export const sameSetting = (a: unknown, b: unknown): boolean => deepEqual(a ?? null, b ?? null)

/**
 * A text field's commit on blur: `base` is the value when its editing began,
 * `value` the value now, `draft` the text typed. Nothing when the draft is
 * the value now, or was never changed from the base (the newer value stands);
 * 'stale' when the value changed meanwhile under a changed draft.
 */
export function textCommit(base: string, value: string, draft: string): 'none' | 'write' | 'stale' {
  if (draft === value || draft === base) return 'none'
  return value === base ? 'write' : 'stale'
}

let staleCommit = false
/** Writes made inside the current `commitStale` */
let staleWrites = 0
/** Writers created and not yet cleared: with none (a local window), a commit never reaches one */
let liveWriters = 0
let warnedNoStaleWrite = false

/**
 * Runs `commit` (a text field's onCommit, which reaches `write` synchronously
 * through the store's setter) as a stale write: see `WriteOptions.stale`.
 * One that reaches no write while a writer is live is warned of, once: an
 * async onCommit would write after the flag is down, sending the stale draft
 * as an ordinary edit.
 */
export function commitStale(commit: () => void): void {
  staleCommit = true
  staleWrites = 0
  try {
    commit()
  } finally {
    staleCommit = false
  }
  if (staleWrites === 0 && liveWriters > 0 && !warnedNoStaleWrite) {
    warnedNoStaleWrite = true
    console.warn('trek: a stale settings draft reached no write synchronously; is its onCommit async?')
  }
}

export function createSettingsWriter(deps: SettingsWriterDeps): SettingsWriter {
  const pending = new Map<string, Pending>()
  /** Bumped by every `write`, per field: a conflict's Keep Mine checks it has not moved */
  const writes = new Map<string, number>()
  let asking: Promise<unknown> = Promise.resolve()
  const writeCount = (key: string): number => writes.get(key) ?? 0
  let live = true
  liveWriters++

  const send = (p: Pending, value: unknown, expected: unknown): void => {
    p.sent = value
    p.base = expected
    p.next = null
    p.field.send(value, expected).then(
      () => sent(p, value),
      (err: unknown) => failed(p, err)
    )
  }

  const start = (field: SettingsField, value: unknown, expected: unknown, rebased = false): void => {
    if (sameSetting(value, expected)) return
    const p: Pending = { field, sent: value, base: expected, rebased, next: null }
    pending.set(field.key, p)
    deps.changed()
    send(p, value, expected)
  }

  const sent = (p: Pending, value: unknown): void => {
    if (pending.get(p.field.key) !== p) return
    if (p.next && !sameSetting(p.next.value, value)) return send(p, p.next.value, value)
    pending.delete(p.field.key)
    deps.changed()
  }

  const failed = (p: Pending, err: unknown): void => {
    if (pending.get(p.field.key) !== p) return
    const { field } = p
    const wanted = p.next ? p.next.value : p.sent
    pending.delete(field.key)
    deps.changed()
    if (errorCode(err) !== 'CONFLICT') return deps.reportEdit(field.title, err)
    // An operation is re-applied to the newer value and sent again, once, without a dialog.
    const now = deps.project()
    if (field.rebase && !p.rebased && now) {
      const latest = field.current(now)
      const { value, clash } = field.rebase(latest, wanted, p.base)
      if (!clash) return start(field, value, latest, true)
    }
    conflict(field, wanted, field.rebase ? p.base : undefined)
  }

  /**
   * Another client changed `field` under `wanted`: Reload, or Keep Mine unless a newer write came
   * since. With `base` (a field with `rebase`), Keep Mine sends the change rebased on the newer value.
   */
  const conflict = (field: SettingsField, wanted: unknown, base?: unknown): void => {
    // No project (the window left, or no snapshot yet): nothing to ask about.
    const mine = (latest: unknown): unknown =>
      field.rebase && base !== undefined ? field.rebase(latest, wanted, base).value : wanted
    const holds = (project: Project): boolean => sameSetting(field.current(project), mine(field.current(project)))
    const now = deps.project()
    if (!now || holds(now)) return
    const count = writeCount(field.key)
    asking = asking
      .then(() => {
        // Queued behind another dialog: the field may hold the wanted value by now.
        const at = deps.project()
        return at && !holds(at) ? deps.askConflict(field.label) : null
      })
      .then((choice) => {
        if (choice === null) return
        if (choice === 'reload') return deps.reload()
        const latest = deps.project()
        // An edit made since was built on the newer value, or is newer still: it wins.
        if (!latest || writeCount(field.key) !== count) return
        // One is still in flight on this field (an earlier Keep Mine, or an edit sent before a stale
        // draft's commit): this one goes after it.
        const p = pending.get(field.key)
        if (!p) return start(field, mine(field.current(latest)), field.current(latest))
        p.next = { value: mine(p.sent) }
        deps.changed()
      })
      .catch(() => undefined)
  }

  return {
    write: (field, value, options) => {
      writes.set(field.key, writeCount(field.key) + 1)
      if (staleCommit) staleWrites++
      if (options?.stale ?? staleCommit) return conflict(field, value)
      const p = pending.get(field.key)
      if (p) {
        p.next = { value }
        deps.changed()
        return
      }
      const project = deps.project()
      if (project) start(field, value, field.current(project))
    },
    overlay: (project) => {
      let out = project
      for (const p of pending.values()) out = p.field.apply(out, p.next ? p.next.value : p.sent)
      return out
    },
    clear: () => {
      pending.clear()
      if (live) liveWriters--
      live = false
    }
  }
}
