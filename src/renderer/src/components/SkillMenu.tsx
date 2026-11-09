import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import { getBackend } from '../backend'
import { focusTerminal, writeTerminal } from '../terminals'
import type { SkillInfo, WorktreeInstance } from '../../../shared/types'

const MENU_WIDTH = 340

interface Props {
  worktree: WorktreeInstance
  terminalId: string
}

/** The ⚡ menu on a terminal tab: run a skill or command in that terminal. */
export function SkillMenu({ worktree, terminalId }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!target.closest('.skill-menu') && !target.closest('.skill-menu-trigger')) setOpen(false)
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
    setSkills(null)
    setOpen(true)
    // Fetched on every open so newly added skills show up without a restart; the window's server
    // reads the worktree's .claude and its user's ~/.claude on its disk.
    getBackend()
      .skills.list({ path: worktree.path })
      .then(setSkills)
      .catch(() => setSkills([]))
  }

  const run = (name: string): void => {
    setOpen(false)
    setActiveTerminal(worktree.id, terminalId)
    // Type the slash command, then submit after a beat so Claude Code's
    // command menu has caught up with the typed text. A server window's
    // terminal is the server's pty: writeTerminal sends it there.
    writeTerminal(terminalId, `/${name}`)
    setTimeout(() => writeTerminal(terminalId, '\r'), 200)
    focusTerminal(terminalId)
  }

  const groups = skills
    ? [
        { label: 'Project skills', items: skills.filter((s) => s.source === 'project' && s.kind === 'skill') },
        { label: 'Project commands', items: skills.filter((s) => s.source === 'project' && s.kind === 'command') },
        { label: 'User skills', items: skills.filter((s) => s.source === 'user' && s.kind === 'skill') },
        { label: 'User commands', items: skills.filter((s) => s.source === 'user' && s.kind === 'command') }
      ].filter((g) => g.items.length > 0)
    : []

  return (
    <>
      <span
        ref={triggerRef}
        className={`skill-menu-trigger ${open ? 'open' : ''}`}
        title="Run a skill or command in this terminal"
        onClick={toggle}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        ⚡
      </span>
      {open &&
        createPortal(
          <div
            className="skill-menu"
            style={{ left: pos.x, top: pos.y, width: MENU_WIDTH }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {skills === null && <div className="skill-menu-empty">Loading…</div>}
            {skills !== null && skills.length === 0 && (
              <div className="skill-menu-empty">No skills or commands found</div>
            )}
            {groups.map((group) => (
              <div key={group.label}>
                <div className="skill-menu-group">{group.label}</div>
                {group.items.map((s) => (
                  <button
                    key={`${s.source}-${s.kind}-${s.name}`}
                    className="skill-menu-item"
                    title={s.description}
                    onClick={(e) => {
                      e.stopPropagation()
                      run(s.name)
                    }}
                  >
                    <span className="skill-menu-name">/{s.name}</span>
                    {s.description && <span className="skill-menu-desc">{s.description}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
