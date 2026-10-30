import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import { focusTerminal, revealTerminal, terminalLabel } from '../terminals'

const MENU_WIDTH = 320

function timeAgo(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

/**
 * Bell in the sidebar listing the sessions waiting on a decision. Clicking an
 * entry opens its session; clicking its flag dismisses it.
 */
export function NotificationsMenu(): React.JSX.Element {
  const decisions = useAppStore((s) => s.decisions)
  // Re-render with terminal renames and closes.
  useAppStore((s) => s.terminals)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const list = Object.values(decisions).sort((a, b) => b.requestedAt - a.requestedAt)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!target.closest('.notif-menu') && !target.closest('.notif-bell')) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = triggerRef.current!.getBoundingClientRect()
    setPos({ x: Math.max(8, rect.left), y: rect.bottom + 6 })
    setOpen(true)
  }

  const openSession = (id: string): void => {
    setOpen(false)
    revealTerminal(id)
    // The tab's pane mounts on reveal; focus once it has.
    requestAnimationFrame(() => focusTerminal(id))
  }

  return (
    <>
      <button
        ref={triggerRef}
        className={`notif-bell ${list.length ? 'pending' : ''}`}
        title={list.length ? `${list.length} session(s) need a decision` : 'No pending decisions'}
        onClick={toggle}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <path
            d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5v2.6L2.3 11a.6.6 0 0 0 .5.9h10.4a.6.6 0 0 0 .5-.9l-1.2-2.4V6A4.5 4.5 0 0 0 8 1.5zM6.2 13a1.9 1.9 0 0 0 3.6 0z"
            fill="currentColor"
          />
        </svg>
        {list.length > 0 && <span className="notif-count">{list.length}</span>}
      </button>
      {open &&
        createPortal(
          <div className="notif-menu" style={{ left: pos.x, top: pos.y, width: MENU_WIDTH }}>
            <div className="notif-menu-head">Decisions needed</div>
            {list.length === 0 && <div className="notif-empty muted">Nothing waiting on you</div>}
            {list.map((d) => (
              <div key={d.terminalId} className="notif-item" onClick={() => openSession(d.terminalId)}>
                <span
                  className="decision-icon clickable"
                  title="Dismiss"
                  onClick={(e) => {
                    e.stopPropagation()
                    useAppStore.getState().clearDecision(d.terminalId)
                  }}
                >
                  ⚑
                </span>
                <div className="notif-text">
                  <div className="notif-source">
                    <span>{terminalLabel(d.terminalId)}</span>
                    <span className="notif-time">{timeAgo(d.requestedAt)}</span>
                  </div>
                  <div className="notif-question">{d.question}</div>
                </div>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
