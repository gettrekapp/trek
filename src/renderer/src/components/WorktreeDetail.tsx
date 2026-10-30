import { useCallback, useEffect, useState } from 'react'
import {
  baseName,
  branchCustomTags,
  branchTag,
  dormantSessions,
  environmentFor,
  hostRepoPath,
  instanceForInfo,
  pullRequestLabel,
  repoOfInfo,
  serverById,
  serverColorClass,
  tagStyle,
  ticketLabel,
  ticketUrl,
  useAppStore
} from '../store'
import {
  createTerminal,
  cycleTab,
  disposeTerminal,
  focusInGlobalPanel,
  focusTerminal,
  loadWorktree,
  startClaudeSession,
  tabCycleStep,
  unloadWorktree
} from '../terminals'
import { scheduleAutoSave } from '../persistence'
import { deleteWorktree, promoteBranchToWorktree, promoteToPrimary } from '../worktreeActions'
import { branchLabel, gitStatusLabel, splitBranch } from './Sidebar'
import { StatusBadge } from './StatusBadge'
import { DecisionIcon } from './DecisionIcon'
import { SkillMenu } from './SkillMenu'
import { NewSessionMenu } from './NewSessionMenu'
import { DockerMenu } from './DockerMenu'
import { DockerPanel } from './DockerPanel'
import { EnvironmentPanel } from './EnvironmentPanel'
import { StackPanel } from './StackPanel'
import { STACK_STATE_LABELS, stackState, stackUrls } from '../stacks'
import { NotesPanel } from './NotesPanel'
import { AllNotesPanel } from './AllNotesPanel'
import { SettingsPanel } from './SettingsPanel'
import { TerminalPane } from './TerminalPane'
import { TicketModal } from './TicketModal'
import { PullRequestModal } from './PullRequestModal'
import { MoveWorktreeModal } from './MoveWorktreeModal'
import type { GitWorktreeInfo, Repository, StackStatus } from '../../../shared/types'

interface Props {
  info: GitWorktreeInfo | undefined
  /** Set when there is no row to show because the selected repository can't be read. */
  unreadableRepo?: Repository
  /** All live git worktrees, for the All Notes panel's "no worktree" markers */
  worktrees: GitWorktreeInfo[]
  /** Called after actions that change the set of worktrees (delete/promote). */
  onWorktreesChanged: () => void
}

type Panel = 'sessions' | 'notes' | 'allNotes' | 'docker' | 'environment' | 'stack' | 'settings'

const STACK_POLL_MS = 4000

/** Polls the worktree's docker/stack/stack.sh status; null for remote or unknown. */
function useStackStatus(
  path: string | undefined,
  remote: boolean
): [StackStatus | null, () => void] {
  const [status, setStatus] = useState<StackStatus | null>(null)

  const refresh = useCallback(() => {
    if (!path || remote) return
    window.api
      .stackStatus(path)
      .then((next) =>
        setStatus((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      )
      .catch(() => {
        // transient docker/fs error — keep the last status
      })
  }, [path, remote])

  useEffect(() => {
    setStatus(null)
    if (!path || remote) return undefined
    refresh()
    const interval = setInterval(refresh, STACK_POLL_MS)
    return () => clearInterval(interval)
  }, [path, remote, refresh])

  return [status, refresh]
}

export function WorktreeDetail({
  info,
  unreadableRepo,
  worktrees,
  onWorktreesChanged
}: Props): React.JSX.Element {
  const project = useAppStore((s) => s.project)!
  const terminals = useAppStore((s) => s.terminals)
  const decisions = useAppStore((s) => s.decisions)
  const terminalOrder = useAppStore((s) => s.terminalOrder)
  const loadedWorktrees = useAppStore((s) => s.loadedWorktrees)
  const activeTerminal = useAppStore((s) => s.activeTerminal)
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal)
  const renameTerminal = useAppStore((s) => s.renameTerminal)
  const toggleTerminalComplete = useAppStore((s) => s.toggleTerminalComplete)
  const setBranchTag = useAppStore((s) => s.setBranchTag)
  const setBranchCustomTag = useAppStore((s) => s.setBranchCustomTag)
  const linearIssues = useAppStore((s) => s.linearIssues)

  const [panel, setPanel] = useState<Panel>('sessions')
  const [menuOpen, setMenuOpen] = useState(false)
  const [tagMenuOpen, setTagMenuOpen] = useState(false)
  const [customTagMenuOpen, setCustomTagMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [syncBusy, setSyncBusy] = useState<'pull' | 'push' | null>(null)
  const [showTicket, setShowTicket] = useState(false)
  const [showPR, setShowPR] = useState(false)
  // Move target: 'local' or a server id — null when no move is in progress
  const [moveTarget, setMoveTarget] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const serverStatus = useAppStore((s) => s.serverStatus)
  const environments = useAppStore((s) => s.environments)
  const envBusy = useAppStore((s) => s.envBusy)

  const path = info?.path
  const [stack, refreshStack] = useStackStatus(path, !!info?.serverId)
  useEffect(() => {
    // Selection changed: back to the sessions view, drop transient UI state.
    setPanel('sessions')
    setMenuOpen(false)
    setTagMenuOpen(false)
    setCustomTagMenuOpen(false)
    setEditingId(null)
  }, [path])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const step = tabCycleStep(e)
      const worktreeId = useAppStore.getState().activeWorktreeId
      if (!step || !worktreeId || focusInGlobalPanel()) return
      e.preventDefault()
      e.stopPropagation()
      setPanel('sessions')
      cycleTab(worktreeId, step)
    }
    // Capture phase, so the focused xterm never sees the keystroke.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  if (!info && unreadableRepo) {
    return (
      <main className="detail detail-empty detail-unreadable muted">
        Can’t read the repository {unreadableRepo.name} at {unreadableRepo.path}
      </main>
    )
  }

  if (!info) {
    return <main className="detail detail-empty muted">Reading worktrees…</main>
  }

  const repo = repoOfInfo(project, info)
  const instance = instanceForInfo(project, info)
  const isRemote = !!info.serverId
  const server = serverById(project, info.serverId)
  const hostDown = isRemote && serverStatus[info.serverId!] !== 'connected'
  const isLocalMain = info.isMain && !isRemote
  const order = (instance && terminalOrder[instance.id]) || []
  const activeId = instance ? activeTerminal[instance.id] : undefined
  const loaded = !!instance && !!loadedWorktrees[instance.id]
  // Sessions saved for an unloaded worktree — what loading it resumes.
  const dormant = instance ? dormantSessions({ project, loadedWorktrees }, instance.id) : []
  const { prefix, name } = splitBranch(branchLabel(info))
  const git = gitStatusLabel(info)
  const clean = !git && info.dirty === false
  const tag = branchTag(project, repo, info.branch)
  const customTags = project.customTags ?? []
  const enabledCustomTags = branchCustomTags(project, repo, info.branch)
  // Ticket/PR links are keyed by branch, so they follow it through
  // promote/demote and worktree re-creation.
  const ticket = info.branch ? repo.branchTickets?.[info.branch] : undefined
  const pullRequest = info.branch ? repo.branchPullRequests?.[info.branch] : undefined
  const linearIssue = ticket ? linearIssues[ticket] : undefined
  const linkedTicketUrl = ticket ? ticketUrl(project, ticket, linearIssue) : null

  // Notes are keyed to the live branch, so they follow it through promote/demote.
  const noteKey = info.branch ?? instance?.branch ?? instance?.name ?? baseName(info.path)

  const envEnabled = !!repo.environments?.enabled
  const showEnv = envEnabled && !isRemote && !!info.branch
  const env = showEnv ? environmentFor(environments, repo.path, info.branch) : undefined
  const envOpBusy = env ? envBusy[env.profile] : undefined
  const envChipLabel = envOpBusy
    ? { start: 'Env starting…', stop: 'Env stopping…', destroy: 'Env resetting…' }[envOpBusy]
    : env?.vmState === 'running'
      ? `Env${env.address ? ` · ${env.address}` : ''}`
      : 'Env stopped'

  const showStack = !isRemote && !!stack?.available
  const stackStateNow = stack ? stackState(stack) : 'stopped'
  const stackAppUrl = stack ? stackUrls(stack)[0]?.url : undefined

  const openVSCode = (): void => {
    window.api.openInVSCode(info.path).catch((err) => {
      void window.api.showError('Could not open VS Code', String(err))
    })
  }

  const commitRename = (): void => {
    if (editingId) {
      renameTerminal(editingId, draft)
      scheduleAutoSave() // session titles persist in the project file
    }
    setEditingId(null)
  }

  const selectSession = (id: string): void => {
    if (!instance) return
    setPanel('sessions')
    setActiveTerminal(instance.id, id)
    focusTerminal(id)
  }

  const runGitSync = async (kind: 'pull' | 'push'): Promise<void> => {
    if (!info.branch || syncBusy) return
    setSyncBusy(kind)
    try {
      if (kind === 'pull') {
        await window.api.pullBranch(info.serverId ?? null, info.path, info.branch)
      } else {
        await window.api.pushBranch(info.serverId ?? null, info.path, info.branch)
      }
    } catch (err) {
      void window.api.showError(kind === 'pull' ? 'Git pull failed' : 'Git push failed', String(err))
    } finally {
      setSyncBusy(null)
      onWorktreesChanged() // refresh ahead/behind counts
    }
  }

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    setMenuOpen(false)
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
      onWorktreesChanged()
    }
  }

  return (
    <main className="detail">
      <div className="detail-header">
        <div className="detail-title-block">
          <div className="detail-title">
            <span className="wt-prefix">{prefix}</span>
            {name}
            {server && (
              <span
                className={`mini-chip server-chip title-server-chip ${serverColorClass(server.id)} ${hostDown ? 'down' : ''}`}
                title={hostDown ? `${server.name} — disconnected` : `Runs on ${server.name}`}
              >
                {hostDown ? '⏻ ' : ''}
                {server.name}
              </span>
            )}
          </div>
          <div className="detail-path">
            {server ? `${server.name}:` : ''}
            {info.path}
          </div>
          <div className="detail-chips">
            {info.branch && (
              <span className="tag-chip-wrap">
                <span
                  className={`chip chip-tag ${tag ? '' : 'untagged'}`}
                  style={tag ? tagStyle(tag) : undefined}
                  title="Set the workflow tag for this branch"
                  onClick={() => setTagMenuOpen((v) => !v)}
                >
                  {tag?.name ?? 'No tag'} <span className="chip-caret">▾</span>
                </span>
                {tagMenuOpen && (
                  <>
                    <div className="detail-menu-backdrop" onClick={() => setTagMenuOpen(false)} />
                    <div className="tag-menu">
                      {(project.worktreeTags ?? []).map((t) => (
                        <div
                          key={t.id}
                          className={`tag-menu-item ${t.id === tag?.id ? 'active' : ''}`}
                          onClick={() => {
                            setBranchTag(repo.id, info.branch!, t.id)
                            scheduleAutoSave()
                            setTagMenuOpen(false)
                          }}
                        >
                          <span className="tag-dot" style={{ color: t.color }} />
                          {t.name}
                          {t.id === tag?.id && <span className="tag-check">✓</span>}
                        </div>
                      ))}
                      {tag && (
                        <>
                          <div className="detail-menu-divider" />
                          <div
                            className="tag-menu-item clear"
                            onClick={() => {
                              setBranchTag(repo.id, info.branch!, null)
                              scheduleAutoSave()
                              setTagMenuOpen(false)
                            }}
                          >
                            Remove tag
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}
              </span>
            )}
            {info.branch && customTags.length > 0 && (
              <span className="tag-chip-wrap">
                {enabledCustomTags.map((t) => (
                  <span
                    key={t.id}
                    className="chip chip-tag"
                    style={tagStyle(t)}
                    title="Toggle custom tags for this branch"
                    onClick={() => setCustomTagMenuOpen((v) => !v)}
                  >
                    {t.name}
                  </span>
                ))}
                <span
                  className="chip chip-tag untagged"
                  title="Toggle custom tags for this branch"
                  onClick={() => setCustomTagMenuOpen((v) => !v)}
                >
                  {enabledCustomTags.length ? '+' : '+ Tags'}
                </span>
                {customTagMenuOpen && (
                  <>
                    <div
                      className="detail-menu-backdrop"
                      onClick={() => setCustomTagMenuOpen(false)}
                    />
                    <div className="tag-menu">
                      {customTags.map((t) => {
                        const on = enabledCustomTags.includes(t)
                        return (
                          <div
                            key={t.id}
                            className={`tag-menu-item ${on ? 'active' : ''}`}
                            onClick={() => {
                              setBranchCustomTag(repo.id, info.branch!, t.id, !on)
                              scheduleAutoSave()
                            }}
                          >
                            <span className="tag-dot" style={{ color: t.color }} />
                            {t.name}
                            {on && <span className="tag-check">✓</span>}
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </span>
            )}
            {ticket && (
              <span
                className="chip chip-ticket"
                title={
                  linkedTicketUrl
                    ? `Open ticket ${ticketLabel(ticket)}${linearIssue ? ` — ${linearIssue.title}` : ''}`
                    : `Ticket ${ticketLabel(ticket)} (link it by URL once to make this clickable)`
                }
                onClick={() => {
                  if (linkedTicketUrl) window.open(linkedTicketUrl)
                }}
              >
                {linearIssue ? ticketLabel(ticket) : `Ticket ${ticketLabel(ticket)}`}
                {linearIssue && (
                  <>
                    <span className="ticket-status">
                      <span
                        className="ticket-status-dot"
                        style={{ background: linearIssue.statusColor }}
                      />
                      {linearIssue.status}
                    </span>
                    <span className="ticket-title">{linearIssue.title}</span>
                  </>
                )}
              </span>
            )}
            {pullRequest && (
              <span
                className="chip chip-pr"
                title={`Open pull request — ${pullRequest}`}
                onClick={() => window.open(pullRequest)}
              >
                PR {pullRequestLabel(pullRequest)}
              </span>
            )}
            {git && <span className="chip chip-git">{git}</span>}
            {clean && <span className="chip chip-clean">Clean</span>}
            {showEnv && (env || envOpBusy) && (
              <span
                className={`chip chip-env ${envOpBusy ? 'busy' : env?.vmState === 'running' ? 'running' : 'stopped'}`}
                title="Open environment panel"
                onClick={() => setPanel('environment')}
              >
                {envChipLabel}
              </span>
            )}
            {showStack && stackStateNow !== 'stopped' && (
              <span
                className={`chip chip-env ${stackStateNow === 'running' ? 'running' : 'busy'}`}
                title={
                  stackStateNow === 'running' && stackAppUrl
                    ? `Open ${stackAppUrl}`
                    : 'Open stack panel'
                }
                onClick={() => {
                  if (stackStateNow === 'running' && stackAppUrl) window.open(stackAppUrl)
                  else setPanel('stack')
                }}
              >
                Stack{' '}
                {stackStateNow === 'running' && stack?.port
                  ? `· :${stack.port}`
                  : STACK_STATE_LABELS[stackStateNow]}
              </span>
            )}
          </div>
        </div>
        <div className="detail-actions">
          {info.branch && (
            <>
              <button
                className="btn btn-ghost"
                disabled={hostDown || syncBusy !== null}
                title={
                  hostDown
                    ? 'Server disconnected'
                    : `git pull --ff-only origin ${info.branch}`
                }
                onClick={() => void runGitSync('pull')}
              >
                {syncBusy === 'pull' ? 'Pulling…' : `Pull${info.behind ? ` ↓${info.behind}` : ''}`}
              </button>
              <button
                className="btn btn-ghost"
                disabled={hostDown || syncBusy !== null}
                title={hostDown ? 'Server disconnected' : `git push origin ${info.branch}`}
                onClick={() => void runGitSync('push')}
              >
                {syncBusy === 'push' ? 'Pushing…' : `Push${info.ahead ? ` ↑${info.ahead}` : ''}`}
              </button>
            </>
          )}
          {!isRemote && (
            <>
              <button className="btn btn-accent" onClick={openVSCode}>
                Open in VS Code
              </button>
              <button
                className="btn btn-ghost"
                title="Reveal in Finder"
                onClick={() => void window.api.revealInFinder(info.path)}
              >
                Reveal
              </button>
            </>
          )}
          <button
            className={`btn btn-ghost btn-icon ${menuOpen ? 'open' : ''}`}
            title="Worktree actions"
            onClick={() => setMenuOpen((v) => !v)}
          >
            …
          </button>
        </div>
      </div>

      {menuOpen && (
        <>
          <div className="detail-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="detail-menu">
            {isRemote ? (
              <div className="detail-menu-item disabled">
                <div className="detail-menu-name">Remote worktree on {server?.name ?? 'server'}</div>
                <div className="detail-menu-desc">{info.path}</div>
              </div>
            ) : (
              <>
                <div
                  className="detail-menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    openVSCode()
                  }}
                >
                  <div className="detail-menu-name">Open in VS Code</div>
                  <div className="detail-menu-desc">{info.path}</div>
                </div>
                <div
                  className="detail-menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    void window.api.revealInFinder(info.path)
                  }}
                >
                  <div className="detail-menu-name">Reveal in Finder</div>
                </div>
              </>
            )}
            {info.branch && (
              <>
                <div className="detail-menu-divider" />
                <div
                  className="detail-menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    setShowTicket(true)
                  }}
                >
                  <div className="detail-menu-name">
                    Ticket {ticket ? ticketLabel(ticket) : '(none)'}…
                  </div>
                  <div className="detail-menu-desc">Change or unlink the linked ticket</div>
                </div>
                <div
                  className="detail-menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    setShowPR(true)
                  }}
                >
                  <div className="detail-menu-name">
                    Pull request {pullRequest ? pullRequestLabel(pullRequest) : '(none)'}…
                  </div>
                  <div className="detail-menu-desc">
                    Change or unlink the linked pull request
                  </div>
                </div>
                {(linkedTicketUrl || pullRequest) && (
                  <div
                    className="detail-menu-item"
                    onClick={() => {
                      setMenuOpen(false)
                      if (linkedTicketUrl) window.open(linkedTicketUrl)
                      if (pullRequest) window.open(pullRequest)
                    }}
                  >
                    <div className="detail-menu-name">Open ticket &amp; PR in browser</div>
                  </div>
                )}
              </>
            )}
            <div className="detail-menu-divider" />
            {isLocalMain ? (
              <div
                className={`detail-menu-item ${busy ? 'disabled' : ''}`}
                onClick={() => void runAction(() => promoteBranchToWorktree(repo.id, info.branch))}
              >
                <div className="detail-menu-name">Promote branch to worktree…</div>
                <div className="detail-menu-desc">
                  Move {info.branch ?? 'the current branch'} to its own worktree; main repo
                  returns to the default branch
                </div>
              </div>
            ) : (
              <>
                {!isRemote && !info.isMain && (
                  <div
                    className={`detail-menu-item ${busy ? 'disabled' : ''}`}
                    onClick={() => void runAction(() => promoteToPrimary(info, instance))}
                  >
                    <div className="detail-menu-name">Promote to primary…</div>
                    <div className="detail-menu-desc">
                      Check out {info.branch ?? 'this branch'} in the main repo
                    </div>
                  </div>
                )}
                {!info.isMain &&
                  info.branch &&
                  (() => {
                    // Every other host with a clone is a move target: local (if this
                    // row is remote) plus each server except its own.
                    const targets: { key: string; name: string; down: boolean }[] = [
                      ...(isRemote ? [{ key: 'local', name: 'this machine', down: false }] : []),
                      ...(project.servers ?? [])
                        .filter((s) => s.id !== info.serverId && hostRepoPath(repo, s.id))
                        .map((s) => ({
                          key: s.id,
                          name: s.name,
                          down: serverStatus[s.id] !== 'connected'
                        }))
                    ]
                    return targets.map((target) => (
                      <div
                        key={target.key}
                        className={`detail-menu-item ${busy || hostDown || target.down ? 'disabled' : ''}`}
                        onClick={() => {
                          if (busy || hostDown || target.down) return
                          setMenuOpen(false)
                          setMoveTarget(target.key)
                        }}
                      >
                        <div className="detail-menu-name">Move to {target.name}…</div>
                        <div className="detail-menu-desc">
                          {target.down
                            ? `${target.name} is disconnected`
                            : `Recreate this worktree and its Claude sessions on ${target.name}`}
                        </div>
                      </div>
                    ))
                  })()}
                {!info.isMain && (
                  <div
                    className={`detail-menu-item danger ${busy || hostDown ? 'disabled' : ''}`}
                    onClick={() => {
                      if (!hostDown) void runAction(() => deleteWorktree(info, instance))
                    }}
                  >
                    <div className="detail-menu-name">Delete worktree…</div>
                    <div className="detail-menu-desc">git worktree remove — deletes the folder</div>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      <div className="session-row">
        {instance &&
          order.map((id) => {
            const meta = terminals[id]
            if (!meta) return null
            const isActive = panel === 'sessions' && id === activeId
            const icon = meta.sessionTypeId
              ? project.sessionTypes?.find((t) => t.id === meta.sessionTypeId)?.icon
              : undefined
            return (
              <div
                key={id}
                className={`session-tab ${isActive ? 'active' : ''} status-${meta.status} ${
                  decisions[id] ? 'has-decision' : ''
                }`}
                onClick={() => selectSession(id)}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault()
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) disposeTerminal(id)
                }}
              >
                <StatusBadge
                  status={meta.status}
                  onToggleComplete={() => toggleTerminalComplete(id)}
                />
                <DecisionIcon terminalId={id} />
                {icon && <img className="session-tab-icon" src={icon} alt="" />}
                {editingId === id ? (
                  <input
                    className="tab-title-input"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="session-tab-title"
                    title={isActive ? 'Click to rename' : meta.title}
                    onClick={(e) => {
                      if (isActive) {
                        e.stopPropagation()
                        setEditingId(id)
                        setDraft(meta.title)
                      }
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setEditingId(id)
                      setDraft(meta.title)
                    }}
                  >
                    {meta.title}
                  </span>
                )}
                {meta.status !== 'exited' && <SkillMenu worktree={instance} terminalId={id} />}
                <span
                  className="session-tab-close"
                  title="Close session"
                  onClick={(e) => {
                    e.stopPropagation()
                    disposeTerminal(id)
                  }}
                >
                  ×
                </span>
              </div>
            )
          })}
        <NewSessionMenu
          title={hostDown ? 'Server disconnected' : 'New Claude session (⌘T)'}
          disabled={hostDown}
          onStart={(sessionType) => {
            setPanel('sessions')
            void startClaudeSession({ serverId: info.serverId, path: info.path }, sessionType)
          }}
        />
        <div className="session-row-spacer" />
        {instance && loaded && order.length > 0 && (
          <button
            className="panel-btn"
            title="End this worktree's Claude sessions to free CPU — they stay saved and resume when you load it again"
            onClick={() => unloadWorktree(instance.id)}
          >
            ⏏ Unload
          </button>
        )}
        <button
          className={`panel-btn ${panel === 'notes' ? 'active' : ''}`}
          title={`Notes for ${noteKey}`}
          onClick={() => setPanel(panel === 'notes' ? 'sessions' : 'notes')}
        >
          Notes
        </button>
        {isLocalMain && (
          <button
            className={`panel-btn ${panel === 'allNotes' ? 'active' : ''}`}
            title="All notes collected across branches"
            onClick={() => setPanel(panel === 'allNotes' ? 'sessions' : 'allNotes')}
          >
            All Notes
          </button>
        )}
        {isLocalMain && (
          <button
            className={`panel-btn ${panel === 'docker' ? 'active' : ''}`}
            onClick={() => setPanel(panel === 'docker' ? 'sessions' : 'docker')}
          >
            Docker <DockerMenu key={repo.id} repoPath={repo.path} />
          </button>
        )}
        {showEnv && (
          <button
            className={`panel-btn ${panel === 'environment' ? 'active' : ''}`}
            title="Isolated Docker environment for this worktree"
            onClick={() => setPanel(panel === 'environment' ? 'sessions' : 'environment')}
          >
            Env
            {env && (
              <span
                className={`docker-dot ${envOpBusy ? 'attention' : env.vmState === 'running' ? 'running' : 'exited'}`}
              />
            )}
          </button>
        )}
        {showStack && (
          <button
            className={`panel-btn ${panel === 'stack' ? 'active' : ''}`}
            title="This worktree's dev stack (docker/stack/stack.sh)"
            onClick={() => setPanel(panel === 'stack' ? 'sessions' : 'stack')}
          >
            Stack
            <span
              className={`docker-dot ${stackStateNow === 'running' ? 'running' : stackStateNow === 'stopped' ? 'exited' : 'attention'}`}
            />
          </button>
        )}
        <button
          className={`panel-btn ${panel === 'settings' ? 'active' : ''}`}
          title="App settings"
          onClick={() => setPanel(panel === 'settings' ? 'sessions' : 'settings')}
        >
          ⚙
        </button>
      </div>

      <div className="terminal-card">
        {hostDown && panel === 'sessions' && (
          <div className="host-down-banner">
            <span className="wt-dot exited" />
            {server?.name ?? 'Server'} is disconnected — sessions keep running on the server and
            reattach when the connection returns.
          </div>
        )}
        {order.map((id) => (
          <TerminalPane
            key={id}
            terminalId={id}
            visible={panel === 'sessions' && id === activeId}
          />
        ))}
        {panel === 'sessions' && order.length === 0 && (
          <div className="no-session">
            {dormant.length > 0 && instance ? (
              <>
                <span>
                  Unloaded — {dormant.length} saved Claude session
                  {dormant.length === 1 ? '' : 's'}: {dormant.map((t) => t.title).join(', ')}
                </span>
                <button
                  className="btn btn-accent"
                  disabled={hostDown}
                  onClick={() => void loadWorktree(instance.id)}
                >
                  Load session{dormant.length === 1 ? '' : 's'}
                </button>
                <span className="no-session-hint">
                  Loading resumes each session where it left off.
                </span>
              </>
            ) : (
              <>
                <span>No Claude session in this worktree yet.</span>
                <button
                  className="btn btn-accent"
                  disabled={hostDown}
                  onClick={() =>
                    instance
                      ? void createTerminal(instance.id, instance.path)
                      : void startClaudeSession({ serverId: info.serverId, path: info.path })
                  }
                >
                  Start Claude session
                </button>
              </>
            )}
          </div>
        )}
        <NotesPanel visible={panel === 'notes'} repoId={repo.id} noteKey={noteKey} />
        {isLocalMain && (
          <>
            <AllNotesPanel visible={panel === 'allNotes'} worktrees={worktrees} />
            <DockerPanel key={repo.id} visible={panel === 'docker'} />
          </>
        )}
        {showEnv && <EnvironmentPanel visible={panel === 'environment'} info={info} />}
        {showStack && stack && (
          <StackPanel
            visible={panel === 'stack'}
            worktreePath={info.path}
            status={stack}
            onChanged={refreshStack}
          />
        )}
        <SettingsPanel visible={panel === 'settings'} />
      </div>

      {showTicket && info.branch && (
        <TicketModal repoId={repo.id} branch={info.branch} onClose={() => setShowTicket(false)} />
      )}
      {showPR && info.branch && (
        <PullRequestModal repoId={repo.id} branch={info.branch} onClose={() => setShowPR(false)} />
      )}
      {moveTarget && (
        <MoveWorktreeModal
          info={info}
          instance={instance}
          targetServerId={moveTarget === 'local' ? undefined : moveTarget}
          onClose={() => setMoveTarget(null)}
          onMoved={onWorktreesChanged}
        />
      )}
    </main>
  )
}
