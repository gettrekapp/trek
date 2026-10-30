import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import type { ClaudeSessionType } from '../../../shared/types'

const MENU_WIDTH = 280

interface Props {
  disabled: boolean
  title: string
  /** Start a session — of the given type, or a plain one when undefined */
  onStart: (sessionType?: ClaudeSessionType) => void
}

/**
 * The + button on the session row. With session types configured it opens a
 * menu to pick one; without any it starts a plain session straight away.
 */
export function NewSessionMenu({ disabled, title, onStart }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const sessionTypes = useAppStore((s) => s.project?.sessionTypes) ?? []

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!target.closest('.skill-menu') && !target.closest('.session-add')) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onBlur = (): void => setOpen(false)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const start = (sessionType?: ClaudeSessionType): void => {
    setOpen(false)
    onStart(sessionType)
  }

  const toggle = (): void => {
    if (disabled) return
    if (open) {
      setOpen(false)
      return
    }
    if (sessionTypes.length === 0) {
      start()
      return
    }
    const rect = triggerRef.current!.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      y: rect.bottom + 6
    })
    setOpen(true)
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="session-add"
        title={title}
        disabled={disabled}
        onClick={toggle}
      >
        +
      </button>
      {open &&
        createPortal(
          <div
            className="skill-menu"
            style={{ left: pos.x, top: pos.y, width: MENU_WIDTH }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button className="skill-menu-item" onClick={() => start()}>
              <span className="skill-menu-name">Claude</span>
              <span className="skill-menu-desc">Plain session, no extra system prompt</span>
            </button>
            <div className="skill-menu-group">Session types</div>
            {sessionTypes.map((type) => (
              <button
                key={type.id}
                className="skill-menu-item session-type-menu-item"
                title={type.systemPrompt}
                onClick={() => start(type)}
              >
                {type.icon && <img className="session-type-menu-icon" src={type.icon} alt="" />}
                <span className="session-type-menu-text">
                  <span className="skill-menu-name">{type.name.trim() || 'Untitled'}</span>
                  {type.systemPrompt.trim() && (
                    <span className="skill-menu-desc">{type.systemPrompt.trim()}</span>
                  )}
                </span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
