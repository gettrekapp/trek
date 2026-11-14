import { useEffect, useState } from 'react'
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
  tagStyle,
  useAppStore,
  worktreeStatus
} from '../store'
import { useTicketViews } from '../plugins/useTickets'
import { safeStatusColor } from '../plugins/ticketProviders'
import { NotificationsMenu } from './NotificationsMenu'
import { PluginSlot } from '../plugins/PluginHost'
import { removalBlock } from '../repoRemoval'
import { getBackend } from '../backend'
import { useFeatures } from '../useFeatures'
import { missedRows } from '../automations'
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

/** "↑2 ↓1 ● dirty" — empty string when the worktree is clean/unknown. Structural, so a v2 `Worktree` works too. */
export function gitStatusLabel(info: Pick<GitWorktreeInfo, 'ahead' | 'behind' | 'dirty'>): string {
  const bits: string[] = []
  if (info.ahead) bits.push(`↑${info.ahead}`)
  if (info.behind) bits.push(`↓${info.behind}`)
  if (info.dirty) bits.push('● dirty')
  return bits.join(' ')
}

type DotKind = 'none' | 'dormant' | 'idle' | 'running' | 'attention' | 'done' | 'exited'

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
  const missedCount = missedRows(project.automations).length
  // The window's connection is down: its commands are disabled until it is back.
  const offline = useAppStore((s) => s.serverOffline)
  const [filter, setFilter] = useState('')
  // Tag ids (or 'untagged'); a worktree matching any of them is shown. Empty = all.
  const [tagFilterValue, setTagFilter] = useState<string[]>([])
  const [tagFilterOpen, setTagFilterOpen] = useState(false)
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

  const renderRow = (info: GitWorktreeInfo): React.JSX.Element => {
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
    const git = gitStatusLabel(info)
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
        className={`wt-row ${isSelected ? 'selected' : ''} ${dragKey === key ? 'dragging' : ''} ${dropClass}`}
        draggable={!offline}
        onDragStart={(e) => {
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
        title={`${branchLabel(info)} — ${info.path}`}
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
            {rowDecisions.length > 0 && (
              <span
                className="decision-icon"
                title={`Needs a decision:\n${rowDecisions.map((d) => d.question).join('\n')}`}
              >
                ⚑
              </span>
            )}
            {prNotice && <PrNoticeFlag title={prNotice} />}
            {info.isMain && <span className="primary-tag">PRIMARY</span>}
          </div>
          {prefix && <div className="wt-prefix-line">{prefix}</div>}
          {(tag || rowCustomTags.length > 0 || ticket || pullRequest || env || git || missing) && (
            <div className="wt-bottom">
              <div className="wt-chips">
                {missing && (
                  <span className="mini-chip wt-missing" title="Git no longer lists this worktree on the server; delete it to drop it">
                    missing
                  </span>
                )}
                {tag && (
                  <span className="mini-chip" style={tagStyle(tag)}>
                    {tag.name}
                  </span>
                )}
                {rowCustomTags.map((t) => (
                  <span key={t.id} className="mini-chip" style={tagStyle(t)}>
                    {t.name}
                  </span>
                ))}
                {ticket && ticketInfo && (
                  <span
                    className="mini-chip ticket"
                    title={
                      ticketInfo.info
                        ? `${ticketInfo.label} · ${ticketInfo.info.status} — ${ticketInfo.info.title}`
                        : undefined
                    }
                  >
                    {ticketInfo.info && (
                      <span
                        className="ticket-status-dot"
                        style={{ background: safeStatusColor(ticketInfo.info.statusColor) }}
                      />
                    )}
                    {ticketInfo.label}
                  </span>
                )}
                {pullRequest && (
                  <span className="mini-chip pr" title={prNotice}>
                    {pullRequestLabel(pullRequest)}
                  </span>
                )}
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
              {git && <span className={`wt-git ${info.dirty ? 'dirty' : ''}`}>{git}</span>}
            </div>
          )}
        </div>
        {/* Always rendered so the row content doesn't shift between rows */}
        <div className="wt-power-slot">
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
              ⏏
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
      </div>
    )
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
    const repoRows = rows.filter((w) => w.repoId === repo.id)
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
        {!isCollapsed && repoRows.map(renderRow)}
      </section>
    )
  }

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
      </div>
      {features.automations && (
        <button
          className={`sidebar-nav-row sidebar-nav-automations ${projectPage === 'automations' ? 'active' : ''}`}
          title="Automations"
          onClick={() => toggleProjectPage('automations')}
        >
          <span className="sidebar-nav-icon">⏰</span>
          <span className="sidebar-nav-label">Automations</span>
          <span className="sidebar-nav-count">{automationCount}</span>
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
      <div className="sidebar-heading">
        <span>Worktrees · {rows.length}</span>
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
      <div className="sidebar-list">
        {project.repositories.map(renderSection)}
      </div>
      <div className="sidebar-footer">
        <div className="sidebar-footer-row">
          <button className="footer-btn" disabled={offline} onClick={() => void getBackend().repos.add()}>
            Add repository…
          </button>
        </div>
        <div className="sidebar-footer-row">
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
        {features.settingsEdit && (
          <button
            className={`sidebar-nav-row ${projectPage === 'settings' ? 'active' : ''}`}
            title="App settings"
            onClick={() => toggleProjectPage('settings')}
          >
            <span className="sidebar-nav-icon">⚙</span>
            <span className="sidebar-nav-label">Settings</span>
          </button>
        )}
      </div>
    </aside>
  )
}
