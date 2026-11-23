// One task field's editor state. The rules:
// - The typed text (the draft) is saved 800 ms after the last key, on blur or Enter (`commit`), and
//   when the editor goes away with a save still waiting.
// - A save sends the whole task as the window has it, with this field replaced, against the
//   task's updatedAt. updatedAt moves for many reasons (a start, another field edited elsewhere),
//   so only a change to THIS field's stored value since the edit began is a clash: the field then
//   shows both versions and the user picks. A stored value equal to the typed one is no clash.
// - Typing is never rewritten: the draft goes only when it is exactly the stored text, or, on a
//   commit, when it trims to it (the server trims what it stores).
// - Right after our own save, until the window's mirror has it, our value and updatedAt stand in
//   for the stored ones.
// - A CONFLICT while this field is unchanged waits (up to 1 s) for the mirror to move, then
//   retries once against the newest updatedAt.
// - A failed save keeps the text and offers Retry.
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

/** `auto`: the typing pause; `commit`: blur, Enter, Retry, unmount; `force`: Keep mine */
type Mode = 'auto' | 'commit' | 'force'

interface Stored {
  value: string
  updatedAt: number
}

const SAVE_DELAY_MS = 800
const MIRROR_POLL_MS = 50
const MIRROR_WAIT_MS = 1000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function useTaskField(task: Task, field: TaskField): TaskFieldState {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [theirs, setTheirs] = useState<string | null>(null)
  const latest = useRef(task)
  latest.current = task
  /** Our last save, while the mirror has not caught up with it */
  const known = useRef<Stored | null>(null)
  /** This field as stored: the mirror's, or our own save while the mirror lags behind it */
  const storedNow = (): Stored => {
    const t = latest.current
    const k = known.current
    return k && t.updatedAt < k.updatedAt ? k : { value: t[field] ?? '', updatedAt: t.updatedAt }
  }
  const stored = storedNow().value
  /** The stored value when the edit began: a change to it from elsewhere is a clash */
  const base = useRef(stored)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** A save is on the wire; `again` is the send asked for meanwhile, made after it */
  const busy = useRef(false)
  const again = useRef<Mode | null>(null)

  // Not editing: follow the stored value.
  if (draft === null) base.current = stored

  const clearTimer = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  /** Drops the draft, unless typing changed it meanwhile */
  const dropDraft = (text: string): void => {
    if (draftRef.current === text) draftRef.current = null
    setDraft((d) => (d === text ? null : d))
  }

  /** The whole task as the window has it now, with this field replaced */
  const inputFor = (text: string): TaskInput => {
    const t = latest.current
    return { id: t.id, title: t.title, details: t.details ?? '', status: t.status ?? '', [field]: text }
  }

  /** Saves `text`; a CONFLICT while this field is unchanged is retried once. Null: it clashes. */
  const save = async (text: string): Promise<Stored | null> => {
    const attempt = async (): Promise<Stored> => {
      const result = await getBackend().tasks.save(inputFor(text), storedNow().updatedAt)
      return { value: text.trim(), updatedAt: result.updatedAt }
    }
    const sentAt = storedNow().updatedAt
    try {
      return await attempt()
    } catch (err) {
      if (errorCode(err) !== 'CONFLICT') throw err
    }
    // The server has a newer task than the window: wait for the mirror to have it too.
    for (let waited = 0; latest.current.updatedAt <= sentAt && waited < MIRROR_WAIT_MS; waited += MIRROR_POLL_MS) await sleep(MIRROR_POLL_MS)
    if (storedNow().value !== base.current) return null
    return attempt()
  }

  const send = async (mode: Mode): Promise<void> => {
    clearTimer()
    if (busy.current) {
      again.current = again.current === 'force' ? 'force' : mode
      return
    }
    const text = draftRef.current
    if (text === null) return
    const now = storedNow().value
    // Already stored: nothing to send (and nothing to clash with).
    if (text === now || (mode !== 'auto' && text.trim() === now)) {
      setTheirs(null)
      dropDraft(text)
      return
    }
    if (text.trim() === now) {
      base.current = now
      setTheirs(null)
      return
    }
    if (mode !== 'force' && now !== base.current) {
      setTheirs(now)
      return
    }
    if (field === 'title' && text.trim() === '') {
      setError('A task needs a title')
      return
    }
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      const saved = await save(text)
      const current = storedNow().value
      if (saved) {
        known.current = saved
        base.current = saved.value
        setTheirs(null)
        if (text === saved.value || mode !== 'auto') dropDraft(text)
      } else if (current === text.trim()) {
        base.current = current
        setTheirs(null)
        if (text === current || mode !== 'auto') dropDraft(text)
      } else {
        setTheirs(current)
      }
    } catch (err) {
      // A dropped connection shows nothing inline elsewhere; here the typed text still needs Retry.
      setError(getBackend().errors.inline(err) ?? 'Not saved: the connection dropped')
    } finally {
      busy.current = false
      setSaving(false)
    }
    const next = again.current
    again.current = null
    if (next) void send(next)
  }

  // Going away (another task selected) with a save still waiting: send it now. Through a ref, as
  // the cleanup closes over the first render.
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(
    () => () => {
      if (!timer.current) return
      clearTimer()
      void sendRef.current('commit')
    },
    []
  )

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
      timer.current = setTimeout(() => void send('auto'), SAVE_DELAY_MS)
    },
    commit: () => void send('commit'),
    keepMine: () => {
      setTheirs(null)
      base.current = storedNow().value
      void send('force')
    },
    useTheirs: () => {
      clearTimer()
      setTheirs(null)
      setError(null)
      draftRef.current = null
      setDraft(null)
    }
  }
}
