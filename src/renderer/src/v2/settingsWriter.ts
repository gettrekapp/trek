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
//   Keep Mine (sent again over the newer value). One dialog at a time.
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

export interface SettingsWriter {
  write(field: SettingsField, value: unknown): void
  /** `project` with every pending edit applied */
  overlay(project: Project): Project
  /** The window left: pending edits are forgotten and their answers ignored */
  clear(): void
}

interface Pending {
  field: SettingsField
  /** In flight */
  sent: unknown
  /** The latest edit made meanwhile, sent next */
  next: { value: unknown } | null
}

/** null and absent are the same value, as on the server. */
export const sameSetting = (a: unknown, b: unknown): boolean => deepEqual(a ?? null, b ?? null)

export function createSettingsWriter(deps: SettingsWriterDeps): SettingsWriter {
  const pending = new Map<string, Pending>()
  let asking: Promise<unknown> = Promise.resolve()

  const send = (p: Pending, value: unknown, expected: unknown): void => {
    p.sent = value
    p.next = null
    p.field.send(value, expected).then(
      () => sent(p, value),
      (err: unknown) => failed(p, err)
    )
  }

  const start = (field: SettingsField, value: unknown, expected: unknown): void => {
    if (sameSetting(value, expected)) return
    const p: Pending = { field, sent: value, next: null }
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
    const now = deps.project()
    if (now && sameSetting(field.current(now), wanted)) return
    asking = asking
      .then(() => deps.askConflict(field.label))
      .then((choice) => {
        if (choice === 'reload') return deps.reload()
        const latest = deps.project()
        // An edit made while the dialog was open was built on the newer value: it wins.
        if (!latest || pending.has(field.key)) return
        start(field, wanted, field.current(latest))
      })
      .catch(() => undefined)
  }

  return {
    write: (field, value) => {
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
    clear: () => pending.clear()
  }
}
