import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import { defaultSessionLlm } from '../llm'
import { LlmPicker } from './LlmPicker'
import { describeLlm } from '../../../shared/providers/selection'
import type { LlmSelection } from '../../../shared/providers/types'
import type { SessionType } from '../../../shared/types'

const MENU_WIDTH = 300

/** The last "Choose…" pick in this window, offered again next time. */
let lastPick: LlmSelection | undefined

interface Props {
  disabled: boolean
  title: string
  /** Start a session — of a type and/or with a one-off agent pick; neither = the default */
  onStart: (sessionType?: SessionType, llm?: LlmSelection) => void
}

/**
 * The + button on the session row starts a default session straight away; the ▾ beside it
 * opens a menu with the default, a one-off "Choose…" picker and the session types.
 */
export function NewSessionMenu({ disabled, title, onStart }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [pick, setPick] = useState<LlmSelection>(lastPick ?? defaultSessionLlm())
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const sessionTypes = useAppStore((s) => s.project?.sessionTypes) ?? []
  // Re-render when the defaults change so the Default entry stays accurate.
  useAppStore((s) => s.llmSettings)
  useAppStore((s) => s.project?.llmDefault)
  const fallback = defaultSessionLlm()

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!target.closest('.skill-menu') && !target.closest('.session-add-more')) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    // Opening a native <select> inside the menu can blur the window; that must not close it.
    const onBlur = (): void => {
      if (!document.activeElement?.closest('.skill-menu')) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const start = (sessionType?: SessionType, llm?: LlmSelection): void => {
    setOpen(false)
    setChoosing(false)
    onStart(sessionType, llm)
  }

  const toggleMenu = (): void => {
    if (disabled) return
    if (open) {
      setOpen(false)
      return
    }
    const rect = triggerRef.current!.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      y: rect.bottom + 6
    })
    setPick(lastPick ?? defaultSessionLlm())
    setChoosing(false)
    setOpen(true)
  }

  return (
    <>
      <button className="session-add" title={title} disabled={disabled} onClick={() => start()}>
        +
      </button>
      <button
        ref={triggerRef}
        className="session-add session-add-more"
        title="New session with…"
        disabled={disabled}
        onClick={toggleMenu}
      >
        ▾
      </button>
      {open &&
        createPortal(
          <div
            className="skill-menu"
            style={{ left: pos.x, top: pos.y, width: MENU_WIDTH }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button className="skill-menu-item" onClick={() => start()}>
              <span className="skill-menu-name">Default</span>
              <span className="skill-menu-desc">{describeLlm(fallback)}</span>
            </button>
            {choosing ? (
              <div className="new-session-choose">
                <LlmPicker value={pick} onChange={setPick} />
                <button
                  className="btn btn-accent"
                  onClick={() => {
                    lastPick = pick
                    start(undefined, pick)
                  }}
                >
                  Start
                </button>
              </div>
            ) : (
              <button className="skill-menu-item" onClick={() => setChoosing(true)}>
                <span className="skill-menu-name">Choose…</span>
                <span className="skill-menu-desc">Pick an agent, model and effort for one session</span>
              </button>
            )}
            {sessionTypes.length > 0 && <div className="skill-menu-group">Session types</div>}
            {sessionTypes.map((type) => (
              <button
                key={type.id}
                className="skill-menu-item session-type-menu-item"
                title={type.systemPrompt}
                onClick={() => start(type)}
              >
                {type.icon && <img className="session-type-menu-icon" src={type.icon} alt="" />}
                <span className="session-type-menu-text">
                  <span className="skill-menu-name">
                    {type.name.trim() || 'Untitled'}
                    {type.llm && describeLlm(type.llm) !== describeLlm(fallback) && (
                      <span className="session-type-llm-chip">{describeLlm(type.llm)}</span>
                    )}
                  </span>
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
