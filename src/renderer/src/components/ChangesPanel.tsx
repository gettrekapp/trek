import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { initiallyExpanded, missingPatchNote, numberedLines, patchBody, type NumberedLine } from '../../../shared/changes'
import {
  BRANCH_SOURCE,
  MAX_REVIEW_BODY,
  placeComments,
  reviewLineText,
  sameSource,
  sourceKey,
  sourceLabel
} from '../../../shared/review'
import { getBackend } from '../backend'
import type { ReviewComment, ReviewDraft } from '../../../shared/model/types'
import type { ChangedFile, ChangesSource, CommitInfo, WorktreeChanges } from '../../../shared/types'

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

/** What the hook stores: the state plus the worktree and source it belongs to. */
interface OwnedState extends ChangesState {
  path: string | undefined
  sourceKey: string
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
  paused: boolean,
  panelOpen: boolean,
  /** What to compare (feature `review`, 5c-2); undefined asks without one, as before */
  source?: ChangesSource
): ChangesState {
  const key = source ? sourceKey(source) : ''
  const [state, setState] = useState<OwnedState>({ ...EMPTY, path, sourceKey: key })
  // The effect re-runs on the key; this holds the source it stands for.
  const sourceRef = useRef(source)
  sourceRef.current = source
  const panelOpenRef = useRef(panelOpen)
  panelOpenRef.current = panelOpen
  const wakeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    setState({ ...EMPTY, path, sourceKey: key })
    if (!path || paused) return undefined
    const asked = sourceRef.current

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
          changes = await getBackend().git.changes({ path }, asked)
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
            const diffs = await getBackend().git.diff({ path }, asked)
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
            // Patches from an older summary mustn't sit beside the new counts.
            const stale = diffsFor !== summary
            diffsFor = diffsJson = null
            update({
              diffError: errorMessage(err),
              diffLoading: false,
              ...(stale ? { diffs: null } : {})
            })
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
  }, [path, paused, key])

  useEffect(() => {
    if (panelOpen) wakeRef.current?.()
  }, [panelOpen])

  // The first render after switching worktree or source still holds the old one's state.
  return state.path === path && state.sourceKey === key ? state : EMPTY
}


const STATUS_LETTER: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R'
}

/** One of the worktree's open sessions a review can be sent to. */
export interface ReviewTarget {
  terminalId: string
  title: string
}

/** The review's part of the panel (feature `review`, 5c-2). */
export interface ReviewProps {
  /** The server has `review`: sources and line comments */
  enabled: boolean
  /** A connected server without `review` (older than 5c-2): the tab says to update it */
  needsUpdate: boolean
  /** The worktree's draft, as the server has it (the store's `worktreeReviews`) */
  draft: ReviewDraft | undefined
  /** The worktree's open sessions, newest first */
  targets: ReviewTarget[]
  /** What the Send button says when there is no session to send to */
  noTargets: string
  offline: boolean
}

/** Where a new comment goes. */
interface NewAt {
  path: string
  side: 'old' | 'new'
  line: number
  lineText: string
}

/** The one comment being written or edited. */
type Editor = ({ kind: 'new' } & NewAt) | { kind: 'edit'; commentId: string }

interface ReviewActions {
  editor: Editor | null
  setEditor(editor: Editor | null): void
  save(text: string): Promise<boolean>
  remove(comment: ReviewComment): void
  busy: boolean
  /** Line comments can be written: feature on, online */
  canWrite: boolean
}

function CommentEditor({ initial, actions }: { initial: string; actions: ReviewActions }): React.JSX.Element {
  const [text, setText] = useState(initial)
  const save = (): void => {
    if (text.trim() === '' || actions.busy) return
    void actions.save(text)
  }
  return (
    <div className="review-editor">
      <textarea
        autoFocus
        value={text}
        maxLength={MAX_REVIEW_BODY}
        placeholder="Comment on this line"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') actions.setEditor(null)
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
        }}
      />
      <div className="review-editor-actions">
        <button className="review-btn" disabled={actions.busy || text.trim() === ''} onClick={save}>
          {initial ? 'Save' : 'Add comment'}
        </button>
        <button className="review-btn quiet" onClick={() => actions.setEditor(null)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function CommentView({ comment, actions, where }: { comment: ReviewComment; actions: ReviewActions; where?: string }): React.JSX.Element {
  const editing = actions.editor?.kind === 'edit' && actions.editor.commentId === comment.id
  return (
    <div className="review-comment" data-comment-id={comment.id}>
      {where && <div className="review-comment-where">{where}</div>}
      {editing ? (
        <CommentEditor initial={comment.body} actions={actions} />
      ) : (
        <>
          <div className="review-comment-body">{comment.body}</div>
          {actions.canWrite && (
            <div className="review-comment-actions">
              <button className="review-link" disabled={actions.busy} onClick={() => actions.setEditor({ kind: 'edit', commentId: comment.id })}>
                Edit
              </button>
              <button className="review-link" disabled={actions.busy} onClick={() => actions.remove(comment)}>
                Delete
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Where a comment was written, for one that is not on a line shown here. */
const placeOf = (c: ReviewComment): string => `${c.side === 'old' ? 'removed line' : 'line'} ${c.line}: ${c.lineText}`

const FileDiff = memo(function FileDiff({ file, patch, loading, unavailable, comments, actions }: {
  file: ChangedFile
  patch: string | undefined
  loading: boolean
  unavailable: boolean
  /** This file's comments on this source */
  comments: readonly ReviewComment[]
  actions: ReviewActions
}): React.JSX.Element {
  const lines = useMemo(() => (patch === undefined ? [] : numberedLines(patchBody(patch))), [patch])
  const placed = useMemo(() => placeComments(comments, lines), [comments, lines])
  const note = file.binary
    ? 'Binary file changed'
    : file.tooLarge
      ? 'File too large to show'
      : file.unreadable
        ? "File can't be read"
        : patch === undefined
          ? missingPatchNote(file, { loading, diffError: unavailable })
          : null
  const outdated = patch === undefined ? comments : placed.outdated
  const newAt = (l: NumberedLine): NewAt | null =>
    l.side && l.line !== undefined ? { path: file.path, side: l.side, line: l.line, lineText: reviewLineText(l.text) } : null
  const editingHere = (at: NewAt): boolean => {
    const e = actions.editor
    return e?.kind === 'new' && e.path === at.path && e.side === at.side && e.line === at.line
  }
  return (
    <>
      {outdated.length > 0 && (
        <div className="review-outdated">
          <div className="review-outdated-title">Outdated: {outdated.length === 1 ? 'its line has' : 'their lines have'} changed</div>
          {outdated.map((c) => (
            <CommentView key={c.id} comment={c} actions={actions} where={placeOf(c)} />
          ))}
        </div>
      )}
      {note !== null ? (
        <div className="changes-note">{note}</div>
      ) : (
        <div className="changes-diff">
          <div className="changes-diff-inner">
            {lines.map((line, i) => {
              const at = newAt(line)
              const here = placed.byLine.get(i)
              const kind = line.kind === 'context' || line.kind === 'note' ? '' : line.kind
              const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'context' ? ' ' : ''
              return (
                <div key={i} className="changes-row">
                  <div className={`changes-line ${kind}`} data-side={at?.side} data-line={at?.line}>
                    {at && actions.canWrite && (
                      <button
                        className="review-add"
                        title="Comment on this line"
                        disabled={actions.busy}
                        onClick={() => actions.setEditor({ kind: 'new', ...at })}
                      >
                        +
                      </button>
                    )}
                    {line.kind === 'hunk' || line.kind === 'note' ? line.text || ' ' : `${marker}${line.text}` || ' '}
                  </div>
                  {here?.map((c) => <CommentView key={c.id} comment={c} actions={actions} />)}
                  {at && editingHere(at) && <CommentEditor initial="" actions={actions} />}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
})

/** The source picker: the branch against its base, the uncommitted work, or one of the newest commits. */
function SourcePicker({ path, source, onSource, base }: {
  path: string
  source: ChangesSource
  onSource(source: ChangesSource): void
  base: string | null | undefined
}): React.JSX.Element {
  const [commits, setCommits] = useState<CommitInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Only the branch's own summary names its base: the option keeps it while another source is shown.
  const lastBase = useRef<string | null>(null)
  if (base) lastBase.current = base
  const load = async (): Promise<CommitInfo[] | null> => {
    try {
      const list = await getBackend().git.commits({ path })
      setCommits(list)
      setError(null)
      return list
    } catch (err) {
      setError(getBackend().errors.inline(err) ?? errorMessage(err))
      return null
    }
  }
  useEffect(() => {
    setCommits(null)
    if (source.kind === 'commit') void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  const chosen = source.kind === 'commit' ? source.sha : ''
  const listed = commits ?? []
  // A commit picked before the list was re-read (or no longer among the newest) still shows.
  const options = chosen && !listed.some((c) => c.sha === chosen) ? [{ sha: chosen, subject: '', author: '', at: 0 }, ...listed] : listed
  return (
    <span className="changes-source">
      <select
        className="changes-source-kind"
        value={source.kind}
        onChange={async (e) => {
          const kind = e.target.value
          if (kind === 'commit') {
            const list = commits ?? (await load())
            if (list && list.length > 0) onSource({ kind: 'commit', sha: list[0].sha })
          } else onSource(kind === 'uncommitted' ? { kind: 'uncommitted' } : BRANCH_SOURCE)
        }}
      >
        <option value="branch">{lastBase.current ? `Branch vs ${lastBase.current}` : 'Branch vs its base'}</option>
        <option value="uncommitted">Uncommitted only</option>
        <option value="commit">One commit…</option>
      </select>
      {source.kind === 'commit' && (
        <select
          className="changes-source-commit"
          value={chosen}
          onFocus={() => void load()}
          onChange={(e) => onSource({ kind: 'commit', sha: e.target.value })}
        >
          {options.map((c) => (
            <option key={c.sha} value={c.sha}>
              {c.sha.slice(0, 7)} {c.subject}
            </option>
          ))}
        </select>
      )}
      {error && <span className="changes-error"> {error}</span>}
    </span>
  )
}

/** Sends the draft to one of the worktree's sessions, or discards it. */
function ReviewBar({ draft, review, elsewhere, actions, onSend, onDiscard, error }: {
  draft: ReviewDraft | undefined
  review: ReviewProps
  /** Comments not shown on this diff: another source, or a file not in it */
  elsewhere: ReviewComment[]
  actions: ReviewActions
  onSend(target: ReviewTarget): void
  onDiscard(): void
  error: string | null
}): React.JSX.Element | null {
  const [menu, setMenu] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [showElsewhere, setShowElsewhere] = useState(false)
  const count = draft?.comments.length ?? 0
  useEffect(() => {
    setConfirmDiscard(false)
    if (count === 0) setMenu(false)
  }, [count, draft?.revision])
  if (count === 0 && !error) return null
  const canSend = count > 0 && review.targets.length > 0 && !review.offline && !actions.busy
  const sendTitle =
    count === 0 ? 'No comments to send' : review.targets.length === 0 ? review.noTargets : review.offline ? 'Server disconnected' : 'Queue the comments on a session as one prompt'
  return (
    <div className="review-bar">
      <div className="review-bar-row">
        <span className="review-count">
          Review · {count} {count === 1 ? 'comment' : 'comments'}
        </span>
        {elsewhere.length > 0 && (
          <button className="review-link review-elsewhere-toggle" onClick={() => setShowElsewhere((v) => !v)}>
            {elsewhere.length} not on this diff {showElsewhere ? '▾' : '▸'}
          </button>
        )}
        <span className="review-bar-spacer" />
        <span className="review-send-wrap">
          <button className="review-btn review-send" disabled={!canSend} title={sendTitle} onClick={() => setMenu((m) => !m)}>
            Send to session ▾
          </button>
          {menu && canSend && (
            <div className="review-send-menu">
              {review.targets.map((t) => (
                <button
                  key={t.terminalId}
                  className="review-send-target"
                  onClick={() => {
                    setMenu(false)
                    onSend(t)
                  }}
                >
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </span>
        {count > 0 &&
          (confirmDiscard ? (
            <button className="review-btn danger review-discard-confirm" disabled={actions.busy || review.offline} onClick={onDiscard}>
              Discard {count} {count === 1 ? 'comment' : 'comments'}?
            </button>
          ) : (
            <button className="review-btn quiet review-discard" disabled={actions.busy || review.offline} onClick={() => setConfirmDiscard(true)}>
              Discard
            </button>
          ))}
      </div>
      {error && <div className="changes-error review-error">{error}</div>}
      {showElsewhere && (
        <div className="review-elsewhere">
          {elsewhere.map((c) => (
            <CommentView key={c.id} comment={c} actions={actions} where={`${sourceLabel(c.source)} · ${c.path}, ${placeOf(c)}`} />
          ))}
        </div>
      )}
    </div>
  )
}

interface Props {
  visible: boolean
  paused: boolean
  state: ChangesState
  path: string
  source: ChangesSource
  onSource(source: ChangesSource): void
  review: ReviewProps
}

const NO_COMMENTS: readonly ReviewComment[] = []

export const ChangesPanel = memo(function ChangesPanel({
  visible,
  paused,
  state,
  path,
  source,
  onSource,
  review
}: Props): React.JSX.Element {
  const { changes, diffs, error, diffError, diffLoading } = state
  // Only the user's own toggles are stored, so a file keeps its default until touched.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const autoExpanded = useMemo(
    () => (changes ? initiallyExpanded(changes.files) : new Set<string>()),
    [changes]
  )
  const diffsPending = diffLoading || (diffs === null && !diffError)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const draft = review.enabled ? review.draft : undefined

  useEffect(() => {
    if (review.offline) setEditor(null)
  }, [review.offline])
  // An edited comment that is gone (sent or removed elsewhere) closes its editor.
  useEffect(() => {
    if (editor?.kind === 'edit' && !draft?.comments.some((c) => c.id === editor.commentId)) setEditor(null)
  }, [draft, editor])

  const run = useCallback(async (title: string, work: () => Promise<void>): Promise<boolean> => {
    const backend = getBackend()
    setBusy(true)
    setReviewError(null)
    try {
      await work()
      return true
    } catch (err) {
      const text = backend.errors.inline(err)
      if (text) setReviewError(`${title}: ${text}`)
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const canWrite = review.enabled && !review.offline
  // One object while nothing it holds changes, so the memoised file diffs don't all re-render.
  const actions = useMemo<ReviewActions>(() => ({
    editor,
    setEditor,
    busy,
    canWrite,
    save: async (text) => {
      const e = editor
      if (!e) return false
      const done =
        e.kind === 'new'
          ? await run('Could not add the comment', async () => {
              await getBackend().review.add(path, { source, path: e.path, side: e.side, line: e.line, lineText: e.lineText, body: text })
            })
          : await run('Could not save the comment', async () => {
              const before = draft?.comments.find((c) => c.id === e.commentId)
              await getBackend().review.edit(path, e.commentId, text, before?.body ?? '')
            })
      if (done) setEditor(null)
      return done
    },
    remove: (comment) => {
      void run('Could not delete the comment', () => getBackend().review.remove(path, comment.id))
    }
  }), [editor, busy, canWrite, run, path, source, draft])

  // This source's comments by file; the rest are listed in the bar.
  const { byPath, elsewhere } = useMemo(() => {
    const byPath = new Map<string, ReviewComment[]>()
    const elsewhere: ReviewComment[] = []
    const shown = new Set(changes?.files.map((f) => f.path) ?? [])
    for (const c of draft?.comments ?? []) {
      if (sameSource(c.source, source) && shown.has(c.path)) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c])
      else elsewhere.push(c)
    }
    return { byPath, elsewhere }
  }, [draft, source, changes])

  return (
    <div className="notes-panel changes-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="notes-header">
        <span>Changes</span>
        {review.enabled ? (
          <SourcePicker path={path} source={source} onSource={onSource} base={changes?.base} />
        ) : (
          <span className="muted">
            {changes && (changes.base ? `compared to ${changes.base}` : 'comparing uncommitted changes only')}
            {review.needsUpdate && (
              <span className="changes-needs-update" title="This server is older than Trek 5c-2">
                {changes ? ' · ' : ''}Update the server to pick a source and comment on lines
              </span>
            )}
          </span>
        )}
      </div>
      {visible && review.enabled && (
        <ReviewBar
          draft={draft}
          review={review}
          elsewhere={elsewhere}
          actions={actions}
          error={reviewError}
          onSend={(target) => {
            if (!draft) return
            void run(`Could not send the review to ${target.title}`, () => getBackend().review.send(path, target.terminalId, draft.revision))
          }}
          onDiscard={() => {
            if (!draft) return
            void run('Could not discard the review', () => getBackend().review.clear(path, draft.revision))
          }}
        />
      )}
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
            const fileComments = byPath.get(file.path) ?? NO_COMMENTS
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
                  {fileComments.length > 0 && (
                    <span className="review-file-count" title="Review comments on this file">
                      💬 {fileComments.length}
                    </span>
                  )}
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
                    comments={fileComments}
                    actions={actions}
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
