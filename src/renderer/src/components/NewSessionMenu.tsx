import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import { useAgentCatalog } from '../agents'
import { needsModel } from '../agentPicker'
import { LlmPicker } from './LlmPicker'
import { agentNote, describeAgent, expectedDefault } from '../../../shared/agents/catalog.ts'
import { DEFAULT_AGENT_ID } from '../../../shared/plugins/agents.ts'
import { createPickMemory, serverFirstPick, v2ServerAgents, v2SessionChoices } from '../v2/sessionChoices'
import type { LlmSelection } from '../../../shared/providers/types'
import type { SessionType } from '../../../shared/types'

const MENU_WIDTH = 300

/** The last "Choose…" pick of each server, for as long as the window lives (its agents are the server's). */
const serverPicks = createPickMemory()

interface Props {
  disabled: boolean
  title: string
  /** Start a session — of a type and/or with a one-off agent pick; neither = the default */
  onStart: (sessionType?: SessionType, llm?: LlmSelection) => void
}

/**
 * The + button on the session row starts a default session straight away; the ▾ beside it opens a
 * menu with the default, the server's agents that are on in the project (server.agents), a one-off
 * "Choose…" picker and the session types. Until the server answers, or from a server without
 * `agents`, it offers the agents the project's settings already name. A session type whose agent is
 * off in the project, or not on the server, is shown greyed out with the reason: the server would
 * refuse it.
 */
export function NewSessionMenu({ disabled, title, onStart }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [pick, setPick] = useState<LlmSelection>({ provider: DEFAULT_AGENT_ID })
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const sessionTypes = useAppStore((s) => s.project?.sessionTypes) ?? []
  const llmDefault = useAppStore((s) => s.project?.llmDefault)
  const globalLlm = useAppStore((s) => s.project?.globalLlm)
  const serverEntryId = useAppStore((s) => s.serverWindow?.serverEntryId ?? null)
  const serverAgents = useAppStore((s) => s.serverAgents)
  const catalog = useAgentCatalog()
  const listed = serverAgents ? v2ServerAgents({ llmDefault }, serverAgents, catalog) : null
  const interim = listed ? null : v2SessionChoices({ llmDefault, globalLlm, sessionTypes }, catalog)
  const defaultLabel = listed?.defaultLabel ?? interim?.defaultLabel ?? ''
  /** What "Choose…" starts from: the last pick on this server while it offers its agent, else the default the session would get. */
  const firstPick = (): LlmSelection =>
    serverFirstPick(
      serverEntryId ? serverPicks.get(serverEntryId) : undefined,
      listed?.providers ?? [],
      serverAgents ? expectedDefault({ llmDefault }, serverAgents.llmDefault, catalog, false) : llmDefault,
      { provider: DEFAULT_AGENT_ID }
    )

  // Disabled while open (a server window going offline): close it, its picks would do nothing.
  useEffect(() => {
    if (disabled) {
      setOpen(false)
      setChoosing(false)
    }
  }, [disabled])

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
    setPick(firstPick())
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
              <span className="skill-menu-desc">{defaultLabel}</span>
            </button>
            {listed ? (
              choosing ? (
                <div className="new-session-choose">
                  <LlmPicker value={pick} onChange={setPick} catalog={catalog} />
                  <button
                    className="btn btn-accent"
                    disabled={needsModel(pick, catalog) || !catalog.isOn(pick.provider)}
                    onClick={() => {
                      if (serverEntryId) serverPicks.set(serverEntryId, pick)
                      start(undefined, pick)
                    }}
                  >
                    Start
                  </button>
                </div>
              ) : (
                <>
                  {listed.agents.map((agent) => (
                    <button
                      key={agent.llm.provider}
                      className={`skill-menu-item server-agent-item ${agent.installed ? '' : 'not-installed'}`}
                      title={agent.installed ? undefined : "The server's login shell does not find its command; it may still start"}
                      onClick={() => start(undefined, agent.llm)}
                    >
                      <span className="skill-menu-name">{agent.label}</span>
                      <span className="skill-menu-desc">{agent.installed ? 'Its default model' : 'Not installed on the server'}</span>
                    </button>
                  ))}
                  <button className="skill-menu-item" onClick={() => setChoosing(true)}>
                    <span className="skill-menu-name">Choose…</span>
                    <span className="skill-menu-desc">Pick an agent, model and effort for one session</span>
                  </button>
                </>
              )
            ) : (
              interim?.picks.map((llm) => (
                <button key={describeAgent(llm, catalog)} className="skill-menu-item" onClick={() => start(undefined, llm)}>
                  <span className="skill-menu-name">{describeAgent(llm, catalog)}</span>
                  <span className="skill-menu-desc">An agent this project&apos;s settings use</span>
                </button>
              ))
            )}
            {sessionTypes.length > 0 && <div className="skill-menu-group">Session types</div>}
            {sessionTypes.map((type) => {
              // Only once the server listed its agents: before, every agent counts as on.
              const note = listed ? agentNote(type.llm, catalog) : null
              return (
                <button
                  key={type.id}
                  className={`skill-menu-item session-type-menu-item${note ? ' not-installed' : ''}`}
                  title={note ?? type.systemPrompt}
                  disabled={note !== null}
                  onClick={() => start(type)}
                >
                  {type.icon && <img className="session-type-menu-icon" src={type.icon} alt="" />}
                  <span className="session-type-menu-text">
                    <span className="skill-menu-name">
                      {type.name.trim() || 'Untitled'}
                      {type.llm && describeAgent(type.llm, catalog) !== defaultLabel && (
                        <span className="session-type-llm-chip">{describeAgent(type.llm, catalog)}</span>
                      )}
                    </span>
                    {note ? (
                      <span className="skill-menu-desc">{note}</span>
                    ) : (
                      type.systemPrompt.trim() && <span className="skill-menu-desc">{type.systemPrompt.trim()}</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}
