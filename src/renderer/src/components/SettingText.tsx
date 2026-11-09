import { useEffect, useRef, useState } from 'react'
import { commitStale, textCommit } from '../v2/settingsWriter'

/**
 * A Settings text field. Each commit is a request to the server, so the text
 * is a local draft, committed on blur, or on Enter for a one-line field;
 * Escape puts the value back. While not being edited it follows the value (a
 * server window shows a pending edit at once, so a committed draft does not
 * flash the old text). A draft whose value changed elsewhere while it was
 * typed is committed as stale: the server window's writer asks Reload or Keep
 * Mine rather than send it over the newer value.
 * A field unmounted while edited (its panel re-keyed for another worktree,
 * or hidden) commits its draft then, as a blur would: no blur comes.
 */
export function SettingText({
  value,
  onCommit,
  rows,
  className,
  placeholder,
  title,
  spellCheck
}: {
  value: string
  onCommit: (value: string) => void
  /** A textarea of this many rows; a one-line input without it */
  rows?: number
  className?: string
  placeholder?: string
  title?: string
  spellCheck?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)
  /** The value when editing began */
  const base = useRef(value)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  // The latest of each, for the unmount below; `editing` set synchronously, so a blur that does
  // come first leaves nothing to commit.
  const latest = useRef({ value, draft, editing, onCommit })
  latest.current = { value, draft, editing: latest.current.editing, onCommit }
  useEffect(
    () => () => {
      const { value: now, draft: typed, editing: open, onCommit: save } = latest.current
      if (!open || cancelled.current) return
      latest.current.editing = false
      const action = textCommit(base.current, now, typed)
      if (action === 'write') save(typed)
      else if (action === 'stale') commitStale(() => save(typed))
    },
    // Once, at unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const common = { className, placeholder, title, spellCheck }

  const commit = (): void => {
    latest.current.editing = false
    setEditing(false)
    if (cancelled.current) {
      cancelled.current = false
      setDraft(value)
      return
    }
    const action = textCommit(base.current, value, draft)
    if (action === 'write') onCommit(draft)
    else if (action === 'stale') commitStale(() => onCommit(draft))
  }
  const handlers = {
    value: draft,
    onFocus: () => {
      cancelled.current = false
      base.current = value
      latest.current.editing = true
      setEditing(true)
    },
    onBlur: commit
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      cancelled.current = true
      e.currentTarget.blur()
    } else if (e.key === 'Enter' && !rows) e.currentTarget.blur()
  }
  return rows ? (
    <textarea {...common} {...handlers} rows={rows} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
  ) : (
    <input {...common} {...handlers} type="text" onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
  )
}

/**
 * A Settings number field. The typed text is a draft, committed on blur or
 * Enter (Escape puts the value back), so the window sends one request, not one
 * per digit.
 * A blank or non-positive entry commits `fallback`.
 */
export function SettingNumber({
  value,
  onCommit,
  min,
  fallback
}: {
  value: number
  onCommit: (value: number) => void
  min?: number
  fallback: number
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const parse = (text: string): number => Number(text) || fallback
  return (
    <input
      type="number"
      min={min}
      value={draft ?? String(value)}
      onFocus={() => {
        cancelled.current = false
        setDraft(String(value))
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (!cancelled.current && draft !== null && parse(draft) !== value) onCommit(parse(draft))
        cancelled.current = false
        setDraft(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') cancelled.current = true
        if (e.key === 'Escape' || e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}
