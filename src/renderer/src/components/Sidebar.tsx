import { useEffect, useRef, useState } from 'react'
import {
  branchCustomTags,
  branchTag,
  dormantSessions,
  environmentFor,
  GLOBAL_WORKTREE_ID,
  instanceForInfo,
  pullRequestLabel,
  repoOfInfo,
  repoWorktrees,
  useAppStore,
  worktreeStatus
} from '../store'
import { useTicketViews } from '../plugins/useTickets'
import { NotificationsMenu } from './NotificationsMenu'
import { toggleSidebar } from '../sidebarToggle'
import { PluginSlot } from '../plugins/PluginHost'
import { removalBlock } from '../repoRemoval'
import { getBackend } from '../backend'
import { useFeatures } from '../useFeatures'
import { missedRows } from '../automations'
import {
  ATTENTION_GROUP_LABELS,
  attentionGroup,
  cardAnchor,
  gitWords,
  groupByAttention,
  isUnloaded,
  parseSidebarView,
  rowGit,
  rowReason,
  sessionLine,
  sidebarViewChanged,
  type DotKind,
  type SidebarView
} from '../sidebarRow'
import { WorktreeHoverCard, type HoverCardProps } from './WorktreeHoverCard'
import { envRepoKey } from '../../../shared/environments'
import { sameWorktree, worktreeKey } from '../../../shared/types'
import type { GitWorktreeInfo, Repository, TerminalStatus } from '../../../shared/types'

interface Props {
  worktrees: GitWorktreeInfo[]
  /** Opens the Add Worktree dialog for a repository */
  onAdd: (repoId: string) => void
}

/** "feature/dispatch/foo" → dim "feature/dispatch/" + bold "foo". */
export function splitBranch(label: string): { prefix: string; name: string } {
  const segments = label.split('/')
  const name = segments.pop() ?? label
  return { prefix: segments.length ? segments.join('/') + '/' : '', name }
}

export function branchLabel(info: GitWorktreeInfo): string {
  return info.branch ?? (info.head ? `${info.head.slice(0, 8)} (detached)` : info.path)
}

/** The Sort menu's choices, kept per window (as the Global panel's height is). */
const VIEW_KEY = 'trek.sidebar.view'

function storedView(): SidebarView {
  try {
    return parseSidebarView(localStorage.getItem(VIEW_KEY))
  } catch {
    return parseSidebarView(null)
  }
}

const DOT_TITLES: Record<DotKind, string> = {
  none: 'No session',
  dormant: 'Saved sessions — this worktree is unloaded',
  idle: 'Session idle',
  running: 'Agent is working',
  attention: 'Agent needs your attention',
  done: 'Agent finished',
  exited: 'Session exited'
}

function dotKind(
  aggregate: TerminalStatus | null,
  hasTerminals: boolean,
  hasDormant: boolean
): DotKind {
  if (!hasTerminals) return hasDormant ? 'dormant' : 'none'
  switch (aggregate) {
    case 'attention':
      return 'attention'
    case 'working':
      return 'running'
    case 'done':
      return 'done'
    case 'exited':
      return 'exited'
    default:
      return 'idle'
  }
}

/** A watched pull request's notice (5c-1), beside the row's status dot (which still shows its sessions). */
function PrNoticeFlag({ title }: { title: string }): React.JSX.Element {
  return (
    <span className="wt-pr-flag" title={title}>
      PR
    </span>
  )
}

/** The footer rows' icons: one line weight and one column, in the row's own colour. */
function NavIcon({ name }: { name: 'add' | 'notes' | 'automations' | 'settings' }): React.JSX.Element {
  return (
    <svg className="sidebar-nav-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === 'add' && <path d="M8 3v10M3 8h10" />}
      {name === 'notes' && <path d="M4 2.5h8v11H4zM6.2 5.8h3.6M6.2 8h3.6M6.2 10.2h2" />}
      {name === 'automations' && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3.2l2 1.3" />
        </>
      )}
      {name === 'settings' && (
        <>
          <circle cx="8" cy="8" r="2" />
          <path d="M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6l1.35 1.35M11.05 11.05l1.35 1.35M3.6 12.4l1.35-1.35M11.05 4.95l1.35-1.35" />
        </>
      )}
    </svg>
  )
}

export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
  const project = useAppStore((s) => s.project)!
  const ticketViewOf = useTicketViews()
  const selected = useAppStore((s) => s.selected)
  const selectWorktree = useAppStore((s) => s.selectWorktree)
  const terminals = useAppStore((s) => s.terminals)
  const terminalOrder = useAppStore((s) => s.terminalOrder)
  const decisions = useAppStore((s) => s.decisions)
  const loadedWorktrees = useAppStore((s) => s.loadedWorktrees)
  const environments = useAppStore((s) => s.environments)
  const envBusy = useAppStore((s) => s.envBusy)
  const features = useFeatures()
  const projectPage = useAppStore((s) => s.projectPage)
  const toggleProjectPage = useAppStore((s) => s.toggleProjectPage)
  const automationCount = project.automations?.length ?? 0
  const noteCount = project.repositories.reduce((n, r) => n + Object.keys(r.branchNotes ?? {}).length, 0)
  const missedCount = missedRows(project.automations).length
  // The window's connection is down: its commands are disabled until it is back.
  const offline = useAppStore((s) => s.serverOffline)
  const [filter, setFilter] = useState('')
  // Tag ids (or 'untagged'); a worktree matching any of them is shown. Empty = all.
  const [tagFilterValue, setTagFilter] = useState<string[]>([])
  const [tagFilterOpen, setTagFilterOpen] = useState(false)
  // How the list is ordered and how dense its rows are (the Sort menu).
  const [view, setViewState] = useState<SidebarView>(storedView)
  const [sortOpen, setSortOpen] = useState(false)
  const setView = (patch: Partial<SidebarView>): void => {
    const next = { ...view, ...patch }
    setViewState(next)
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(next))
    } catch {
      // No storage (a locked-down browser): the choice lasts for this window only.
    }
  }
  const setWorktreeOrder = useAppStore((s) => s.setWorktreeOrder)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null)
  // Collapsed repository sections. Runtime only, so a reopened project starts expanded.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [repoMenuId, setRepoMenuId] = useState<string | null>(null)
  // A server window lost its link: a repository's menu could only fail now.
  useEffect(() => {
    if (offline) setRepoMenuId(null)
  }, [offline])
  // Rows only reorder within their own repository's section.
  const [dragRepoId, setDragRepoId] = useState<string | undefined>(undefined)

  const query = filter.trim().toLowerCase()
  const tags = project.worktreeTags ?? []
  const customTags = project.customTags ?? []
  // Filters on since-deleted tags are dropped.
  const filterTags = [...tags, ...customTags].filter((t) => tagFilterValue.includes(t.id))
  const tagFilter = tagFilterValue.filter(
    (id) => id === 'untagged' || filterTags.some((t) => t.id === id)
  )
  const tagOf = (w: GitWorktreeInfo): string | undefined =>
    branchTag(project, repoOfInfo(project, w), w.branch)?.id
  const rank = new Map((project.worktreeOrder ?? []).map((key, i) => [key, i]))
  const ordered = [...worktrees].sort(
    (a, b) =>
      (rank.get(worktreeKey(a)) ?? Infinity) - (rank.get(worktreeKey(b)) ?? Infinity)
  )
  const rows = ordered
    .filter(
      (w) =>
        !query ||
        branchLabel(w).toLowerCase().includes(query) ||
        w.path.toLowerCase().includes(query) ||
        repoOfInfo(project, w).name.toLowerCase().includes(query)
    )
    .filter((w) => {
      if (tagFilter.length === 0) return true
      const tag = tagOf(w)
      const custom = (w.branch && repoOfInfo(project, w).branchCustomTags?.[w.branch]) || []
      return tagFilter.some((id) =>
        id === 'untagged' ? !tag : tag === id || custom.includes(id)
      )
    })

  const toggleTagFilter = (id: string): void =>
    setTagFilter(
      tagFilter.includes(id) ? tagFilter.filter((x) => x !== id) : [...tagFilter, id]
    )
  const filterLabel =
    tagFilter.length === 0
      ? 'All'
      : tagFilter.length > 1
        ? `${tagFilter.length} tags`
        : tagFilter[0] === 'untagged'
          ? 'Untagged'
          : filterTags[0]?.name

  // The hover card: shown beside a row once the pointer has rested on it, and at once when
  // moving on from a row whose card was just up. A press, a drag or a scroll puts it away.
  const [hover, setHover] = useState<{ key: string; rect: { top: number; bottom: number; right: number } } | null>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const cardHiddenAt = useRef(0)
  const hideCard = (): void => {
    window.clearTimeout(hoverTimer.current)
    setHover((shown) => {
      if (shown) cardHiddenAt.current = Date.now()
      return null
    })
  }
  const showCardSoon = (key: string, row: HTMLElement): void => {
    window.clearTimeout(hoverTimer.current)
    const delay = Date.now() - cardHiddenAt.current < 300 ? 80 : 450
    hoverTimer.current = window.setTimeout(() => {
      if (!row.isConnected) return
      const { top, bottom, right } = row.getBoundingClientRect()
      setHover({ key, rect: { top, bottom, right } })
    }, delay)
  }
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const endDrag = (): void => {
    setDragKey(null)
    setDropTarget(null)
    setDragRepoId(undefined)
  }

  const dropOn = (targetKey: string, after: boolean): void => {
    // A drag that started before the link dropped ends without a reorder.
    if (!dragKey || dragKey === targetKey || offline) return endDrag()
    const keys = ordered.map(worktreeKey).filter((k) => k !== dragKey)
    const at = keys.indexOf(targetKey) + (after ? 1 : 0)
    keys.splice(at, 0, dragKey)
    // Rows of an unreadable repository aren't live, but their order must survive.
    const live = new Set(ordered.map(worktreeKey))
    setWorktreeOrder([...keys, ...(project.worktreeOrder ?? []).filter((k) => !live.has(k))])
    endDrag()
  }

  const runningSessions = Object.values(terminals).filter(
    (t) => t.status !== 'exited' && t.worktreeId !== GLOBAL_WORKTREE_ID
  ).length
  // Only worktrees that actually hold terminals are worth offering to unload.
  const loadedCount = Object.keys(loadedWorktrees).filter(
    (id) => (terminalOrder[id]?.length ?? 0) > 0
  ).length

  /** Everything a row — and its hover card — derives from a worktree. */
  const rowModel = (info: GitWorktreeInfo) => {
    const repo = repoOfInfo(project, info)
    const instance = instanceForInfo(project, info)
    const order = instance ? terminalOrder[instance.id] : undefined
    const loaded = !!instance && !!loadedWorktrees[instance.id]
    const rowDecisions = (order ?? []).flatMap((id) => decisions[id] ?? [])
    // Sessions saved for an unloaded worktree — what loading it resumes.
    const dormant = instance ? dormantSessions({ project, loadedWorktrees }, instance.id) : []
    const dot = dotKind(
      worktreeStatus(terminals, order),
      !!order && order.length > 0,
      dormant.length > 0
    )
    const { prefix, name } = splitBranch(branchLabel(info))
    const git = rowGit(info)
    const tag = branchTag(project, repo, info.branch)
    const rowCustomTags = branchCustomTags(project, repo, info.branch)
    const ticket = info.branch ? repo.branchTickets?.[info.branch] : undefined
    const ticketInfo = ticket ? ticketViewOf(ticket) : undefined
    const pullRequest = info.branch
      ? repo.branchPullRequests?.[info.branch]
      : undefined
    // A watched PR's report (5c-1) flags the row until it is dismissed.
    const prNotice = repo.worktreePrNotices?.[info.path]
    const env = features.env ? environmentFor(environments, envRepoKey(repo), info.branch) : undefined
    const envIsBusy = env ? !!envBusy[env.profile] : false
    // A project page is open over the detail: its row is the one highlighted.
    const isSelected =
      !projectPage &&
      ((selected && sameWorktree(info, selected)) ||
        (info.isMain && selected?.path === repo.path))
    // A worktree git no longer lists on the server: it can only be deleted (Notes for 3c-2 #9).
    const missing = !!info.prunable
    // What takes over the second line: the row says why it wants the user, not that it does.
    const reason = rowReason({
      missing,
      questions: rowDecisions.map((d) => d.question),
      prNotice,
      prLabel: pullRequest ? pullRequestLabel(pullRequest) : undefined
    })
    // Bold until looked at: an agent finished or is waiting, or the row has a decision or notice.
    const unseen = dot === 'done' || dot === 'attention' || reason?.kind === 'decision' || reason?.kind === 'notice'
    return {
      repo, instance, order, loaded, rowDecisions, dormant, dot, name, prefix, git, tag, rowCustomTags,
      ticket, ticketInfo, pullRequest, prNotice, env, envIsBusy, isSelected, missing, reason, unseen
    }
  }

  const renderRow = (info: GitWorktreeInfo): React.JSX.Element => {
    const {
      instance, order, loaded, dormant, dot, name, git, tag, rowCustomTags, ticket, ticketInfo,
      pullRequest, env, envIsBusy, isSelected, missing, reason, unseen
    } = rowModel(info)
    const key = worktreeKey(info)
    const dropClass =
      dropTarget?.key === key && dragKey !== key
        ? dropTarget.after
          ? 'drop-after'
          : 'drop-before'
        : ''
    return (
      <div
        key={key}
        className={`wt-row ${isSelected ? 'selected' : ''} ${unseen ? 'unseen' : ''} ${dot === 'dormant' ? 'dormant' : ''} ${missing ? 'missing' : ''} ${view.compact ? 'compact' : ''} ${dragKey === key ? 'dragging' : ''} ${dropClass}`}
        // Attention first is a view of the list, not an order: rows only drag in the manual order.
        draggable={!offline && view.sort === 'manual'}
        onMouseEnter={(e) => showCardSoon(key, e.currentTarget)}
        onMouseLeave={hideCard}
        onMouseDown={hideCard}
        onDragStart={(e) => {
          hideCard()
          e.dataTransfer.effectAllowed = 'move'
          setDragKey(key)
          setDragRepoId(info.repoId)
        }}
        onDragOver={(e) => {
          if (!dragKey || dragRepoId !== info.repoId) return
          e.preventDefault()
          const rect = e.currentTarget.getBoundingClientRect()
          const after = e.clientY > rect.top + rect.height / 2
          if (dropTarget?.key !== key || dropTarget.after !== after) {
            setDropTarget({ key, after })
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          dropOn(key, dropTarget?.key === key ? dropTarget.after : false)
        }}
        onDragEnd={endDrag}
        onClick={() => selectWorktree({ path: info.path }, instance?.id)}
      >
        {dot === 'attention' ? (
          <span className="wt-attn" title={DOT_TITLES.attention}>
            !
          </span>
        ) : (
          <span className={`wt-dot ${dot}`} title={DOT_TITLES[dot]} />
        )}
        <div className="wt-main">
          <div className="wt-branch">
            <span className="wt-branch-label">
              <span className="wt-name">{name}</span>
            </span>
            {info.isMain && <span className="primary-tag">primary</span>}
            {/* A compact row has no second line, so its PR number moves up beside the git marks */}
            {view.compact && !reason && pullRequest && <span className="wt-compact-pr">{pullRequestLabel(pullRequest)}</span>}
            {git && (
              <span className={`wt-git ${git.dirty ? 'dirty' : ''}`}>
                {git.dirty && <span className="wt-dirty-dot" title="Uncommitted changes" />}
                {git.counts}
              </span>
            )}
            {/* Unload shows on hover or focus, in place of the git marks; Load stays, as the saved-session count */}
            {instance && loaded && (order?.length ?? 0) > 0 && (
              <button
                className="wt-power loaded"
                title="Unload — end this worktree's sessions (they stay saved)"
                disabled={offline}
                onClick={(e) => {
                  e.stopPropagation()
                  void getBackend().worktrees.unload(instance.id)
                }}
              >
                Unload
              </button>
            )}
            {instance && dormant.length > 0 && !missing && (
              <button
                className="wt-power dormant"
                title={`Load ${dormant.length} saved session${dormant.length === 1 ? '' : 's'}`}
                disabled={offline}
                onClick={(e) => {
                  e.stopPropagation()
                  void getBackend().worktrees.load(instance.id)
                }}
              >
                ▸{dormant.length}
              </button>
            )}
          </div>
          {reason ? (
            <div className={`wt-meta wt-reason ${reason.kind}`}>
              <span
                className={reason.kind === 'notice' ? 'wt-pr-flag' : reason.kind === 'missing' ? 'mini-chip wt-missing' : 'wt-decision'}
                title={reason.title}
              >
                {reason.text}
              </span>
            </div>
          ) : (
            !view.compact &&
            (tag || rowCustomTags.length > 0 || ticket || pullRequest || env) && (
              <div className="wt-meta">
                {tag && (
                  <span className="mini-chip" style={{ color: tag.color }}>
                    {tag.name}
                  </span>
                )}
                {rowCustomTags.length > 0 && (
                  <span className="wt-tag-squares">
                    {rowCustomTags.map((t) => (
                      <span key={t.id} className="mini-chip wt-tag-square" style={{ background: t.color }} title={t.name} />
                    ))}
                  </span>
                )}
                {ticket && ticketInfo && (
                  <span
                    className="mini-chip ticket"
                    title={
                      ticketInfo.info
                        ? `${ticketInfo.label} · ${ticketInfo.info.status} — ${ticketInfo.info.title}`
                        : undefined
                    }
                  >
                    {ticketInfo.label}
                  </span>
                )}
                {pullRequest && <span className="mini-chip pr">{pullRequestLabel(pullRequest)}</span>}
                {env && (
                  <span
                    className={`mini-chip env ${envIsBusy ? 'busy' : env.vmState === 'running' ? 'running' : ''}`}
                    title={
                      envIsBusy
                        ? 'Environment operation in progress'
                        : `Environment ${env.vmState}${env.address ? ` — ${env.address}` : ''}`
                    }
                  >
                    env
                  </span>
                )}
              </div>
            )
          )}
        </div>
      </div>
    )
  }

  const cardProps = (info: GitWorktreeInfo, rect: { top: number; bottom: number; right: number }): HoverCardProps => {
    const m = rowModel(info)
    const watching = !!m.pullRequest && !!info.branch && !!m.repo.branchPrWatches?.[info.branch]
    return {
      anchor: cardAnchor(rect, window.innerHeight),
      prefix: m.prefix,
      name: m.name,
      path: info.path,
      isMain: !!info.isMain,
      missing: m.missing,
      tags: [...(m.tag ? [m.tag] : []), ...m.rowCustomTags],
      ticket:
        m.ticket && m.ticketInfo
          ? {
              label: m.ticketInfo.label,
              status: m.ticketInfo.info?.status,
              statusColor: m.ticketInfo.info?.statusColor,
              title: m.ticketInfo.info?.title
            }
          : undefined,
      pullRequest: m.pullRequest
        ? {
            label: pullRequestLabel(m.pullRequest),
            watch: watching ? (features.prWatch ? 'watching' : 'paused') : undefined,
            notice: m.prNotice
          }
        : undefined,
      git: gitWords(info),
      environment: m.env ? `${m.envIsBusy ? 'busy' : m.env.vmState}${m.env.address ? ` — ${m.env.address}` : ''}` : undefined,
      questions: m.rowDecisions.map((d) => d.question).filter((q): q is string => !!q),
      sessions: [
        ...(m.order ?? []).flatMap((id) => {
          const meta = terminals[id]
          return meta ? [{ key: id, title: meta.title, ...sessionLine(meta.status) }] : []
        }),
        ...m.dormant.map((t, i) => ({ key: `saved-${i}`, title: t.title, dot: 'dormant' as const, word: 'saved' }))
      ]
    }
  }

  /** Highest-priority dot across a repository's sessions, shown when collapsed. */
  const repoDot = (repo: Repository): DotKind => {
    const worktreeIds = repoWorktrees(repo).map((w) => w.id)
    const order = worktreeIds.flatMap((id) => terminalOrder[id] ?? [])
    const dormant = worktreeIds.some(
      (id) => dormantSessions({ project, loadedWorktrees }, id).length > 0
    )
    return dotKind(worktreeStatus(terminals, order), order.length > 0, dormant)
  }

  const filtering = !!query || tagFilter.length > 0

  const renderSection = (repo: Repository): React.JSX.Element | null => {
    const repoRows = rows.filter((w) => {
      if (w.repoId !== repo.id) return false
      if (!view.hideUnloaded) return true
      // Hide unloaded leaves out rows with no loaded session — never the one you are on.
      const m = rowModel(w)
      return m.isSelected || !isUnloaded(m.dot)
    })
    if (filtering && repoRows.length === 0) return null
    const isCollapsed = !!collapsed[repo.id]
    const dot = repoDot(repo)
    // A collapsed header flags its worktrees' PR notices (5c-1) beside its dot, as each row does.
    const noticeCount = Object.keys(repo.worktreePrNotices ?? {}).length
    const block = repoMenuId === repo.id ? removalBlock(repo) : null
    return (
      <section className="repo-section" key={repo.id}>
        <div className="repo-header" title={repo.path}>
          <button
            className="repo-toggle"
            aria-expanded={!isCollapsed}
            onClick={() => setCollapsed({ ...collapsed, [repo.id]: !isCollapsed })}
          >
            <span className="chip-caret">{isCollapsed ? '▸' : '▾'}</span>
            <span className="repo-name">{repo.name}</span>
            {isCollapsed && <span className="repo-count">{repoRows.length}</span>}
            {isCollapsed &&
              (dot === 'attention' ? (
                <span className="wt-attn" title={DOT_TITLES.attention}>
                  !
                </span>
              ) : (
                dot !== 'none' && <span className={`wt-dot ${dot}`} title={DOT_TITLES[dot]} />
              ))}
            {isCollapsed && noticeCount > 0 && <PrNoticeFlag title={`${noticeCount} pull request notice${noticeCount === 1 ? '' : 's'}`} />}
          </button>
          <button
            className="repo-action"
            title={`New worktree in ${repo.name}`}
            disabled={offline}
            onClick={() => onAdd(repo.id)}
          >
            +
          </button>
          <button
            className="repo-action"
            title={`${repo.name} options`}
            disabled={offline}
            onClick={() => setRepoMenuId(repoMenuId === repo.id ? null : repo.id)}
          >
            ⋯
          </button>
          {repoMenuId === repo.id && (
            <>
              <div className="detail-menu-backdrop" onClick={() => setRepoMenuId(null)} />
              <div className="tag-menu repo-menu">
                <div
                  className={`tag-menu-item ${block ? 'disabled' : ''}`}
                  title={block ?? undefined}
                  onClick={() => {
                    setRepoMenuId(null)
                    if (!block) void getBackend().repos.remove(repo)
                  }}
                >
                  Remove from project
                </div>
              </div>
            </>
          )}
        </div>
        {!isCollapsed &&
          (view.sort === 'attention'
            ? groupByAttention(repoRows, (w) => {
                const m = rowModel(w)
                return attentionGroup(m.dot, m.reason?.kind)
              }).map((g) => (
                <div className="wt-group" key={g.group}>
                  <div className="wt-group-label">
                    {ATTENTION_GROUP_LABELS[g.group]} · {g.rows.length}
                  </div>
                  {g.rows.map(renderRow)}
                </div>
              ))
            : repoRows.map(renderRow))}
      </section>
    )
  }

  const hoveredInfo = hover ? worktrees.find((w) => worktreeKey(w) === hover.key) : undefined
  const hoverCard = hover && hoveredInfo ? cardProps(hoveredInfo, hover.rect) : null

  return (
    <aside className="sidebar">
      {project.bannerImage && (
        <div className="sidebar-banner">
          <img src={project.bannerImage} alt="" />
        </div>
      )}
      <div className="sidebar-top">
        <input
          className="sidebar-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter worktrees…"
          spellCheck={false}
        />
        <PluginSlot name="sidebarToolbar" />
        <NotificationsMenu />
        <button className="sidebar-toggle sidebar-hide" title="Hide sidebar" aria-label="Hide sidebar" onClick={toggleSidebar}>
          «
        </button>
      </div>
      <div className="sidebar-heading">
        <span className="sidebar-heading-label">Worktrees · {rows.length}</span>
        <div className="sidebar-sort">
          <button
            className={`sort-btn ${sidebarViewChanged(view) ? 'filtered' : ''}`}
            title="Order and density of the worktree list"
            aria-expanded={sortOpen}
            onClick={() => setSortOpen((v) => !v)}
          >
            Sort
            <span className="chip-caret">▾</span>
          </button>
          {sortOpen && (
            <>
              <div className="detail-menu-backdrop" onClick={() => setSortOpen(false)} />
              <div className="tag-menu sort-menu">
                <div
                  className={`tag-menu-item ${view.sort === 'manual' ? 'active' : ''}`}
                  title="The order you dragged the rows into"
                  onClick={() => {
                    setView({ sort: 'manual' })
                    setSortOpen(false)
                  }}
                >
                  Manual order
                  {view.sort === 'manual' && <span className="tag-check">✓</span>}
                </div>
                <div
                  className={`tag-menu-item ${view.sort === 'attention' ? 'active' : ''}`}
                  title="Group each repository's rows: Needs you, Working, Quiet — in your order within each. Rows don't drag in this view."
                  onClick={() => {
                    setView({ sort: 'attention' })
                    setSortOpen(false)
                  }}
                >
                  Attention first
                  {view.sort === 'attention' && <span className="tag-check">✓</span>}
                </div>
                <div className="detail-menu-divider" />
                <div
                  className={`tag-menu-item ${view.compact ? 'active' : ''}`}
                  title="One line a row; a row that needs you keeps its second line"
                  onClick={() => setView({ compact: !view.compact })}
                >
                  Compact rows
                  {view.compact && <span className="tag-check">✓</span>}
                </div>
                <div
                  className={`tag-menu-item ${view.hideUnloaded ? 'active' : ''}`}
                  title="Leave out worktrees with no loaded session; the selected one always stays"
                  onClick={() => setView({ hideUnloaded: !view.hideUnloaded })}
                >
                  Hide unloaded
                  {view.hideUnloaded && <span className="tag-check">✓</span>}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="sidebar-tag-filter">
          <button
            className={`tag-filter-btn ${tagFilter.length ? 'filtered' : ''}`}
            title="Filter worktrees by tag"
            onClick={() => setTagFilterOpen((v) => !v)}
          >
            {filterTags.map((t) => (
              <span key={t.id} className="tag-dot" style={{ color: t.color }} />
            ))}
            Tag: {filterLabel}
            <span className="chip-caret">▾</span>
          </button>
          {tagFilter.length > 0 && (
            <button
              className="tag-filter-clear"
              title="Clear tag filter"
              onClick={() => setTagFilter([])}
            >
              ×
            </button>
          )}
          {tagFilterOpen && (
            <>
              <div className="detail-menu-backdrop" onClick={() => setTagFilterOpen(false)} />
              <div className="tag-menu tag-filter-menu">
                <div
                  className={`tag-menu-item ${tagFilter.length === 0 ? 'active' : ''}`}
                  onClick={() => {
                    setTagFilter([])
                    setTagFilterOpen(false)
                  }}
                >
                  All
                  {tagFilter.length === 0 && <span className="tag-check">✓</span>}
                </div>
                {tags.map((t) => (
                  <div
                    key={t.id}
                    className={`tag-menu-item ${tagFilter.includes(t.id) ? 'active' : ''}`}
                    onClick={() => toggleTagFilter(t.id)}
                  >
                    <span className="tag-dot" style={{ color: t.color }} />
                    {t.name}
                    {tagFilter.includes(t.id) && <span className="tag-check">✓</span>}
                  </div>
                ))}
                {customTags.length > 0 && <div className="detail-menu-divider" />}
                {customTags.map((t) => (
                  <div
                    key={t.id}
                    className={`tag-menu-item ${tagFilter.includes(t.id) ? 'active' : ''}`}
                    onClick={() => toggleTagFilter(t.id)}
                  >
                    <span className="tag-dot" style={{ color: t.color }} />
                    {t.name}
                    {tagFilter.includes(t.id) && <span className="tag-check">✓</span>}
                  </div>
                ))}
                <div className="detail-menu-divider" />
                <div
                  className={`tag-menu-item ${tagFilter.includes('untagged') ? 'active' : ''}`}
                  onClick={() => toggleTagFilter('untagged')}
                >
                  Untagged
                  {tagFilter.includes('untagged') && <span className="tag-check">✓</span>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="sidebar-list" onScroll={hideCard}>
        {project.repositories.map(renderSection)}
      </div>
      {hoverCard && <WorktreeHoverCard {...hoverCard} />}
      <div className="sidebar-footer">
        <button
          className="sidebar-nav-row"
          title="Add a repository to this project"
          disabled={offline}
          onClick={() => void getBackend().repos.add()}
        >
          <NavIcon name="add" />
          <span className="sidebar-nav-label">Add repository…</span>
        </button>
        <button
          className={`sidebar-nav-row ${projectPage === 'notes' ? 'active' : ''}`}
          title="Every branch note in this project, including branches whose worktree is gone"
          onClick={() => toggleProjectPage('notes')}
        >
          <NavIcon name="notes" />
          <span className="sidebar-nav-label">All Notes</span>
          {noteCount > 0 && <span className="sidebar-nav-count">{noteCount}</span>}
        </button>
        {features.automations && (
          <button
            className={`sidebar-nav-row ${projectPage === 'automations' ? 'active' : ''}`}
            title="Automations"
            onClick={() => toggleProjectPage('automations')}
          >
            <NavIcon name="automations" />
            <span className="sidebar-nav-label">Automations</span>
            {automationCount > 0 && <span className="sidebar-nav-count">{automationCount}</span>}
            {missedCount > 0 && (
              <span
                className="sidebar-nav-badge"
                title={`${missedCount} automation${missedCount === 1 ? '' : 's'} missed runs`}
              >
                {missedCount}
              </span>
            )}
          </button>
        )}
        {features.settingsEdit && (
          <button
            className={`sidebar-nav-row ${projectPage === 'settings' ? 'active' : ''}`}
            title="App settings"
            onClick={() => toggleProjectPage('settings')}
          >
            <NavIcon name="settings" />
            <span className="sidebar-nav-label">Settings</span>
          </button>
        )}
        <div className="sidebar-footer-row sidebar-footer-sessions">
          <span className={`wt-dot ${runningSessions > 0 ? 'done' : 'idle'}`} />
          {runningSessions} session{runningSessions === 1 ? '' : 's'} running
          {loadedCount > 0 && (
            <button
              className="footer-btn"
              title="Unload every worktree — sessions stay saved and resume when you load them"
              disabled={offline}
              onClick={() => void getBackend().worktrees.unloadAll()}
            >
              Unload all
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
