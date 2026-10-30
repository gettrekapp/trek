import { useState } from 'react'
import {
  allWorktrees,
  branchCustomTags,
  branchTag,
  dormantSessions,
  environmentFor,
  GLOBAL_WORKTREE_ID,
  pullRequestLabel,
  serverById,
  serverColorClass,
  tagStyle,
  ticketLabel,
  useAppStore,
  worktreeStatus
} from '../store'
import { loadWorktree, unloadAllWorktrees, unloadWorktree } from '../terminals'
import { NotificationsMenu } from './NotificationsMenu'
import { VoiceToggle } from './VoiceToggle'
import { sameWorktree, worktreeKey } from '../../../shared/types'
import type { GitWorktreeInfo, HostStatus, TerminalStatus } from '../../../shared/types'

interface Props {
  worktrees: GitWorktreeInfo[]
  onAdd: () => void
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

/** "↑2 ↓1 ● dirty" — empty string when the worktree is clean/unknown. */
export function gitStatusLabel(info: GitWorktreeInfo): string {
  const bits: string[] = []
  if (info.ahead) bits.push(`↑${info.ahead}`)
  if (info.behind) bits.push(`↓${info.behind}`)
  if (info.dirty) bits.push('● dirty')
  return bits.join(' ')
}

type DotKind = 'none' | 'dormant' | 'idle' | 'running' | 'attention' | 'done' | 'exited'

const DOT_TITLES: Record<DotKind, string> = {
  none: 'No Claude session',
  dormant: 'Saved Claude sessions — this worktree is unloaded',
  idle: 'Claude session idle',
  running: 'Claude is working',
  attention: 'Claude needs your attention',
  done: 'Claude finished',
  exited: 'Claude session exited'
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

export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
  const project = useAppStore((s) => s.project)!
  const linearIssues = useAppStore((s) => s.linearIssues)
  const selected = useAppStore((s) => s.selected)
  const selectWorktree = useAppStore((s) => s.selectWorktree)
  const terminals = useAppStore((s) => s.terminals)
  const terminalOrder = useAppStore((s) => s.terminalOrder)
  const decisions = useAppStore((s) => s.decisions)
  const loadedWorktrees = useAppStore((s) => s.loadedWorktrees)
  const serverStatus = useAppStore((s) => s.serverStatus)
  const environments = useAppStore((s) => s.environments)
  const envBusy = useAppStore((s) => s.envBusy)
  const [filter, setFilter] = useState('')
  // Tag ids (or 'untagged'); a worktree matching any of them is shown. Empty = all.
  const [tagFilterValue, setTagFilter] = useState<string[]>([])
  const [tagFilterOpen, setTagFilterOpen] = useState(false)
  const setWorktreeOrder = useAppStore((s) => s.setWorktreeOrder)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null)

  const instances = allWorktrees(project)
  const query = filter.trim().toLowerCase()
  const tags = project.worktreeTags ?? []
  const customTags = project.customTags ?? []
  // Filters on since-deleted tags are dropped.
  const filterTags = [...tags, ...customTags].filter((t) => tagFilterValue.includes(t.id))
  const tagFilter = tagFilterValue.filter(
    (id) => id === 'untagged' || filterTags.some((t) => t.id === id)
  )
  const tagOf = (w: GitWorktreeInfo): string | undefined => branchTag(project, w.branch)?.id
  const serverNameOf = (w: GitWorktreeInfo): string | undefined =>
    serverById(project, w.serverId)?.name
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
        (serverNameOf(w)?.toLowerCase().includes(query) ?? false)
    )
    .filter((w) => {
      if (tagFilter.length === 0) return true
      const tag = tagOf(w)
      const custom = (w.branch && project.branchCustomTags?.[w.branch]) || []
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
  }

  const dropOn = (targetKey: string, after: boolean): void => {
    if (!dragKey || dragKey === targetKey) return endDrag()
    const keys = ordered.map(worktreeKey).filter((k) => k !== dragKey)
    const at = keys.indexOf(targetKey) + (after ? 1 : 0)
    keys.splice(at, 0, dragKey)
    setWorktreeOrder(keys)
    endDrag()
  }

  const runningSessions = Object.values(terminals).filter(
    (t) => t.status !== 'exited' && t.worktreeId !== GLOBAL_WORKTREE_ID
  ).length
  // Only worktrees that actually hold terminals are worth offering to unload.
  const loadedCount = Object.keys(loadedWorktrees).filter(
    (id) => (terminalOrder[id]?.length ?? 0) > 0
  ).length

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <input
          className="sidebar-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter worktrees…"
          spellCheck={false}
        />
        <VoiceToggle />
        <NotificationsMenu />
        <button className="sidebar-add" title="New worktree" onClick={onAdd}>
          +
        </button>
      </div>
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
        {rows.map((info) => {
          // The local main checkout matches by isMain, not path: git reports
          // the resolved path, which can differ from the project's stored one.
          const instance =
            info.isMain && !info.serverId
              ? instances[0]
              : instances.find((w) => sameWorktree(w, info))
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
          const tag = branchTag(project, info.branch)
          const rowCustomTags = branchCustomTags(project, info.branch)
          const ticket = info.branch ? project.branchTickets?.[info.branch] : undefined
          const linearIssue = ticket ? linearIssues[ticket] : undefined
          const pullRequest = info.branch
            ? project.branchPullRequests?.[info.branch]
            : undefined
          const env = info.serverId
            ? undefined
            : environmentFor(environments, project.repositoryPath, info.branch)
          const envIsBusy = env ? !!envBusy[env.profile] : false
          const isSelected =
            (selected && sameWorktree(info, selected)) ||
            (info.isMain && !info.serverId && selected?.path === project.repositoryPath && !selected.serverId)
          const server = serverById(project, info.serverId)
          const hostDown = !!info.serverId && serverStatus[info.serverId] !== 'connected'
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
              className={`wt-row ${isSelected ? 'selected' : ''} ${hostDown ? 'host-down' : ''} ${
                dragKey === key ? 'dragging' : ''
              } ${dropClass}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                setDragKey(key)
              }}
              onDragOver={(e) => {
                if (!dragKey) return
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
              onClick={() => selectWorktree({ serverId: info.serverId, path: info.path }, instance?.id)}
              title={`${branchLabel(info)} — ${server ? `${server.name}:` : ''}${info.path}${
                hostDown ? ` (${server?.name ?? 'server'} is disconnected — showing last known state)` : ''
              }`}
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
                  {info.isMain && !info.serverId && <span className="primary-tag">PRIMARY</span>}
                  {info.isMain && info.serverId && <span className="primary-tag remote-main-tag">MAIN</span>}
                </div>
                {prefix && <div className="wt-prefix-line">{prefix}</div>}
                {(tag || rowCustomTags.length > 0 || ticket || pullRequest || server || env || git) && (
                  <div className="wt-bottom">
                    <div className="wt-chips">
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
                      {ticket && (
                        <span
                          className="mini-chip ticket"
                          title={
                            linearIssue
                              ? `${ticket} · ${linearIssue.status} — ${linearIssue.title}`
                              : undefined
                          }
                        >
                          {linearIssue && (
                            <span
                              className="ticket-status-dot"
                              style={{ background: linearIssue.statusColor }}
                            />
                          )}
                          {ticketLabel(ticket)}
                        </span>
                      )}
                      {pullRequest && (
                        <span className="mini-chip pr">{pullRequestLabel(pullRequest)}</span>
                      )}
                      {server && (
                        <span
                          className={`mini-chip server-chip ${serverColorClass(server.id)} ${hostDown ? 'down' : ''}`}
                          title={hostDown ? `${server.name} — disconnected` : server.name}
                        >
                          {hostDown ? '⏻ ' : ''}
                          {server.name}
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
                    title="Unload — end this worktree's Claude sessions (they stay saved)"
                    onClick={(e) => {
                      e.stopPropagation()
                      unloadWorktree(instance.id)
                    }}
                  >
                    ⏏
                  </button>
                )}
                {instance && dormant.length > 0 && (
                  <button
                    className="wt-power dormant"
                    title={`Load ${dormant.length} saved Claude session${dormant.length === 1 ? '' : 's'}`}
                    disabled={hostDown}
                    onClick={(e) => {
                      e.stopPropagation()
                      void loadWorktree(instance.id)
                    }}
                  >
                    ▸{dormant.length}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="sidebar-footer">
        <div className="sidebar-footer-row">
          <span className={`wt-dot ${runningSessions > 0 ? 'done' : 'idle'}`} />
          {runningSessions} Claude session{runningSessions === 1 ? '' : 's'} running
          {loadedCount > 0 && (
            <button
              className="footer-btn"
              title="Unload every worktree — sessions stay saved and resume when you load them"
              onClick={unloadAllWorktrees}
            >
              Unload all
            </button>
          )}
        </div>
        {(project.servers ?? []).map((server) => {
          const status: HostStatus = serverStatus[server.id] ?? 'disconnected'
          const dotClass =
            status === 'connected' ? 'done' : status === 'connecting' ? 'running' : 'exited'
          return (
            <div key={server.id} className="sidebar-footer-row" title={`${server.url} — ${status}`}>
              <span className={`wt-dot ${dotClass}`} />
              {server.name} · {status}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
