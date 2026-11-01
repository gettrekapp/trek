import { useEffect, useRef, useState } from 'react'
import { lineClass, patchBody, startsExpanded } from '../../../shared/changes'
import type { ChangedFile, WorktreeChanges } from '../../../shared/types'

const CHANGES_POLL_MS = 5000

export interface ChangesState {
  changes: WorktreeChanges | null
  diffs: Record<string, string> | null
  /** The summary failed to load; the tab falls back to "Changes" */
  error: string | null
  /** The patches failed to load; the summary and tab counts are unaffected */
  diffError: string | null
}

const EMPTY: ChangesState = { changes: null, diffs: null, error: null, diffError: null }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Polls the selected worktree's changes. Patches are fetched only while
 * panelOpen, and again only when the summary changes (or the panel is
 * reopened after a failure). Each poll waits for the last to finish, so a slow
 * repository can't pile up git processes; a wake during a poll runs another
 * straight afterwards.
 */
export function useWorktreeChanges(
  path: string | undefined,
  serverId: string | undefined,
  paused: boolean,
  panelOpen: boolean
): ChangesState {
  const [state, setState] = useState<ChangesState>(EMPTY)
  const panelOpenRef = useRef(panelOpen)
  panelOpenRef.current = panelOpen
  const wakeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    setState(EMPTY)
    if (!path || paused) return undefined

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let rerun = false
    let lastSummary: string | null = null
    // The summary the current patches belong to, and the one whose fetch failed.
    let diffsFor: string | null = null
    let diffFailedFor: string | null = null

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
          diffsFor = null
          diffFailedFor = null
          setState({ ...EMPTY, error: errorMessage(err) })
          return
        }
        if (cancelled) return
        const summary = JSON.stringify(changes)
        const changed = summary !== lastSummary
        lastSummary = summary
        const open = panelOpenRef.current
        if (changed && !open) {
          // Closed panels don't keep patches; they'd be stale on reopening.
          diffsFor = null
          diffFailedFor = null
        }
        setState((prev) => ({
          changes: changed || !prev.changes ? changes : prev.changes,
          diffs: changed && !open ? null : prev.diffs,
          error: null,
          diffError: changed && !open ? null : prev.diffError
        }))

        if (open && diffsFor !== summary && diffFailedFor !== summary) {
          try {
            const diffs = await window.api.worktreeDiff(serverId ?? null, path)
            if (cancelled) return
            diffsFor = summary
            setState((prev) => ({ ...prev, diffs, diffError: null }))
          } catch (err) {
            if (cancelled) return
            diffFailedFor = summary
            setState((prev) => ({ ...prev, diffError: errorMessage(err) }))
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

  return state
}

const STATUS_LETTER: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R'
}

function FileDiff({ file, patch, loading }: {
  file: ChangedFile
  patch: string | undefined
  loading: boolean
}): React.JSX.Element {
  if (file.binary) return <div className="changes-note">Binary file changed</div>
  if (file.tooLarge) return <div className="changes-note">File too large to show</div>
  if (file.unreadable) return <div className="changes-note">File can't be read</div>
  if (patch === undefined) {
    return <div className="changes-note">{loading ? 'Loading…' : 'Diff not available'}</div>
  }
  return (
    <div className="changes-diff">
      {patchBody(patch).map((line, i) => (
        <div key={i} className={`changes-line ${lineClass(line)}`}>
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

interface Props {
  visible: boolean
  state: ChangesState
}

export function ChangesPanel({ visible, state }: Props): React.JSX.Element {
  const { changes, diffs, error, diffError } = state
  // Only the user's own toggles are stored, so a file keeps its default until touched.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

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
      <div className="changes-list">
        {error && <div className="changes-note changes-error">{error}</div>}
        {!error && diffError && (
          <div className="changes-note changes-error">Couldn't load the diffs: {diffError}</div>
        )}
        {!error && !changes && <div className="changes-note">Loading…</div>}
        {!error && changes?.files.length === 0 && <div className="changes-note">No changes</div>}
        {changes?.files.map((file) => {
          const expanded = toggled[file.path] ?? startsExpanded(file)
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
                {!file.binary && !file.tooLarge && !file.unreadable && (
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
                  loading={diffs === null && !diffError}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}