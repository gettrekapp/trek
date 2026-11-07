import { useEffect, useRef, useState } from 'react'

/**
 * A Settings text field. `live` (a file window): every keystroke commits, as
 * the panel's fields always did. Otherwise (a server window, where each commit
 * is a request) the text is a local draft, committed on blur, or on Enter for
 * a one-line field; Escape puts the value back. While not being edited it
 * follows the value (a server window shows a pending edit at once, so a
 * committed draft does not flash the old text).
 */
export function SettingText({
  value,
  onCommit,
  live,
  rows,
  className,
  placeholder,
  title
}: {
  value: string
  onCommit: (value: string) => void
  live: boolean
  /** A textarea of this many rows; a one-line input without it */
  rows?: number
  className?: string
  placeholder?: string
  title?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  const common = { className, placeholder, title }
  if (live) {
    return rows ? (
      <textarea {...common} rows={rows} value={value} onChange={(e) => onCommit(e.target.value)} />
    ) : (
      <input {...common} type="text" value={value} onChange={(e) => onCommit(e.target.value)} />
    )
  }

  const commit = (): void => {
    setEditing(false)
    if (cancelled.current) {
      cancelled.current = false
      setDraft(value)
      return
    }
    if (draft !== value) onCommit(draft)
  }
  const handlers = {
    value: draft,
    onFocus: () => {
      cancelled.current = false
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
