import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { initiallyExpanded, lineClass, patchBody } from '../../../shared/changes'
import type { ChangedFile, WorktreeChanges } from '../../../shared/types'

const CHANGES_POLL_MS = 5000

export interface ChangesState {
  changes: WorktreeChanges | null
  diffs: Record<string, string> | null
  /** The summary failed to load; the tab falls back to "Changes" */
  error: string | null
  /** The patches failed to load; the summary and tab counts are unaffected */
  diffError: string | null
  /** A fetch of patches is in flight for a summary they don't yet cover */
  diffLoading: boolean
}

/** What the hook stores: the state plus the worktree it belongs to. */
interface OwnedState extends ChangesState {
  path: string | undefined
  serverId: string | undefined
}

const EMPTY: ChangesState = {
  changes: null,
  diffs: null,
  error: null,
  diffError: null,
  diffLoading: false
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Polls the selected worktree's changes. While panelOpen, patches are fetched
 * on every poll, since an edit can keep a file's counts; an identical result
 * changes no state. A failed fetch isn't retried until the summary changes or
 * the panel is reopened. Each poll waits for the last to finish, so a slow
 * repository can't pile up git processes; a wake during a poll runs another
 * straight afterwards.
 */
export function useWorktreeChanges(
  path: string | undefined,
  serverId: string | undefined,
  paused: boolean,
  panelOpen: boolean
): ChangesState {
  const [state, setState] = useState<OwnedState>({ ...EMPTY, path, serverId })
  const panelOpenRef = useRef(panelOpen)
  panelOpenRef.current = panelOpen
  const wakeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    setState({ ...EMPTY, path, serverId })
    if (!path || paused) return undefined

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let rerun = false
    let lastSummary: string | null = null
    // The summary the current patches belong to, the serialised patches, and
    // the summary whose fetch failed.
    let diffsFor: string | null = null
    let diffsJson: string | null = null
    let diffFailedFor: string | null = null

    /** Applies a patch to the state, keeping the same object when nothing differs. */
    const update = (patch: Partial<ChangesState>): void =>
      setState((prev) => {
        const keys = Object.keys(patch) as (keyof ChangesState)[]
        return keys.every((k) => prev[k] === patch[k]) ? prev : { ...prev, ...patch }
      })

    const poll = async (): Promise<void> => {
      if (running) {
        rerun = true
        return
      }
      running = true
      clearTimeout(timer)
      try {
        let changes: WorktreeChanges
        try {
          changes = await window.api.worktreeChanges(serverId ?? null, path)
        } catch (err) {
          if (cancelled) return
          lastSummary = null
          diffsFor = diffsJson = diffFailedFor = null
          update({ ...EMPTY, error: errorMessage(err) })
          return
        }
        if (cancelled) return
        const summary = JSON.stringify(changes)
        const changed = summary !== lastSummary
        lastSummary = summary
        const open = panelOpenRef.current
        const dropDiffs = changed && !open // closed panels don't keep patches
        if (dropDiffs) diffsFor = diffsJson = diffFailedFor = null
        setState((prev) => {
          const next: OwnedState = {
            ...prev,
            changes: changed || !prev.changes ? changes : prev.changes,
            error: null,
            diffs: dropDiffs ? null : prev.diffs,
            diffError: dropDiffs ? null : prev.diffError
          }
          return (Object.keys(next) as (keyof OwnedState)[]).every((k) => next[k] === prev[k])
            ? prev
            : next
        })

        if (open && diffFailedFor !== summary) {
          if (diffsFor !== summary) update({ diffLoading: true })
          try {
            const diffs = await window.api.worktreeDiff(serverId ?? null, path)
            if (cancelled) return
            const json = JSON.stringify(diffs)
            const same = json === diffsJson
            diffsFor = summary
            diffsJson = json
            setState((prev) => {
              const next = {
                ...prev,
                diffs: same && prev.diffs ? prev.diffs : diffs,
                diffError: null,
                diffLoading: false
              }
              return (Object.keys(next) as (keyof OwnedState)[]).every((k) => next[k] === prev[k])
                ? prev
                : next
            })
          } catch (err) {
            if (cancelled) return
            diffFailedFor = summary
            diffsFor = diffsJson = null
            update({ diffError: errorMessage(err), diffLoading: false })
          }
        }
      } finally {
        running = false
        if (!cancelled) {
          if (rerun) {
            rerun = false
            void poll()
          } else {
            timer = setTimeout(() => void poll(), CHANGES_POLL_MS)
          }
        }
      }
    }

    wakeRef.current = () => {
      diffFailedFor = null // reopening retries a failed diff
      void poll()
    }
    void poll()
    return () => {
      cancelled = true
      wakeRef.current = null
      clearTimeout(timer)
    }
  }, [path, serverId, paused])

  useEffect(() => {
    if (panelOpen) wakeRef.current?.()
  }, [panelOpen])

  // The first render after switching worktree still holds the old one's state.
  return state.path === path && state.serverId === serverId ? state : EMPTY
}

const STATUS_LETTER: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R'
}

const FileDiff = memo(function FileDiff({ file, patch, loading, unavailable }: {
  file: ChangedFile
  patch: string | undefined
  loading: boolean
  unavailable: boolean
}): React.JSX.Element {
  const lines = useMemo(() => (patch === undefined ? [] : patchBody(patch)), [patch])
  if (file.binary) return <div className="changes-note">Binary file changed</div>
  if (file.tooLarge) return <div className="changes-note">File too large to show</div>
  if (file.unreadable) return <div className="changes-note">File can't be read</div>
  if (patch === undefined) {
    if (loading) return <div className="changes-note">Loading…</div>
    return (
      <div className="changes-note">{unavailable ? 'Diff not available' : 'No text changes'}</div>
    )
  }
  return (
    <div className="changes-diff">
      <div className="changes-diff-inner">
        {lines.map((line, i) => (
          <div key={i} className={`changes-line ${lineClass(line)}`}>
            {line || ' '}
          </div>
        ))}
      </div>
    </div>
  )
})

interface Props {
  visible: boolean
  paused: boolean
  state: ChangesState
}

export const ChangesPanel = memo(function ChangesPanel({
  visible,
  paused,
  state
}: Props): React.JSX.Element {
  const { changes, diffs, error, diffError, diffLoading } = state
  // Only the user's own toggles are stored, so a file keeps its default until touched.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const autoExpanded = useMemo(
    () => (changes ? initiallyExpanded(changes.files) : new Set<string>()),
    [changes]
  )
  const diffsPending = diffLoading || (diffs === null && !diffError)

  return (
    <div className="notes-panel changes-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="notes-header">
        <span>Changes</span>
        {changes && (
          <span className="muted">
            {changes.base
              ? `compared to ${changes.base}`
              : 'no default branch found — comparing to HEAD'}
          </span>
        )}
      </div>
      {visible && (
        <div className="changes-list">
          {error && <div className="changes-note changes-error">{error}</div>}
          {!error && diffError && (
            <div className="changes-note changes-error">Couldn't load the diffs: {diffError}</div>
          )}
          {!error && !changes && (
            <div className="changes-note">{paused ? 'Server disconnected' : 'Loading…'}</div>
          )}
          {!error && changes?.files.length === 0 && <div className="changes-note">No changes</div>}
          {changes?.files.map((file) => {
            const expanded = toggled[file.path] ?? autoExpanded.has(file.path)
            const noteOnly = file.binary || file.tooLarge || file.unreadable
            return (
              <div key={file.path} className="changes-file">
                <div
                  className="changes-file-row"
                  onClick={() => setToggled((t) => ({ ...t, [file.path]: !expanded }))}
                >
                  <span className="changes-chevron">{expanded ? '▾' : '▸'}</span>
                  <span className={`changes-status ${file.status}`} title={file.status}>
                    {STATUS_LETTER[file.status]}
                  </span>
                  <span className="changes-path" title={file.path}>
                    {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                  </span>
                  {!noteOnly && (
                    <span className="changes-counts">
                      <span className="add">+{file.added}</span>{' '}
                      <span className="del">−{file.deleted}</span>
                    </span>
                  )}
                </div>
                {expanded && (
                  <FileDiff
                    file={file}
                    patch={
                      diffs && Object.hasOwn(diffs, file.path) ? diffs[file.path] : undefined
                    }
                    loading={diffsPending}
                    unavailable={!!diffError}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
})
