// One task field's editor state: the text being typed, saved 800 ms after the last key and on blur.
// A save sends the whole task as the window has it now, with this field replaced, against the
// task's current updatedAt. updatedAt moves for many reasons (a start, another field edited
// elsewhere), so only a change to THIS field's stored value since the edit began is a clash: the
// field then shows both versions and the user picks. A CONFLICT from the server while this field
// is unchanged is retried once against the newest updatedAt. A failed save keeps the text.
import { useEffect, useRef, useState } from 'react'
import type { Task, TaskInput } from '../../../shared/model/types'
import { getBackend } from '../backend'
import { errorCode } from '../v2/errors'

export type TaskField = 'title' | 'details' | 'status'

export interface TaskFieldState {
  /** What the input shows */
  value: string
  saving: boolean
  error: string | null
  /** The stored value from elsewhere, when it clashes with the typed one */
  theirs: string | null
  change(text: string): void
  /** Save now (blur, Enter, Retry) */
  commit(): void
  keepMine(): void
  useTheirs(): void
}

const SAVE_DELAY_MS = 800
/** How long a CONFLICT waits for the window's mirror to catch up before the one retry */
const MIRROR_WAIT_MS = 100

const valueOf = (task: Task, field: TaskField): string => task[field] ?? ''

export function useTaskField(task: Task, field: TaskField): TaskFieldState {
  const stored = valueOf(task, field)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [theirs, setTheirs] = useState<string | null>(null)
  /** The stored value when the edit began: a change to it from elsewhere is a clash */
  const base = useRef(stored)
  const latest = useRef(task)
  latest.current = task
  const draftRef = useRef(draft)
  draftRef.current = draft
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** A save is on the wire; `again` sends once more after it (typing went on meanwhile) */
  const busy = useRef(false)
  const again = useRef(false)

  // Not editing: follow the stored value.
  if (draft === null) base.current = stored

  const clearTimer = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clearTimer, [])

  /** The whole task as the window has it now, with this field replaced */
  const inputFor = (current: Task, text: string): TaskInput => ({
    id: current.id,
    title: current.title,
    details: current.details ?? '',
    status: current.status ?? '',
    [field]: text
  })

  /** Saves `text`; on a CONFLICT while this field is unchanged, once more against the newest updatedAt. */
  const save = async (text: string): Promise<'saved' | 'clash'> => {
    try {
      await getBackend().tasks.save(inputFor(latest.current, text), latest.current.updatedAt)
      return 'saved'
    } catch (err) {
      if (errorCode(err) !== 'CONFLICT') throw err
    }
    await new Promise((resolve) => setTimeout(resolve, MIRROR_WAIT_MS))
    if (valueOf(latest.current, field) !== base.current) return 'clash'
    await getBackend().tasks.save(inputFor(latest.current, text), latest.current.updatedAt)
    return 'saved'
  }

  const send = async (force: boolean): Promise<void> => {
    clearTimer()
    if (busy.current) {
      again.current = true
      return
    }
    const text = draftRef.current
    if (text === null) return
    const now = valueOf(latest.current, field)
    if (!force && now !== base.current) {
      setTheirs(now)
      return
    }
    if (field === 'title' && text.trim() === '') {
      setError('A task needs a title')
      return
    }
    if (text.trim() === now) {
      setDraft((d) => (d === text ? null : d))
      return
    }
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      if ((await save(text)) === 'clash') {
        setTheirs(valueOf(latest.current, field))
      } else {
        base.current = text.trim()
        setTheirs(null)
        setDraft((d) => (d === text ? null : d))
      }
    } catch (err) {
      // A dropped connection shows nothing inline elsewhere; here the typed text still needs Retry.
      setError(getBackend().errors.inline(err) ?? 'Not saved: the connection dropped')
    } finally {
      busy.current = false
      setSaving(false)
    }
    if (again.current) {
      again.current = false
      if (draftRef.current !== text) void send(false)
    }
  }

  return {
    value: draft ?? stored,
    saving,
    error,
    theirs,
    change: (text) => {
      if (draftRef.current === null) base.current = stored
      setDraft(text)
      draftRef.current = text
      setError(null)
      clearTimer()
      timer.current = setTimeout(() => void send(false), SAVE_DELAY_MS)
    },
    commit: () => void send(false),
    keepMine: () => {
      setTheirs(null)
      base.current = valueOf(latest.current, field)
      void send(true)
    },
    useTheirs: () => {
      clearTimer()
      setTheirs(null)
      setError(null)
      setDraft(null)
    }
  }
}
