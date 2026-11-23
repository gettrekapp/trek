import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Task } from '../../../shared/model/types'
import type { Repository } from '../../../shared/types'
import { MAX_TASK_STATUS, MAX_TASK_TITLE } from '../../../shared/tasks'
import { useAppStore } from '../store'
import { getBackend } from '../backend'
import { focusTerminal, revealTerminal } from '../terminals'
import { groupTasks, moveTask, nextSelection, startTime, taskCountLine, visibleTaskIds } from '../tasks'
import { useListDetail } from './useListDetail'
import { useTaskField, type TaskFieldState } from './useTaskField'

interface Props {
  visible: boolean
}

const NONE: Task[] = []
const NO_REPOS: Repository[] = []

/** A field's clash box: the value stored elsewhere, against the typed one the field still shows. */
function Clash({ state, label }: { state: TaskFieldState; label: string }): React.JSX.Element | null {
  if (state.theirs === null) return null
  return (
    <div className="tasks-clash" role="alertdialog" aria-label={`${label} changed elsewhere`}>
      <strong>{label} was changed elsewhere while you were editing.</strong>
      <div>
        <span className="muted">Theirs</span>
        <pre>{state.theirs || '(empty)'}</pre>
      </div>
      <div className="tasks-buttons">
        <button onClick={state.keepMine}>Keep mine</button>
        <button onClick={state.useTheirs}>Use theirs</button>
      </div>
    </div>
  )
}

/** A failed save: the typed text stays in the field until Retry saves it. */
function FieldError({ state }: { state: TaskFieldState }): React.JSX.Element | null {
  if (!state.error) return null
  return (
    <div className="error tasks-field-error">
      {state.error}{' '}
      <button className="link-button" onClick={state.commit}>
        Retry
      </button>
    </div>
  )
}

/** Asks which repository a task starts in, when the project has more than one. */
function RepoPicker({ repositories, onPick, onCancel }: { repositories: Repository[]; onPick: (repoId: string) => void; onCancel: () => void }): React.JSX.Element {
  const [repoId, setRepoId] = useState(repositories[0]?.id ?? '')
  return (
    <div className="tasks-repo-picker" role="dialog" aria-label="Start in which repository?">
      <strong>Start in which repository?</strong>
      {repositories.map((r) => (
        <label key={r.id} className="tasks-repo-option">
          <input type="radio" name="task-repo" checked={repoId === r.id} onChange={() => setRepoId(r.id)} />
          {r.name}
        </label>
      ))}
      <div className="tasks-buttons">
        <button className="primary-action" disabled={!repoId} autoFocus onClick={() => onPick(repoId)}>
          Start
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

interface StartState {
  taskId: string
  busy: boolean
  error?: string
  /** Not an error: what the window could not show yet */
  notice?: string
}

interface DetailProps {
  task: Task
  repositories: Repository[]
  offline: boolean
  /** This task's start, when it is the last one asked for */
  start: StartState | null
  /** Any task is starting: one start at a time */
  anyStarting: boolean
  picking: boolean
  onStart: () => void
  onPick: (repoId: string) => void
  onCancelPick: () => void
  /** Runs a change that can take the task out of its place in the list, keeping the focus on the page */
  leaving: (fn: () => Promise<unknown>) => Promise<void>
}

/** One task in full: its fields (saved as they are typed), its actions and where it was started. */
function TaskDetail({ task, repositories, offline, start, anyStarting, picking, onStart, onPick, onCancelPick, leaving }: DetailProps): React.JSX.Element {
  const title = useTaskField(task, 'title')
  const status = useTaskField(task, 'status')
  const details = useTaskField(task, 'details')
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** Cancel in the delete question hands the focus back to Delete… */
  const deleteButton = useRef<HTMLButtonElement>(null)
  const cancelledDelete = useRef(false)
  useLayoutEffect(() => {
    if (confirmDelete || !cancelledDelete.current) return
    cancelledDelete.current = false
    deleteButton.current?.focus()
  }, [confirmDelete])
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(getBackend().errors.inline(err))
    }
  }
  const tasks = getBackend().tasks
  const completed = task.completedAt !== undefined
  const archived = task.archivedAt !== undefined
  const starting = start?.busy === true
  const now = Date.now()
  const repoName = (id: string): string => repositories.find((r) => r.id === id)?.name ?? 'removed repository'
  const worktreeOf = (repoId: string, worktreeId: string) => repositories.find((r) => r.id === repoId)?.worktrees.find((w) => w.id === worktreeId)
  const enterCommits = (state: TaskFieldState) => (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) state.commit()
  }
  return (
    <div className="tasks-detail-body">
      <input
        className="tasks-title-input"
        aria-label="Title"
        value={title.value}
        maxLength={MAX_TASK_TITLE}
        disabled={offline}
        onChange={(e) => title.change(e.target.value)}
        onBlur={title.commit}
        onKeyDown={enterCommits(title)}
      />
      <Clash state={title} label="The title" />
      <FieldError state={title} />
      <input
        className="tasks-status-input"
        aria-label="Status"
        placeholder="Status (optional)"
        value={status.value}
        maxLength={MAX_TASK_STATUS}
        disabled={offline}
        onChange={(e) => status.change(e.target.value)}
        onBlur={status.commit}
        onKeyDown={enterCommits(status)}
      />
      <Clash state={status} label="The status" />
      <FieldError state={status} />
      <div className="tasks-actions">
        <button className="primary-action" disabled={offline || archived || anyStarting} onClick={onStart}>
          {starting ? 'Starting…' : 'Start in new worktree'}
        </button>
        <button disabled={offline} onClick={() => void act(() => leaving(() => tasks.setCompleted(task.id, !completed)))}>
          {completed ? 'Reopen' : 'Complete'}
        </button>
        <button disabled={offline} onClick={() => void act(() => leaving(() => tasks.setArchived(task.id, !archived)))}>
          {archived ? 'Unarchive' : 'Archive'}
        </button>
        {archived && !confirmDelete && (
          <button ref={deleteButton} disabled={offline} onClick={() => setConfirmDelete(true)}>
            Delete…
          </button>
        )}
      </div>
      {archived && confirmDelete && (
        <div className="tasks-confirm" role="alertdialog" aria-label="Delete this task?">
          <span>Delete this task for good?</span>
          <span className="tasks-buttons">
            <button
              className="danger"
              disabled={offline}
              onClick={() => void act(() => leaving(() => tasks.remove(task.id)))}
            >
              Delete
            </button>
            <button
              autoFocus
              onClick={() => {
                cancelledDelete.current = true
                setConfirmDelete(false)
              }}
            >
              Cancel
            </button>
          </span>
        </div>
      )}
      {picking && <RepoPicker repositories={repositories} onPick={onPick} onCancel={onCancelPick} />}
      {archived && <p className="muted tasks-note">Unarchive this task to start it.</p>}
      {start?.error && <div className="error">{start.error}</div>}
      {start?.notice && <div className="muted tasks-note tasks-warning">{start.notice}</div>}
      {error && <div className="error">{error}</div>}
      <label className="tasks-details-label" htmlFor={`task-details-${task.id}`}>
        Details <span className="muted">Markdown. Agents read this with get_task.</span>
      </label>
      <textarea
        id={`task-details-${task.id}`}
        className="tasks-details-input"
        value={details.value}
        disabled={offline}
        rows={12}
        onChange={(e) => details.change(e.target.value)}
        onBlur={details.commit}
      />
      <Clash state={details} label="The details" />
      <FieldError state={details} />
      {(title.saving || status.saving || details.saving) && <span className="muted tasks-note">Saving…</span>}
      {(task.starts?.length ?? 0) > 0 && (
        <section className="tasks-starts" aria-label="Started">
          <h4>Started</h4>
          <ul>
            {[...(task.starts ?? [])].reverse().map((s) => {
              const wt = worktreeOf(s.repositoryId, s.worktreeId)
              return (
                <li key={`${s.at}-${s.worktreeId}`}>
                  <code>{s.branch}</code>
                  {repositories.length > 1 && <span className="muted"> in {repoName(s.repositoryId)}</span>}
                  <span className="muted"> · {startTime(s.at, now)}</span>
                  {!s.sessionId && <span className="error-text"> · the session did not start</span>}
                  {' · '}
                  {wt ? (
                    <button className="link-button" onClick={() => useAppStore.getState().selectWorktree({ path: wt.path }, wt.id)}>
                      Open worktree
                    </button>
                  ) : (
                    <span className="muted">worktree removed</span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * The project's tasks: an add field, the open tasks (drag or Alt+↑/↓ to reorder), a collapsed
 * Completed group and, when asked, the archived ones; the selected task in full beside them.
 */
export function TasksPanel({ visible }: Props): React.JSX.Element {
  const tasks = useAppStore((s) => s.project?.tasks ?? NONE)
  const repositories = useAppStore((s) => s.project?.repositories ?? NO_REPOS)
  const offline = useAppStore((s) => s.serverOffline)
  const [chosen, setChosen] = useState<string | null>(null)
  const [showCompleted, setShowCompleted] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const adding = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [start, setStart] = useState<StartState | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  /**
   * Where the focus goes once the list changes: back to a row moved with Alt+↑/↓ (`row`), or, after a
   * change that takes a task out of its place (`after`), to the selected row (or the detail's title,
   * when the list is hidden) if the focus fell to the page.
   */
  const refocus = useRef<{ row: string } | { after: string } | null>(null)
  const lastIndex = useRef(-1)

  const groups = groupTasks(tasks)
  const visibleIds = visibleTaskIds(groups, showCompleted, showArchived)
  const selectedId = nextSelection(visibleIds, chosen, lastIndex.current)
  const selected = tasks.find((t) => t.id === selectedId)
  useEffect(() => {
    lastIndex.current = selectedId ? visibleIds.indexOf(selectedId) : -1
    // What shows selected is the chosen one: the first open task when the page opens, then it stays
    // put while tasks are added or moved; when it leaves the list, the row that took its place.
    if (selectedId !== undefined && selectedId !== chosen) setChosen(selectedId)
  })
  // Another task: the repository question was about the last one.
  useEffect(() => setPicking(false), [selectedId])
  const pane = useListDetail({ hasSelection: selected !== undefined, scroller: '.tasks-panel', selectedRow: '.ld-row.selected .ld-row-main' })
  const { root } = pane
  useLayoutEffect(() => {
    const want = refocus.current
    if (!want) return
    const rowButton = (id: string | undefined): HTMLElement | null =>
      id === undefined ? null : (root.current?.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"] .ld-row-main`) ?? null)
    if ('row' in want) {
      refocus.current = null
      const button = rowButton(want.row)
      if (button && document.activeElement !== button) button.focus({ preventScroll: true })
      return
    }
    // Still selected and in the list: nothing moved yet.
    if (selectedId === want.after && rowButton(want.after)) return
    refocus.current = null
    // A narrow page going back to the list has already put it on the row.
    if (document.activeElement && document.activeElement !== document.body) return
    const button = rowButton(selectedId)
    const target = button && button.getClientRects().length > 0 ? button : root.current?.querySelector<HTMLElement>('.tasks-title-input')
    target?.focus({ preventScroll: true })
  }, [tasks, selectedId, root])
  /** Runs a change that may take `taskId` out of its place, with the focus kept on the page; rethrows */
  const leaving = async (taskId: string, fn: () => Promise<unknown>): Promise<void> => {
    const want = { after: taskId }
    refocus.current = want
    try {
      await fn()
    } finally {
      if (refocus.current === want) refocus.current = null
    }
  }

  /** Runs a change; false when it failed (the error shows on the page) */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      setError(getBackend().errors.inline(err))
      return false
    }
  }
  const choose = (id: string): void => {
    setChosen(id)
    setPicking(false)
    pane.open()
  }
  const add = async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title || adding.current) return
    adding.current = true
    setAddError(null)
    try {
      const { id } = await getBackend().tasks.save({ title })
      setNewTitle('')
      choose(id)
    } catch (err) {
      setAddError(getBackend().errors.inline(err) ?? 'Not added: the connection dropped')
    } finally {
      adding.current = false
    }
  }
  /** Moves an open task; null when that changes nothing, else whether the server took it */
  const reorder = (id: string, to: number): Promise<boolean> | null => {
    const openIds = groups.open.map((t) => t.id)
    const moved = moveTask(openIds, id, to)
    if (moved.join() === openIds.join()) return null
    const rest = tasks.filter((t) => !openIds.includes(t.id)).map((t) => t.id)
    return act(() => getBackend().tasks.reorder([...moved, ...rest]))
  }
  const startIn = async (task: Task, repositoryId: string): Promise<void> => {
    setPicking(false)
    setStart({ taskId: task.id, busy: true })
    try {
      const { sessionId, windowWorktreeId, linkWarnings } = await getBackend().tasks.start(task.id, repositoryId)
      // The page closes on the new tab: a warning goes where it is seen.
      if (linkWarnings?.length) {
        getBackend().errors.show('Some linked folders were not linked', `The task's worktree was made, but: ${linkWarnings.join('; ')}`)
      }
      if (windowWorktreeId) {
        setStart(null)
        // The new worktree and its tab, as a click on the tab would show them (the page closes).
        revealTerminal(sessionId)
        requestAnimationFrame(() => focusTerminal(sessionId))
      } else {
        setStart({ taskId: task.id, busy: false, notice: "The worktree was made, but its session's tab has not shown up here yet. Check the sidebar for it." })
      }
    } catch (err) {
      const error = getBackend().errors.inline(err) ?? 'The start may not have finished: the connection dropped. Check the sidebar for the new worktree.'
      setStart({ taskId: task.id, busy: false, error })
    }
  }
  const onStart = (task: Task): void => {
    setStart(null)
    if (repositories.length > 1) setPicking(true)
    else if (repositories[0]) void startIn(task, repositories[0].id)
  }

  const row = (t: Task, draggable: boolean, index: number): React.JSX.Element => {
    const isSelected = t.id === selectedId
    const done = t.completedAt !== undefined
    return (
      <div
        key={t.id}
        className={`ld-row tasks-row${isSelected ? ' selected' : ''}${done ? ' done' : ''}${dragging === t.id ? ' dragging' : ''}`}
        data-task={t.id}
        draggable={draggable && !offline}
        onDragStart={(e) => {
          setDragging(t.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => setDragging(null)}
        onDragOver={(e) => {
          if (draggable && dragging) e.preventDefault()
        }}
        onDrop={(e) => {
          e.preventDefault()
          if (dragging && draggable) void reorder(dragging, index)
          setDragging(null)
        }}
      >
        <input
          type="checkbox"
          className="tasks-check"
          aria-label={`${t.title} complete`}
          checked={done}
          disabled={offline}
          onChange={() => void act(() => leaving(t.id, () => getBackend().tasks.setCompleted(t.id, !done)))}
        />
        <button
          type="button"
          className="ld-row-main"
          aria-current={isSelected ? 'true' : undefined}
          aria-keyshortcuts={draggable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
          onClick={() => choose(t.id)}
          onKeyDown={(e) => {
            if (!draggable || offline || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
            e.preventDefault()
            const sent = reorder(t.id, e.key === 'ArrowUp' ? index - 1 : index + 1)
            if (!sent) return
            const want = { row: t.id }
            refocus.current = want
            void sent.then((ok) => {
              if (!ok && refocus.current === want) refocus.current = null
            })
          }}
        >
          <span className="ld-row-text">
            <span className="ld-row-name">{t.title}</span>
            {t.status && (
              <span className="ld-row-line" title={t.status}>
                {t.status}
              </span>
            )}
          </span>
        </button>
        <span className="list-detail-chevron" aria-hidden="true">
          ›
        </span>
      </div>
    )
  }

  return (
    <div className="tasks-panel list-detail-host" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="tasks-header">
        <h2>Tasks</h2>
        <span className="muted">{taskCountLine(groups)}</span>
        <button className={`tasks-archived-toggle${showArchived ? ' active' : ''}`} aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
          Show archived
        </button>
      </div>
      {offline && <div className="muted tasks-offline">Not connected. Tasks can be read but not changed.</div>}
      {error && <div className="error">{error}</div>}
      <div className={`list-detail tasks-body${pane.showDetail ? ' detail-open' : ''}`} ref={pane.root}>
        <nav className="list-detail-list tasks-list" aria-label="Tasks">
          <input
            className="tasks-add"
            placeholder="Add a task and press Enter"
            aria-label="New task title"
            value={newTitle}
            maxLength={MAX_TASK_TITLE}
            disabled={offline}
            onChange={(e) => {
              setNewTitle(e.target.value)
              setAddError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add()
            }}
          />
          {addError && <div className="error">{addError}</div>}
          {tasks.length === 0 && <p className="muted tasks-empty">No tasks yet. Add one above, or ask an agent to add some with the Tasks tools.</p>}
          {groups.open.map((t, i) => row(t, true, i))}
          {groups.completed.length > 0 && (
            <button className="tasks-group-head" aria-expanded={showCompleted} onClick={() => setShowCompleted((v) => !v)}>
              {showCompleted ? '▾' : '▸'} Completed ({groups.completed.length})
            </button>
          )}
          {showCompleted && groups.completed.map((t, i) => row(t, false, i))}
          {showArchived && groups.archived.length > 0 && <div className="tasks-group-head static">Archived ({groups.archived.length})</div>}
          {showArchived && groups.archived.map((t, i) => row(t, false, i))}
        </nav>
        <section className="list-detail-detail tasks-detail" aria-label={selected?.title ?? 'Task'}>
          {selected && (
            <>
              <button type="button" className="list-detail-back" ref={pane.backButton} onClick={pane.back}>
                ‹ Tasks
              </button>
              <TaskDetail
                key={selected.id}
                task={selected}
                repositories={repositories}
                offline={offline}
                start={start?.taskId === selected.id ? start : null}
                anyStarting={start?.busy === true}
                picking={picking}
                onStart={() => onStart(selected)}
                onPick={(repoId) => void startIn(selected, repoId)}
                onCancelPick={() => setPicking(false)}
                leaving={async (fn) => {
                  await leaving(selected.id, fn)
                  // A narrow page showed a task that is gone now: back to the list.
                  if (!useAppStore.getState().project?.tasks?.some((t) => t.id === selected.id)) pane.back()
                }}
              />
            </>
          )}
        </section>
      </div>
    </div>
  )
}
