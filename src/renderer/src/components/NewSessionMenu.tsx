import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import { defaultSessionLlm } from '../llm'
import { LlmPicker } from './LlmPicker'
import { describeLlm } from '../../../shared/providers/selection'
import { v2SessionChoices } from '../v2/sessionChoices'
import type { LlmSelection } from '../../../shared/providers/types'
import type { SessionType } from '../../../shared/types'

const MENU_WIDTH = 300

/** The last "Choose…" pick in this window, offered again next time. */
let lastPick: LlmSelection | undefined

interface Props {
  disabled: boolean
  title: string
  /** Host the session will run on, so the picker checks the right machine for the agent */
  serverId?: string | null
  /** Start a session — of a type and/or with a one-off agent pick; neither = the default */
  onStart: (sessionType?: SessionType, llm?: LlmSelection) => void
}

/**
 * The + button on the session row starts a default session straight away; the ▾ beside it
 * opens a menu with the default, a one-off "Choose…" picker and the session types.
 */
export function NewSessionMenu({ disabled, title, serverId = null, onStart }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [pick, setPick] = useState<LlmSelection>(lastPick ?? defaultSessionLlm())
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const sessionTypes = useAppStore((s) => s.project?.sessionTypes) ?? []
  // Re-render when the defaults change so the Default entry stays accurate.
  useAppStore((s) => s.llmSettings)
  const llmDefault = useAppStore((s) => s.project?.llmDefault)
  const globalLlm = useAppStore((s) => s.project?.globalLlm)
  // A server window runs the session with the server's agents, not this machine's (3c-3 lists them).
  const serverWindow = useAppStore((s) => s.serverWindow !== null)
  const v2 = serverWindow ? v2SessionChoices({ llmDefault, globalLlm, sessionTypes }) : null
  const fallback = defaultSessionLlm()
  const fallbackLabel = v2 ? v2.defaultLabel : describeLlm(fallback)

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
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
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
              <span className="skill-menu-desc">{fallbackLabel}</span>
            </button>
            {v2 ? (
              v2.picks.map((llm) => (
                <button key={describeLlm(llm)} className="skill-menu-item" onClick={() => start(undefined, llm)}>
                  <span className="skill-menu-name">{describeLlm(llm)}</span>
                  <span className="skill-menu-desc">An agent this project&apos;s settings use</span>
                </button>
              ))
            ) : choosing ? (
              <div className="new-session-choose">
                <LlmPicker value={pick} onChange={setPick} serverId={serverId} />
                <button
                  className="btn btn-accent"
                  disabled={pick.provider === 'local' && !pick.model}
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
                    {type.llm && describeLlm(type.llm) !== fallbackLabel && (
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
