import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  baseName,
  branchCustomTags,
  branchTag,
  dormantSessions,
  instanceForInfo,
  repoOfInfo,
  useAppStore
} from '../store'
import { useTicketViews } from '../plugins/useTickets'
import { usePrProviders } from '../plugins/usePrProviders'
import { prLabel, prOwner } from '../../../shared/plugins/pullRequests.ts'
import { cycleTab, focusInGlobalPanel, focusTerminal, tabCycleStep } from '../terminals'
import { getBackend } from '../backend'
import { PluginPanels, PluginWorktreeSlot, usePluginPanels } from '../plugins/WorktreeSlots'
import { pluginWorktreeOf } from '../plugins/projectView'
import { runDot as runMenuDot } from '../plugins/slots'
import { useFeatures } from '../useFeatures'
import { branchLabel, splitBranch } from './Sidebar'
import { SessionIndicator } from '../plugins/SessionIndicator'
import { DecisionIcon } from './DecisionIcon'
import { SkillMenu } from './SkillMenu'
import { NewSessionMenu } from './NewSessionMenu'
import { DockerMenu } from './DockerMenu'
import { DockerPanel } from './DockerPanel'
import { StackPanel } from './StackPanel'
import { STACK_STATE_LABELS, stackState, stackUrls } from '../../../shared/stacks'
import { NotesPanel } from './NotesPanel'
import { ChangesPanel, useWorktreeChanges, type ReviewTarget } from './ChangesPanel'
import { BRANCH_SOURCE } from '../../../shared/review'
import type { ChangesSource } from '../../../shared/types'
import { changesTabLabel } from '../../../shared/changes'
import { HistoryPanel } from './HistoryPanel'
import { TerminalPane } from './TerminalPane'
import { TicketModal } from './TicketModal'
import { PullRequestModal } from './PullRequestModal'
import { MoveWorktreeModal } from './MoveWorktreeModal'
import { useAppServerLinks } from '../useAppServerLinks'
import { moveTargets } from '../v2/moveFlow'
import { isPromoting, subscribePromoting } from '../v2/promoteFlow'
import { describeAgent } from '../../../shared/agents/catalog.ts'
import { DEFAULT_AGENT_ID } from '../../../shared/plugins/agents.ts'
import { useAgentCatalog } from '../agents'
import { AgentGlyph } from './AgentBits'
import type { GitWorktreeInfo, Repository, StackStatus } from '../../../shared/types'

interface Props {
  info: GitWorktreeInfo | undefined
  /** Set when there is no row to show because the selected repository can't be read. */
  unreadableRepo?: Repository
  /** Called after actions that change the set of worktrees (delete/promote). */
  onWorktreesChanged: () => void
}

type Panel =
  | 'sessions'
  | 'changes'
  | 'notes'
  | 'history'
  | 'docker'
  | 'stack'
  | `plugin:${string}`

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
  const ticketViewOf = useTicketViews()
  const catalog = useAgentCatalog()

  const [panel, setPanel] = useState<Panel>('sessions')
  const [menuOpen, setMenuOpen] = useState(false)
  // The Run menu (Docker, Env, Stack): a press anywhere outside it, or the Docker ▾ menu, closes it.
  const [runOpen, setRunOpen] = useState(false)
  useEffect(() => {
    if (!runOpen) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!target.closest('.run-group') && !target.closest('.docker-menu')) setRunOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [runOpen])
  const [tagMenuOpen, setTagMenuOpen] = useState(false)
  const [customTagMenuOpen, setCustomTagMenuOpen] = useState(false)
  const [menuBusy, setBusy] = useState(false)
  // A promote runs on this worktree in this window (an agent's request included, 5e): its
  // Delete, Move and Promote are disabled until it is done.
  const promoting = useSyncExternalStore(subscribePromoting, () => (info ? isPromoting(info.path) : false))
  const busy = menuBusy || promoting
  const [syncBusy, setSyncBusy] = useState<'pull' | 'push' | null>(null)
  const [showTicket, setShowTicket] = useState(false)
  const [showPR, setShowPR] = useState(false)
  /**
   * The worktree the Move dialog was opened on, held from the click: once the move removes its row
   * the detail shows another worktree, and the dialog must stay on the one it moved.
   */
  const [moving, setMoving] = useState<{ from: { projectId: string; worktreeId: string }; info: GitWorktreeInfo; name: string } | null>(null)
  const appServers = useAppServerLinks()
  const ownEntry = useAppStore((s) => s.serverWindow?.serverEntryId ?? '')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** The title the rename started from: a server window refuses it if the title changed meanwhile */
  const [editFrom, setEditFrom] = useState('')
  // The window's connection is down: its commands are disabled until it is back.
  const offline = useAppStore((s) => s.serverOffline)
  // A project page (Settings, Automations) covers the detail: its panes are hidden meanwhile.
  const projectPage = useAppStore((s) => s.projectPage)

  const features = useFeatures()
  const prProviders = usePrProviders()
  const canMove = features.moveWorktree && moveTargets(appServers.servers, ownEntry).length > 0
  const path = info?.path
  // The stack runs on the server's machine (`features.stacks`, any server that has `stacks`).
  const [stack, refreshStack] = useStackStatus(path, !features.stacks)
  // What the Changes tab compares (5c-2): a server without `review` is asked without a source.
  // Held with the worktree it was picked on, so a new selection never asks for the old source
  // with the new path (the reset below lands a render later).
  const [changesPick, setChangesPick] = useState<{ path: string | undefined; source: ChangesSource }>({ path, source: BRANCH_SOURCE })
  const changesSource = changesPick.path === path ? changesPick.source : BRANCH_SOURCE
  const setChangesSource = useCallback((source: ChangesSource) => setChangesPick({ path, source }), [path])
  const changesState = useWorktreeChanges(path, offline, panel === 'changes', features.review ? changesSource : undefined)
  useEffect(() => {
    // Selection changed: back to the sessions view, drop transient UI state.
    setPanel('sessions')
    setChangesPick({ path, source: BRANCH_SOURCE })
    setMenuOpen(false)
    setTagMenuOpen(false)
    setCustomTagMenuOpen(false)
    setEditingId(null)
  }, [path])

  useEffect(() => {
    if (panel === 'history' && !(features.history && info?.branch)) setPanel('sessions')
  }, [panel, features.history, info?.branch])

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
      useAppStore.getState().closeProjectPage()
      cycleTab(worktreeId, step)
    }
    // Capture phase, so the focused xterm never sees the keystroke.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Rendered whatever the detail shows now: the moved worktree's row goes when the move finishes.
  const moveModal = moving && <MoveWorktreeModal from={moving.from} info={moving.info} name={moving.name} onClose={() => setMoving(null)} />

  // The worktree as the plugins' slots see it, and their Run-menu entries for it (plugins E3).
  const pluginWorktree = useMemo(
    () => (info ? pluginWorktreeOf(info, (path) => getBackend().plugins.worktreeId(path)) : undefined),
    // The project's patches map the paths to the server's ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info?.path, info?.repoId, info?.branch, info?.isMain, info?.prunable, project]
  )
  const pluginPanels = usePluginPanels(pluginWorktree)
  // A plugin's panel whose entry went (the plugin switched off, or it left this worktree out): back to the sessions.
  useEffect(() => {
    if (panel.startsWith('plugin:') && !pluginPanels.some((p) => p.panelId === panel)) setPanel('sessions')
  }, [panel, pluginPanels])

  if (!info && unreadableRepo) {
    return (
      <main className="detail detail-empty detail-unreadable muted">
        Can’t read the repository {unreadableRepo.name} at {unreadableRepo.path}
        {moveModal}
      </main>
    )
  }

  if (!info) {
    return (
      <main className="detail detail-empty muted">
        Reading worktrees…
        {moveModal}
      </main>
    )
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
  const tag = branchTag(project, repo, info.branch)
  const customTags = project.customTags ?? []
  const enabledCustomTags = branchCustomTags(project, repo, info.branch)
  // Ticket/PR links are keyed by branch, so they follow it through
  // promote/demote and worktree re-creation.
  const ticket = info.branch ? repo.branchTickets?.[info.branch] : undefined
  const pullRequest = info.branch ? repo.branchPullRequests?.[info.branch] : undefined
  // The server watches it (5c-1); its last report stays on the chip until dismissed.
  const watchingPr = !!pullRequest && !!info.branch && !!repo.branchPrWatches?.[info.branch]
  const prNotice = repo.worktreePrNotices?.[info.path]
  // Where the Changes tab's review can go (5c-2): the worktree's open agent sessions (not one that
  // exited), newest first, each with its agent and status to tell same-titled ones apart.
  const reviewTargets: ReviewTarget[] = loaded
    ? [...order].reverse().flatMap((id) => {
        const t = terminals[id]
        if (!t || t.status === 'exited') return []
        return [{ terminalId: id, title: t.title, detail: `${describeAgent(t.llm ?? { provider: DEFAULT_AGENT_ID }, catalog)} · ${t.status}` }]
      })
    : []
  // Through the project's trackers (their plugins'): its label, link and looked-up issue.
  const ticketInfo = ticket ? ticketViewOf(ticket) : undefined
  const issue = ticketInfo?.info
  const linkedTicketUrl = ticketInfo?.url ?? null
  /** The header's ticket chip, clicked or keyed: its link, else (no link yet: its tracker's setting is missing, or no tracker on owns it) the dialog that says what it needs. */
  const openTicketChip = (): void => {
    if (linkedTicketUrl) window.open(linkedTicketUrl)
    else if (info.branch) setShowTicket(true)
  }

  // Notes are keyed to the live branch, so they follow it through promote/demote.
  const noteKey = info.branch ?? instance?.branch ?? instance?.name ?? baseName(info.path)

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

  // The runtime panels: Docker (the repository's compose), the plugins' panels (plugins E3: the
  // worktree's Colima environment), its stack.
  const runGrouped = [showDocker, showStack].filter(Boolean).length + pluginPanels.length >= 2
  const runActive = panel === 'docker' || panel === 'stack' || panel.startsWith('plugin:')
  const stackBusy = showStack && stackStateNow !== 'running' && stackStateNow !== 'stopped'
  const runDot = runMenuDot([stackBusy ? 'attention' : showStack && stackStateNow === 'running' ? 'running' : undefined, ...pluginPanels.map((p) => p.entry.dot)])
  const runtimeButtons = (
    <>
          {showDocker && (
            <button
              className={`panel-btn ${panel === 'docker' ? 'active' : ''}`}
              onClick={() => setPanel(panel === 'docker' ? 'sessions' : 'docker')}
            >
              Docker <DockerMenu key={repo.id} repoId={repo.id} />
            </button>
          )}
          {pluginPanels.map((p) => (
            <button
              key={p.panelId}
              className={`panel-btn ${panel === p.panelId ? 'active' : ''}`}
              title={p.entry.title}
              onClick={() => setPanel(panel === p.panelId ? 'sessions' : p.panelId)}
            >
              {p.entry.label}
              {p.entry.dot && <span className={`docker-dot ${p.entry.dot}`} />}
            </button>
          ))}
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
    </>
  )

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
            {offline && <span className="chip chip-offline">Server disconnected</span>}
            {info.branch && (
              <span className="tag-chip-wrap">
                <span
                  className={`chip chip-tag ${tag ? '' : 'untagged'}`}
                  title="Set the workflow tag for this branch"
                  onClick={() => !offline && setTagMenuOpen((v) => !v)}
                >
                  <span className={`tag-dot ${tag ? '' : 'hollow'}`} style={tag ? { color: tag.color } : undefined} />
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
                    title="Toggle custom tags for this branch"
                    onClick={() => !offline && setCustomTagMenuOpen((v) => !v)}
                  >
                    <span className="wt-tag-square" style={{ background: t.color }} />
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
            {info.branch && !ticket && (
              <button className="chip chip-link" disabled={offline} onClick={() => setShowTicket(true)}>
                Link ticket
              </button>
            )}
            {ticket && (
              <span
                className="chip chip-ticket"
                role="button"
                tabIndex={0}
                title={
                  linkedTicketUrl
                    ? `Open ticket ${ticketInfo!.label}${issue ? ` · ${issue.status} — ${issue.title}` : ''}`
                    : `Ticket ${ticketInfo!.label}: click to add what its link needs`
                }
                onClick={openTicketChip}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openTicketChip()
                  }
                }}
              >
                {issue ? ticketInfo!.label : `Ticket ${ticketInfo!.label}`}
              </span>
            )}
            {info.branch && !pullRequest && (
              <button className="chip chip-link" disabled={offline} onClick={() => setShowPR(true)}>
                Link pull request
              </button>
            )}
            {pullRequest && (
              <span
                className={`chip chip-pr${prNotice ? ' notice' : ''}`}
                title={`${prNotice ? `${prNotice}\n` : ''}Open pull request — ${pullRequest}`}
                onClick={() => window.open(pullRequest)}
              >
                PR {prLabel(prProviders, pullRequest)}
                {watchingPr && (
                  // The server keeps the watch while its host is signed out, but polls nothing until it signs in again.
                  <span className="chip-pr-watch">
                    {features.prWatch
                      ? ' · watching'
                      : ` · watch paused — ${prOwner(prProviders, pullRequest)?.signInName ?? 'its host'} isn't signed in`}
                  </span>
                )}
              </span>
            )}
            {info.dirty && (
              <span className="chip chip-git">
                <span className="wt-dirty-dot" />
                Uncommitted changes
              </span>
            )}
            {pluginWorktree && <PluginWorktreeSlot name="worktreeChip" worktree={pluginWorktree} openPanel={setPanel} />}
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
            <div className="detail-sync">
              <button
                className={`btn btn-ghost ${info.behind ? '' : 'idle'}`}
                disabled={offline || syncBusy !== null}
                title={offline ? 'Server disconnected' : `git pull --ff-only origin ${info.branch}`}
                onClick={() => void runGitSync('pull')}
              >
                {syncBusy === 'pull' ? 'Pulling…' : `Pull${info.behind ? ` ↓${info.behind}` : ''}`}
              </button>
              <button
                className={`btn btn-ghost ${info.ahead ? '' : 'idle'}`}
                disabled={offline || syncBusy !== null}
                title={offline ? 'Server disconnected' : `git push origin ${info.branch}`}
                onClick={() => void runGitSync('push')}
              >
                {syncBusy === 'push' ? 'Pushing…' : `Push${info.ahead ? ` ↑${info.ahead}` : ''}`}
              </button>
            </div>
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

      {/* A watched pull request's report: one line under the header until it is dismissed */}
      {prNotice && (
        <div className="detail-notice">
          <span className="chip-pr-notice">{prNotice}</span>
          {pullRequest && (
            <button className="detail-notice-link" onClick={() => window.open(pullRequest)}>
              Open PR
            </button>
          )}
          <button
            className="chip-dismiss"
            title="Dismiss"
            aria-label="Dismiss pull request notice"
            disabled={offline}
            onClick={() => {
              if (!offline) void getBackend().branch.dismissPrNotice(info.path).catch((err: unknown) => getBackend().errors.report('Could not dismiss the notice', err))
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {menuOpen && (
        <>
          <div className="detail-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="detail-menu">
            <div className="detail-menu-path" title={info.path}>
              {info.path}
            </div>
            {features.openInEditor && (
              <div
                className="detail-menu-item"
                onClick={() => {
                  setMenuOpen(false)
                  openVSCode()
                }}
              >
                <div className="detail-menu-name">Open in VS Code</div>
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
            <div
              className="detail-menu-item"
              onClick={() => {
                setMenuOpen(false)
                void navigator.clipboard.writeText(info.path)
              }}
            >
              <div className="detail-menu-name">Copy path</div>
            </div>
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
                  <div className="detail-menu-name" title="Change or unlink the linked ticket">
                    Ticket {ticketInfo ? ticketInfo.label : '(none)'}…
                  </div>
                </div>
                <div
                  className="detail-menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    setShowPR(true)
                  }}
                >
                  <div className="detail-menu-name" title="Change or unlink the linked pull request">
                    Pull request {pullRequest ? prLabel(prProviders, pullRequest) : '(none)'}…
                  </div>
                </div>
                {/* Watch is offered for a link a PR provider on for the project owns; Stop watching always, while watched. */}
                {pullRequest && info.branch && (features.prWatch || watchingPr) && (watchingPr || prOwner(prProviders, pullRequest)) && (
                  <div
                    className={`detail-menu-item ${busy || offline ? 'disabled' : ''}`}
                    onClick={() => {
                      const branch = info.branch
                      if (busy || offline || !branch) return
                      void runAction(() =>
                        getBackend()
                          .branch.setPrWatch(repo.id, branch, !watchingPr)
                          .catch((err: unknown) => getBackend().errors.report(watchingPr ? 'Could not stop watching the pull request' : 'Could not watch the pull request', err))
                      )
                    }}
                  >
                    <div
                      className="detail-menu-name"
                      title={
                        watchingPr
                          ? 'The server stops following its checks and reviews'
                          : "The server follows its checks, reviews and merge state, and queues a prompt on this worktree's newest session"
                      }
                    >
                      {watchingPr ? 'Stop watching pull request' : 'Watch pull request'}
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
            {instance && loaded && order.length > 0 && (
              <div
                className={`detail-menu-item ${offline ? 'disabled' : ''}`}
                onClick={() => {
                  setMenuOpen(false)
                  void getBackend().worktrees.unload(instance.id)
                }}
              >
                <div
                  className="detail-menu-name"
                  title="End this worktree's sessions to free CPU — they stay saved and resume when you load it again"
                >
                  Unload sessions
                </div>
              </div>
            )}
            {/* 5e: worktree.promote and worktree.demote, each one request on the server. */}
            {features.promote && info.branch && info.isMain && (
              <div
                className={`detail-menu-item ${busy || offline ? 'disabled' : ''}`}
                onClick={() => {
                  if (busy || offline) return
                  setMenuOpen(false)
                  void runAction(() => getBackend().worktrees.demote({ ...info, repoId: info.repoId ?? repo.id }))
                }}
              >
                <div
                  className="detail-menu-name"
                  title={`Move ${info.branch} and its uncommitted work to its own worktree; the main checkout returns to the default branch`}
                >
                  Promote branch to worktree…
                </div>
              </div>
            )}
            {features.promote && info.branch && !info.isMain && (
              <div
                className={`detail-menu-item ${busy || offline ? 'disabled' : ''}`}
                onClick={() => {
                  if (busy || offline) return
                  setMenuOpen(false)
                  void runAction(async () => {
                    await getBackend().worktrees.promote(info, instance)
                  })
                }}
              >
                <div className="detail-menu-name" title={`Check out ${info.branch} in the main checkout, with its uncommitted work and sessions`}>
                  Promote to primary…
                </div>
              </div>
            )}
            {canMove && !info.isMain && info.branch && getBackend().worktrees.moveRef(info.path) && (
              <div
                className={`detail-menu-item ${busy || offline ? 'disabled' : ''}`}
                onClick={() => {
                  if (busy || offline || !info.branch) return
                  const from = getBackend().worktrees.moveRef(info.path)
                  setMenuOpen(false)
                  if (from) setMoving({ from, info, name: info.branch })
                }}
              >
                <div
                  className="detail-menu-name"
                  title="Push the branch and carry the uncommitted work and the sessions that can move to a clone on another server"
                >
                  Move to another server…
                </div>
              </div>
            )}
            {!info.isMain && (
              <div
                className={`detail-menu-item danger ${busy || offline ? 'disabled' : ''}`}
                onClick={() => {
                  if (!offline && !busy) void runAction(() => getBackend().worktrees.remove(info, instance))
                }}
              >
                <div className="detail-menu-name" title="git worktree remove — deletes the folder">
                  Delete worktree…
                </div>
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
                <SessionIndicator
                  terminalId={id}
                  status={meta.status}
                  onToggleComplete={offline ? undefined : () => toggleTerminalComplete(id)}
                />
                <DecisionIcon terminalId={id} />
                {icon && <img className="session-tab-icon" src={icon} alt="" />}
                <AgentGlyph llm={meta.llm} />
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
        <button
          className={`panel-btn ${panel === 'changes' ? 'active' : ''}`}
          title={features.review ? 'Changes: the branch against its base, the uncommitted work or one commit, with line comments' : 'Changes compared to the default branch, including uncommitted work'}
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
        {features.history && info.branch && (
          <button
            className={`panel-btn ${panel === 'history' ? 'active' : ''}`}
            title={`What changed on ${info.branch}, and who changed it`}
            onClick={() => setPanel(panel === 'history' ? 'sessions' : 'history')}
          >
            History
          </button>
        )}
        {/* Two or more of Docker, the plugins' panels (Env) and Stack share one Run button; one alone stays its own button */}
        {runGrouped ? (
          <div className="run-group">
            <button
              className={`run-btn ${runActive ? 'active' : ''}`}
              title="What this worktree runs"
              aria-expanded={runOpen}
              onClick={() => setRunOpen((v) => !v)}
            >
              <span className={`docker-dot ${runDot}`} />
              Run <span className="chip-caret">▾</span>
            </button>
            {/* Kept mounted while closed: the Docker ▾ menu inside it holds a running compose action */}
            <div className={`run-menu ${runOpen ? '' : 'closed'}`} onClick={() => setRunOpen(false)}>
              {runtimeButtons}
            </div>
          </div>
        ) : (
          runtimeButtons
        )}
      </div>

      <div className="terminal-card">
        {order.map((id) => (
          <TerminalPane
            key={id}
            terminalId={id}
            visible={panel === 'sessions' && id === activeId && !projectPage}
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
          path={info.path}
          source={changesSource}
          onSource={setChangesSource}
          review={{
            enabled: features.review,
            needsUpdate: !features.review && !offline,
            draft: repo.worktreeReviews?.[info.path],
            targets: reviewTargets,
            noTargets: loaded ? 'Start a session in this worktree to send the review to' : 'Load the worktree to send the review to one of its sessions',
            offline
          }}
        />
        <NotesPanel visible={panel === 'notes'} repoId={repo.id} noteKey={noteKey} />
        {features.history && info.branch && <HistoryPanel visible={panel === 'history'} repoId={repo.id} branch={info.branch} />}
        {showDocker && <DockerPanel key={repo.id} visible={panel === 'docker'} />}
        {pluginWorktree && <PluginPanels worktree={pluginWorktree} panels={pluginPanels} open={panel} />}
        {showStack && stack && (
          <StackPanel
            visible={panel === 'stack'}
            worktreePath={info.path}
            status={stack}
            onChanged={refreshStack}
          />
        )}
      </div>

      {showTicket && info.branch && (
        <TicketModal repoId={repo.id} branch={info.branch} onClose={() => setShowTicket(false)} />
      )}
      {showPR && info.branch && (
        <PullRequestModal repoId={repo.id} branch={info.branch} onClose={() => setShowPR(false)} />
      )}
      {moveModal}
    </main>
  )
}
