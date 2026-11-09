import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getBackend } from '../backend'
import type { ComposeAction } from '../../../shared/types'

const MENU_WIDTH = 300

// The server owns each action's arguments (dockerService.ts's COMPOSE_ARGS): the menu names the action.
const COMPOSE_ACTIONS: { label: string; action: ComposeAction; desc: string }[] = [
  { label: 'compose up -d', action: 'up', desc: 'Start services in the background' },
  { label: 'compose up --build -d', action: 'upBuild', desc: 'Rebuild images, then start' },
  { label: 'compose restart', action: 'restart', desc: 'Restart all services' },
  { label: 'compose stop', action: 'stop', desc: 'Stop services without removing them' },
  { label: 'compose down', action: 'down', desc: 'Stop and remove containers and networks' },
  { label: 'compose pull', action: 'pull', desc: 'Pull the latest images' }
]

/** The ▾ menu on the Docker tab: docker compose actions run in the repository's main checkout, on its server. */
export function DockerMenu({ repoId }: { repoId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [running, setRunning] = useState<string | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!target.closest('.docker-menu') && !target.closest('.docker-menu-trigger')) setOpen(false)
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

  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (open) {
      setOpen(false)
      return
    }
    const rect = triggerRef.current!.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      y: rect.bottom + 6
    })
    setOpen(true)
  }

  const run = async (action: (typeof COMPOSE_ACTIONS)[number]): Promise<void> => {
    setOpen(false)
    if (running) return
    setRunning(action.label)
    const backend = getBackend()
    try {
      // Output streams into the Docker panel's log as the server's docker.log events; a run that
      // fails resolves its exit code there.
      await backend.docker.compose(repoId, action.action)
    } catch (err) {
      // A request the server refused or never answered is shown. report says nothing for a link
      // that is down (NOT_CONNECTED: the window shows it offline) or a window that left.
      backend.errors.report(`docker ${action.label} failed`, err)
    } finally {
      setRunning(null)
    }
  }

  return (
    <>
      <span
        ref={triggerRef}
        className={`docker-menu-trigger ${open ? 'open' : ''} ${running ? 'running' : ''}`}
        title={running ? `Running: docker ${running}` : 'Docker compose actions'}
        onClick={toggle}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        ▾
      </span>
      {open &&
        createPortal(
          <div
            className="docker-menu skill-menu"
            style={{ left: pos.x, top: pos.y, width: MENU_WIDTH }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {COMPOSE_ACTIONS.map((action) => (
              <button
                key={action.label}
                className="skill-menu-item"
                disabled={!!running}
                onClick={(e) => {
                  e.stopPropagation()
                  void run(action)
                }}
              >
                <span className="skill-menu-name">{action.label}</span>
                <span className="skill-menu-desc">{action.desc}</span>
              </button>
            ))}
            {running && <div className="skill-menu-empty">Running: docker {running}…</div>}
          </div>,
          document.body
        )}
    </>
  )
}
