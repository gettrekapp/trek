import { useCallback, useEffect, useState } from 'react'
import {
  baseName,
  branchCustomTags,
  branchTag,
  dormantSessions,
  environmentFor,
  instanceForInfo,
  pullRequestLabel,
  repoOfInfo,
  tagStyle,
  ticketLabel,
  ticketUrl,
  useAppStore
} from '../store'
import { cycleTab, focusInGlobalPanel, focusTerminal, tabCycleStep } from '../terminals'
import { getBackend } from '../backend'
import { useFeatures } from '../useFeatures'
import { branchLabel, gitStatusLabel, splitBranch } from './Sidebar'
import { StatusBadge } from './StatusBadge'
import { DecisionIcon } from './DecisionIcon'
import { SkillMenu } from './SkillMenu'
import { NewSessionMenu } from './NewSessionMenu'
import { DockerMenu } from './DockerMenu'
import { DockerPanel } from './DockerPanel'
import { EnvironmentPanel } from './EnvironmentPanel'
import { StackPanel } from './StackPanel'
import { STACK_STATE_LABELS, stackState, stackUrls } from '../../../shared/stacks'
import { NotesPanel } from './NotesPanel'
import { ChangesPanel, useWorktreeChanges } from './ChangesPanel'
import { changesTabLabel } from '../../../shared/changes'
import { AllNotesPanel } from './AllNotesPanel'
import { SettingsPanel } from './SettingsPanel'
import { TerminalPane } from './TerminalPane'
import { TicketModal } from './TicketModal'
import { PullRequestModal } from './PullRequestModal'
import { envRepoKey } from '../../../shared/environments'
import { getProvider } from '../../../shared/providers/registry'
import { describeLlm } from '../../../shared/providers/selection'
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

type Panel =
  | 'sessions'
  | 'changes'
  | 'notes'
  | 'allNotes'
  | 'docker'
  | 'environment'
  | 'stack'
  | 'settings'

const STACK_POLL_MS = 4000

/** Polls the worktree's docker/stack/stack.sh status on its server; null while `off` or unknown. */
function useStackStatus(
  path: string | undefined,
  off: boolean
): [StackStatus | null, () => void] {
  const [status, setStatus] = useState<StackStatus | null>(null)

  const refresh = useCallback(() => {
    if (!path || off) return
    getBackend()
      .stacks.status({ path })
      .then((next) =>
        setStatus((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      )
      .catch(() => {
        // transient docker/fs error — keep the last status
      })
  }, [path, off])

  useEffect(() => {
    setStatus(null)
    if (!path || off) return undefined
    refresh()
    const interval = setInterval(refresh, STACK_POLL_MS)
    return () => clearInterval(interval)
  }, [path, off, refresh])

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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** The title the rename started from: a server window refuses it if the title changed meanwhile */
  const [editFrom, setEditFrom] = useState('')
  // The window's connection is down: its commands are disabled until it is back.
  const offline = useAppStore((s) => s.serverOffline)
  const environments = useAppStore((s) => s.environments)
  const envBusy = useAppStore((s) => s.envBusy)

  const features = useFeatures()
  const path = info?.path
  // The stack runs on the server's machine (`features.stacks`, any server that has `stacks`).
  const [stack, refreshStack] = useStackStatus(path, !features.stacks)
  const changesState = useWorktreeChanges(path, offline, panel === 'changes')
  useEffect(() => {
    // Selection changed: back to the sessions view, drop transient UI state.
    setPanel('sessions')
    setMenuOpen(false)
    setTagMenuOpen(false)
    setCustomTagMenuOpen(false)
    setEditingId(null)
  }, [path])

  useEffect(() => {
    // A server window lost its link: what is open could only fail now, and an edit
    // in progress would be lost silently, so it all closes.
    if (!offline) return
    setMenuOpen(false)
    setTagMenuOpen(false)
    setCustomTagMenuOpen(false)
    setShowTicket(false)
    setShowPR(false)
    setEditingId(null)
  }, [offline])

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
  // A worktree git no longer lists on the server (its directory is gone): nothing can run in it.
  const missing = !!info.prunable
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
  // The server watches it (5c-1); its last report stays on the chip until dismissed.
  const watchingPr = !!pullRequest && !!info.branch && !!repo.branchPrWatches?.[info.branch]
  const prNotice = info.branch ? repo.branchPrNotices?.[info.branch] : undefined
  const linearIssue = ticket ? linearIssues[ticket] : undefined
  const linkedTicketUrl = ticket ? ticketUrl(project, ticket, linearIssue) : null

  // Notes are keyed to the live branch, so they follow it through promote/demote.
  const noteKey = info.branch ?? instance?.branch ?? instance?.name ?? baseName(info.path)

  const envEnabled = !!repo.environments?.enabled
  const showEnv = features.env && envEnabled && !!info.branch
  const env = showEnv ? environmentFor(environments, envRepoKey(repo), info.branch) : undefined
  const envOpBusy = env ? envBusy[env.profile] : undefined
  const envChipLabel = envOpBusy
    ? { start: 'Env starting…', stop: 'Env stopping…', destroy: 'Env resetting…' }[envOpBusy]
    : env?.vmState === 'running'
      ? `Env${env.address ? ` · ${env.address}` : ''}`
      : 'Env stopped'

  const showStack = features.stacks && !!stack?.available
  const showDocker = features.docker && info.isMain
  const stackStateNow = stack ? stackState(stack) : 'stopped'
  const stackAppUrl = stack ? stackUrls(stack)[0]?.url : undefined

  const openVSCode = (): void => {
    window.api.openInVSCode(info.path).catch((err) => {
      void window.api.showError('Could not open VS Code', String(err))
    })
  }

  const commitRename = (): void => {
    if (editingId) {
      renameTerminal(editingId, draft, editFrom)
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
    // The backend the call went to shows its failure (a server window's, as one line).
    const backend = getBackend()
    try {
      const loc = { path: info.path }
      if (kind === 'pull') await backend.git.pull(loc, info.branch)
      else await backend.git.push(loc, info.branch)
    } catch (err) {
      backend.errors.report(kind === 'pull' ? 'Git pull failed' : 'Git push failed', err)
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
          </div>
          <div className="detail-path">{info.path}</div>
          <div className="detail-chips">
            {info.branch && (
              <span className="tag-chip-wrap">
                <span
                  className={`chip chip-tag ${tag ? '' : 'untagged'}`}
                  style={tag ? tagStyle(tag) : undefined}
                  title="Set the workflow tag for this branch"
                  onClick={() => !offline && setTagMenuOpen((v) => !v)}
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
                    onClick={() => !offline && setCustomTagMenuOpen((v) => !v)}
                  >
                    {t.name}
                  </span>
                ))}
                <span
                  className="chip chip-tag untagged"
                  title="Toggle custom tags for this branch"
                  onClick={() => !offline && setCustomTagMenuOpen((v) => !v)}
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
                className={`chip chip-pr${prNotice ? ' notice' : ''}`}
                title={`${prNotice ? `${prNotice}\n` : ''}Open pull request — ${pullRequest}`}
                onClick={() => window.open(pullRequest)}
              >
                PR {pullRequestLabel(pullRequest)}
                {watchingPr && <span className="chip-pr-watch"> · watching</span>}
              </span>
            )}
            {prNotice && (
              <span className="chip chip-pr-notice" title="Dismiss">
                {prNotice}
                <button
                  className="chip-dismiss"
                  aria-label="Dismiss pull request notice"
                  onClick={() => {
                    if (!offline) void getBackend().branch.dismissPrNotice(info.path).catch((err: unknown) => getBackend().errors.report('Could not dismiss the notice', err))
                  }}
                >
                  ×
                </button>
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
                disabled={offline || syncBusy !== null}
                title={offline ? 'Server disconnected' : `git pull --ff-only origin ${info.branch}`}
                onClick={() => void runGitSync('pull')}
              >
                {syncBusy === 'pull' ? 'Pulling…' : `Pull${info.behind ? ` ↓${info.behind}` : ''}`}
              </button>
              <button
                className="btn btn-ghost"
                disabled={offline || syncBusy !== null}
                title={offline ? 'Server disconnected' : `git push origin ${info.branch}`}
                onClick={() => void runGitSync('push')}
              >
                {syncBusy === 'push' ? 'Pushing…' : `Push${info.ahead ? ` ↑${info.ahead}` : ''}`}
              </button>
            </>
          )}
          {features.openInEditor && (
            <button className="btn btn-accent" onClick={openVSCode}>
              Open in VS Code
            </button>
          )}
          {features.reveal && (
            <button
              className="btn btn-ghost"
              title="Reveal in Finder"
              onClick={() => void window.api.revealInFinder(info.path)}
            >
              Reveal
            </button>
          )}
          <button
            className={`btn btn-ghost btn-icon ${menuOpen ? 'open' : ''}`}
            title={offline ? 'Server disconnected' : 'Worktree actions'}
            disabled={offline}
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
            {features.openInEditor && (
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
            )}
            {features.reveal && (
              <div
                className="detail-menu-item"
                onClick={() => {
                  setMenuOpen(false)
                  void window.api.revealInFinder(info.path)
                }}
              >
                <div className="detail-menu-name">Reveal in Finder</div>
              </div>
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
                {pullRequest && info.branch && (features.prWatch || watchingPr) && (
                  <div
                    className={`detail-menu-item ${busy || offline ? 'disabled' : ''}`}
                    onClick={() => {
                      const branch = info.branch
                      if (offline || !branch) return
                      void runAction(() =>
                        getBackend()
                          .branch.setPrWatch(repo.id, branch, !watchingPr)
                          .catch((err: unknown) => getBackend().errors.report(watchingPr ? 'Could not stop watching the pull request' : 'Could not watch the pull request', err))
                      )
                    }}
                  >
                    <div className="detail-menu-name">{watchingPr ? 'Stop watching pull request' : 'Watch pull request'}</div>
                    <div className="detail-menu-desc">
                      {watchingPr
                        ? 'The server stops following its checks and reviews'
                        : "The server follows its checks, reviews and merge state, and queues a prompt on this worktree's newest session"}
                    </div>
                  </div>
                )}
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
            {/* Promote and Move to another server come back with phase 5's server commands. */}
            {!info.isMain && (
              <div
                className={`detail-menu-item danger ${busy || offline ? 'disabled' : ''}`}
                onClick={() => {
                  if (!offline) void runAction(() => getBackend().worktrees.remove(info, instance))
                }}
              >
                <div className="detail-menu-name">Delete worktree…</div>
                <div className="detail-menu-desc">git worktree remove — deletes the folder</div>
              </div>
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
                  if (e.button === 1 && !offline) void getBackend().sessions.close(id)
                }}
              >
                <StatusBadge
                  status={meta.status}
                  onToggleComplete={offline ? undefined : () => toggleTerminalComplete(id)}
                />
                <DecisionIcon terminalId={id} />
                {icon && <img className="session-tab-icon" src={icon} alt="" />}
                {meta.llm && meta.llm.provider !== 'claude' && (
                  <span className="session-llm-glyph" title={describeLlm(meta.llm)}>
                    {getProvider(meta.llm.provider).glyph}
                  </span>
                )}
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
                      if (isActive && !offline) {
                        e.stopPropagation()
                        setEditingId(id)
                        setDraft(meta.title)
                        setEditFrom(meta.title)
                      }
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      if (offline) return
                      setEditingId(id)
                      setDraft(meta.title)
                      setEditFrom(meta.title)
                    }}
                  >
                    {meta.title}
                  </span>
                )}
                {features.skills && meta.status !== 'exited' && (
                  <SkillMenu worktree={instance} terminalId={id} />
                )}
                <span
                  className={`session-tab-close ${offline ? 'disabled' : ''}`}
                  title={offline ? 'Server disconnected' : 'Close session'}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!offline) void getBackend().sessions.close(id)
                  }}
                >
                  ×
                </span>
              </div>
            )
          })}
        <NewSessionMenu
          title={offline ? 'Server disconnected' : missing ? 'The worktree is missing on the server' : 'New session (⌘T)'}
          disabled={offline || missing}
          onStart={(sessionType, llm) => {
            setPanel('sessions')
            void getBackend().sessions.start({ path: info.path }, sessionType, llm)
          }}
        />
        <div className="session-row-spacer" />
        {instance && loaded && order.length > 0 && (
          <button
            className="panel-btn"
            title="End this worktree's sessions to free CPU — they stay saved and resume when you load it again"
            disabled={offline}
            onClick={() => void getBackend().worktrees.unload(instance.id)}
          >
            ⏏ Unload
          </button>
        )}
        <button
          className={`panel-btn ${panel === 'changes' ? 'active' : ''}`}
          title="Changes compared to the default branch, including uncommitted work"
          onClick={() => setPanel(panel === 'changes' ? 'sessions' : 'changes')}
        >
          {changesTabLabel(changesState.changes)}
        </button>
        <button
          className={`panel-btn ${panel === 'notes' ? 'active' : ''}`}
          title={`Notes for ${noteKey}`}
          onClick={() => setPanel(panel === 'notes' ? 'sessions' : 'notes')}
        >
          Notes
        </button>
        {info.isMain && (
          <button
            className={`panel-btn ${panel === 'allNotes' ? 'active' : ''}`}
            title="All notes collected across branches"
            onClick={() => setPanel(panel === 'allNotes' ? 'sessions' : 'allNotes')}
          >
            All Notes
          </button>
        )}
        {showDocker && (
          <button
            className={`panel-btn ${panel === 'docker' ? 'active' : ''}`}
            onClick={() => setPanel(panel === 'docker' ? 'sessions' : 'docker')}
          >
            Docker <DockerMenu key={repo.id} repoId={repo.id} />
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
        {features.settingsEdit && (
          <button
            className={`panel-btn ${panel === 'settings' ? 'active' : ''}`}
            title="App settings"
            onClick={() => setPanel(panel === 'settings' ? 'sessions' : 'settings')}
          >
            ⚙
          </button>
        )}
      </div>

      <div className="terminal-card">
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
                  Unloaded — {dormant.length} saved session
                  {dormant.length === 1 ? '' : 's'}: {dormant.map((t) => t.title).join(', ')}
                </span>
                <button
                  className="btn btn-accent"
                  disabled={offline || missing}
                  onClick={() => void getBackend().worktrees.load(instance.id)}
                >
                  Load session{dormant.length === 1 ? '' : 's'}
                </button>
                <span className="no-session-hint">
                  {missing
                    ? 'Its directory is gone on the server: delete the worktree to drop it.'
                    : 'Loading resumes each session where it left off.'}
                </span>
              </>
            ) : (
              <>
                <span>No session in this worktree yet.</span>
                <button
                  className="btn btn-accent"
                  disabled={offline || missing}
                  onClick={() =>
                    void getBackend().sessions.start(
                      instance ? { worktreeId: instance.id } : { path: info.path }
                    )
                  }
                >
                  Start session
                </button>
              </>
            )}
          </div>
        )}
        <ChangesPanel
          key={info.path}
          visible={panel === 'changes'}
          paused={offline}
          state={changesState}
        />
        <NotesPanel visible={panel === 'notes'} repoId={repo.id} noteKey={noteKey} />
        {info.isMain && <AllNotesPanel visible={panel === 'allNotes'} worktrees={worktrees} />}
        {showDocker && <DockerPanel key={repo.id} visible={panel === 'docker'} />}
        {showEnv && <EnvironmentPanel visible={panel === 'environment'} info={info} />}
        {showStack && stack && (
          <StackPanel
            visible={panel === 'stack'}
            worktreePath={info.path}
            status={stack}
            onChanged={refreshStack}
          />
        )}
        {features.settingsEdit && <SettingsPanel visible={panel === 'settings'} />}
      </div>

      {showTicket && info.branch && (
        <TicketModal repoId={repo.id} branch={info.branch} onClose={() => setShowTicket(false)} />
      )}
      {showPR && info.branch && (
        <PullRequestModal repoId={repo.id} branch={info.branch} onClose={() => setShowPR(false)} />
      )}
    </main>
  )
}
