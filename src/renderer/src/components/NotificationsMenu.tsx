import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import { focusTerminal, revealTerminal, terminalLabel } from '../terminals'
import { useAttention } from '../useAttention'
import { menuEntries, type MenuEntry } from '../notificationItems'
import { errorText } from '../v2/errors'

const MENU_WIDTH = 320

function timeAgo(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

/**
 * Bell in the sidebar listing the sessions waiting on the user: this window's
 * own decisions, and every app-wide server's sessions in attention, done or
 * with a decision (main's attention list), file windows included. Clicking a
 * local entry opens its session here; a server entry asks main to focus or
 * open its project's window, which selects it. The flag (or ×) dismisses it:
 * a server entry's decision is dismissed, or the session marked seen, through
 * main's connection to that server.
 */
export function NotificationsMenu(): React.JSX.Element {
  const decisions = useAppStore((s) => s.decisions)
  const serverWindow = useAppStore((s) => s.serverWindow)
  // Re-render with terminal renames and closes.
  useAppStore((s) => s.terminals)
  const items = useAttention()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const list = menuEntries(Object.values(decisions), serverWindow, items, terminalLabel)

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

  const openEntry = (entry: MenuEntry): void => {
    setOpen(false)
    if (entry.kind === 'server') {
      void window.api.attention.open(entry.id)
      return
    }
    revealTerminal(entry.id)
    // The tab's pane mounts on reveal; focus once it has.
    requestAnimationFrame(() => focusTerminal(entry.id))
  }

  const dismiss = (entry: MenuEntry): void => {
    if (entry.kind === 'local') {
      useAppStore.getState().clearDecision(entry.id)
      return
    }
    window.api.attention.dismiss(entry.id).catch((err: unknown) => {
      void window.api.showError(entry.decision ? 'Could not dismiss the decision' : 'Could not mark the session seen', errorText(err))
    })
  }

  return (
    <>
      <button
        ref={triggerRef}
        className={`notif-bell ${list.length ? 'pending' : ''}`}
        title={list.length ? `${list.length} session(s) waiting on you` : 'Nothing waiting on you'}
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
            <div className="notif-menu-head">Waiting on you</div>
            {list.length === 0 && <div className="notif-empty muted">Nothing waiting on you</div>}
            {list.map((entry) => {
              const decision = entry.kind === 'local' || entry.decision
              return (
                <div
                  key={`${entry.kind} ${entry.id}`}
                  className={`notif-item ${entry.kind === 'server' ? 'notif-server' : ''} ${entry.kind === 'server' && entry.stale ? 'stale' : ''}`}
                  title={entry.kind === 'server' && entry.stale ? 'Not connected to the server: as last seen' : undefined}
                  onClick={() => openEntry(entry)}
                >
                  <span
                    className={`${decision ? 'decision-icon' : 'notif-seen'} clickable`}
                    title={decision ? 'Dismiss' : 'Mark seen'}
                    onClick={(e) => {
                      e.stopPropagation()
                      dismiss(entry)
                    }}
                  >
                    {decision ? '⚑' : '×'}
                  </span>
                  <div className="notif-text">
                    <div className="notif-source">
                      <span>{entry.source}</span>
                      <span className="notif-time">{timeAgo(entry.at)}</span>
                    </div>
                    <div className="notif-question">{entry.text}</div>
                  </div>
                </div>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}
