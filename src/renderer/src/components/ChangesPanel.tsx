import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
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
import { EDIT_NOT_CONFIRMED, errorCode } from '../v2/errors'
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

/** One of the worktree's open agent sessions a review can be sent to. */
export interface ReviewTarget {
  terminalId: string
  title: string
  /** Its agent and status ("Claude · working"): tells sessions with the same title apart */
  detail: string
}

/** The review's part of the panel (feature `review`, 5c-2). */
export interface ReviewProps {
  /** The server has `review`: sources and line comments */
  enabled: boolean
  /** A connected server without `review` (older than 5c-2): the tab says to update it */
  needsUpdate: boolean
  /** The worktree's draft, as the server has it (the store's `worktreeReviews`) */
  draft: ReviewDraft | undefined
  /** The worktree's open agent sessions, newest first */
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

/**
 * The one comment being written or edited. A new one keeps the source it was opened on (it is saved
 * with it); an edit keeps the body it started from (the compare-and-set's `expected`). The text
 * typed is the panel's own state (EditorTextContext), so an editor that remounts (its line moved,
 * its comment went outdated) keeps it.
 */
type Editor = ({ kind: 'new'; source: ChangesSource } & NewAt) | { kind: 'edit'; commentId: string; startedFrom: string }

interface EditorText {
  text: string
  setText(text: string): void
}

const EditorTextContext = createContext<EditorText>({ text: '', setText: () => {} })

interface ReviewActions {
  editor: Editor | null
  open(editor: Editor, text: string): void
  /** Cancels the editor; focus goes back to its line's `+` or its comment's Edit */
  close(): void
  save(): Promise<boolean>
  remove(comment: ReviewComment): void
  /** Whether a mounting editor takes the focus: one just opened, or one that remounted while it had it */
  claimFocus(): boolean
  busy: boolean
  /** Line comments can be written: feature on, online */
  canWrite: boolean
}

/** What a reply lost with the connection may or may not have done. */
const ADD_NOT_CONFIRMED =
  "The server was not connected, so the comment may not have been added. Check the file's comments once the window is back online before adding it again."
const SEND_NOT_CONFIRMED =
  "The server was not connected, so the review may not have been sent. Check the session's queue once the window is back online."

function CommentEditor({ label, actions }: { label: string; actions: ReviewActions }): React.JSX.Element {
  const { text, setText } = useContext(EditorTextContext)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !actions.claimFocus()) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    // Only on mount: a remount (the line moved) takes the focus back, a re-render doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const canSave = text.trim() !== '' && !actions.busy && actions.canWrite
  const save = (): void => {
    if (canSave) void actions.save()
  }
  return (
    <div className="review-editor">
      <textarea
        ref={ref}
        value={text}
        maxLength={MAX_REVIEW_BODY}
        placeholder="Comment on this line"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            actions.close()
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            save()
          }
        }}
      />
      <div className="review-editor-actions">
        <button className="review-btn" disabled={!canSave} title={actions.canWrite ? undefined : 'Server disconnected'} onClick={save}>
          {label}
        </button>
        <button className="review-btn quiet" onClick={() => actions.close()}>
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
        <CommentEditor label="Save" actions={actions} />
      ) : (
        <>
          <div className="review-comment-body">{comment.body}</div>
          {actions.canWrite && (
            <div className="review-comment-actions">
              <button
                className="review-link review-edit"
                disabled={actions.busy}
                onClick={() => actions.open({ kind: 'edit', commentId: comment.id, startedFrom: comment.body }, comment.body)}
              >
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
const placeOf = (c: { side: 'old' | 'new'; line: number; lineText: string }): string =>
  `${c.side === 'old' ? 'removed line' : 'line'} ${c.line}: ${c.lineText}`

/** ↑/↓ on a line's `+` moves to the file's previous or next commentable line (one tab stop a file). */
function moveAmongAdds(e: React.KeyboardEvent<HTMLButtonElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const all = [...(e.currentTarget.closest('.changes-diff-inner')?.querySelectorAll<HTMLButtonElement>('.review-add') ?? [])]
  const next = all[all.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]
  if (!next) return
  e.preventDefault()
  next.focus()
}

const FileDiff = memo(function FileDiff({ file, patch, loading, unavailable, comments, source, actions }: {
  file: ChangedFile
  patch: string | undefined
  loading: boolean
  unavailable: boolean
  /** This file's comments on this source */
  comments: readonly ReviewComment[]
  /** The source shown */
  source: ChangesSource
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
  // Only a shown patch can say a comment's line changed; otherwise the box just holds them.
  const shown = patch !== undefined && note === null
  const outdated = patch === undefined ? comments : placed.outdated
  const newAt = (l: NumberedLine): NewAt | null =>
    l.side && l.line !== undefined ? { path: file.path, side: l.side, line: l.line, lineText: reviewLineText(l.text) } : null
  // A new comment being written on this file: under its line while the line still reads the same,
  // else in the box at the file's top (the poll changed it, or the patch is not shown).
  const e = actions.editor
  const writing = e?.kind === 'new' && e.path === file.path && sameSource(e.source, source) ? e : null
  const writingAt = writing && shown
    ? lines.findIndex((l) => l.side === writing.side && l.line === writing.line && reviewLineText(l.text) === writing.lineText)
    : -1
  const strayEditor = writing !== null && writingAt < 0
  const firstAdd = actions.canWrite ? lines.findIndex((l) => l.side && l.line !== undefined) : -1
  const boxTitle = !shown
    ? 'Comments on this file'
    : outdated.length > 0
      ? `Outdated: ${outdated.length === 1 ? 'its line has' : 'their lines have'} changed`
      : 'Its line is no longer in this diff'
  return (
    <>
      {(outdated.length > 0 || strayEditor) && (
        <div className="review-outdated">
          <div className="review-outdated-title">{boxTitle}</div>
          {outdated.map((c) => (
            <CommentView key={c.id} comment={c} actions={actions} where={placeOf(c)} />
          ))}
          {strayEditor && writing && (
            <div className="review-stray-editor">
              <div className="review-comment-where">{placeOf(writing)}</div>
              <CommentEditor label="Add comment" actions={actions} />
            </div>
          )}
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
              // Keyed by side and number, so a line the poll moves keeps its row (and its editor).
              return (
                <div key={at ? `${at.side}${at.line}` : `${line.kind}${i}`} className="changes-row">
                  <div className={`changes-line ${kind}`} data-side={at?.side} data-line={at?.line}>
                    {at && actions.canWrite && (
                      <button
                        className="review-add"
                        title="Comment on this line"
                        aria-label={`Comment on ${placeOf(at)}`}
                        tabIndex={i === firstAdd ? 0 : -1}
                        disabled={actions.busy}
                        onKeyDown={moveAmongAdds}
                        onClick={() => actions.open({ kind: 'new', source, ...at }, '')}
                      >
                        +
                      </button>
                    )}
                    {line.kind === 'hunk' || line.kind === 'note' ? line.text || ' ' : `${marker}${line.text}` || ' '}
                  </div>
                  {here?.map((c) => <CommentView key={c.id} comment={c} actions={actions} />)}
                  {i === writingAt && <CommentEditor label="Add comment" actions={actions} />}
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
  // A reply that comes after the panel closed, or for another worktree, is dropped.
  const alive = useRef(true)
  const pathRef = useRef(path)
  pathRef.current = path
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const load = async (): Promise<CommitInfo[] | null> => {
    const asked = path
    const current = (): boolean => alive.current && pathRef.current === asked
    try {
      const list = await getBackend().git.commits({ path: asked })
      if (!current()) return null
      setCommits(list)
      setError(null)
      return list
    } catch (err) {
      if (current()) setError(getBackend().errors.inline(err) ?? errorMessage(err))
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

/** How long "Discard n comments?" waits for its click. */
const DISCARD_ARMED_MS = 4000

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
  const wrapRef = useRef<HTMLSpanElement>(null)
  const sendRef = useRef<HTMLButtonElement>(null)
  const count = draft?.comments.length ?? 0
  useEffect(() => {
    setConfirmDiscard(false)
    if (count === 0) setMenu(false)
  }, [count, draft?.revision])
  // The menu closes on Escape (focus back on Send) and on a click outside it.
  useEffect(() => {
    if (!menu) return undefined
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenu(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setMenu(false)
      sendRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])
  // An armed Discard disarms by itself, or when it loses the focus.
  useEffect(() => {
    if (!confirmDiscard) return undefined
    const timer = setTimeout(() => setConfirmDiscard(false), DISCARD_ARMED_MS)
    return () => clearTimeout(timer)
  }, [confirmDiscard])
  if (count === 0 && !error) return null
  const canSend = count > 0 && review.targets.length > 0 && !review.offline && !actions.busy
  const sendTitle =
    count === 0 ? 'No comments to send' : review.targets.length === 0 ? review.noTargets : review.offline ? 'Server disconnected' : 'Queue the comments on a session as one prompt'
  // The comment being edited is shown even with the list folded.
  const e = actions.editor
  const editingElsewhere = e?.kind === 'edit' && elsewhere.some((c) => c.id === e.commentId)
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
        <span className="review-send-wrap" ref={wrapRef}>
          <button ref={sendRef} className="review-btn review-send" disabled={!canSend} title={sendTitle} onClick={() => setMenu((m) => !m)}>
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
                  <span className="review-send-title">{t.title}</span>
                  <span className="review-send-detail">{t.detail}</span>
                </button>
              ))}
            </div>
          )}
        </span>
        {count > 0 &&
          (confirmDiscard ? (
            <button
              autoFocus
              className="review-btn danger review-discard-confirm"
              disabled={actions.busy || review.offline}
              onBlur={() => setConfirmDiscard(false)}
              onClick={onDiscard}
            >
              Discard {count} {count === 1 ? 'comment' : 'comments'}?
            </button>
          ) : (
            <button className="review-btn quiet review-discard" disabled={actions.busy || review.offline} onClick={() => setConfirmDiscard(true)}>
              Discard
            </button>
          ))}
      </div>
      {error && <div className="changes-error review-error">{error}</div>}
      {(showElsewhere || editingElsewhere) && (
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

const sameTargets = (a: readonly ReviewTarget[], b: readonly ReviewTarget[]): boolean =>
  a.length === b.length && a.every((t, i) => t.terminalId === b[i].terminalId && t.title === b[i].title && t.detail === b[i].detail)

/** The parent builds `review` (and its targets) on every render: compared by what they hold. */
function sameProps(a: Props, b: Props): boolean {
  const ra = a.review
  const rb = b.review
  return (
    a.visible === b.visible &&
    a.paused === b.paused &&
    a.state === b.state &&
    a.path === b.path &&
    a.source === b.source &&
    a.onSource === b.onSource &&
    ra.enabled === rb.enabled &&
    ra.needsUpdate === rb.needsUpdate &&
    ra.draft === rb.draft &&
    ra.noTargets === rb.noTargets &&
    ra.offline === rb.offline &&
    sameTargets(ra.targets, rb.targets)
  )
}

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
  const [editorText, setEditorText] = useState('')
  const editorRef = useRef(editor)
  editorRef.current = editor
  const textRef = useRef(editorText)
  textRef.current = editorText
  /** An editor was just opened: the next one to mount takes the focus */
  const focusNext = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const draft = review.enabled ? review.draft : undefined

  // An edited comment that is gone (sent or removed elsewhere) closes its editor. A disconnect
  // leaves an editor open, its Save disabled until the server is back.
  useEffect(() => {
    if (editor?.kind === 'edit' && !draft?.comments.some((c) => c.id === editor.commentId)) setEditor(null)
  }, [draft, editor])
  // Another source shown: a new comment opened on the last one closes.
  useEffect(() => {
    setEditor((e) => (e?.kind === 'new' && !sameSource(e.source, source) ? null : e))
  }, [source])

  /**
   * After an editor closes, the focus goes back to its line's `+` or its comment's Edit: once the
   * editor is gone and nothing is busy (they are disabled meanwhile), unless the user moved it.
   */
  const focusBack = useRef<Editor | null>(null)
  const restoreFocus = useCallback((e: Editor): void => {
    focusBack.current = e
  }, [])
  useEffect(() => {
    const e = focusBack.current
    const root = panelRef.current
    if (!e || busy || !root) return
    focusBack.current = null
    const active = document.activeElement
    if (active && active !== document.body && !root.contains(active)) return
    const target =
      e.kind === 'new'
        ? root.querySelector<HTMLElement>(
            `.changes-file[data-path="${CSS.escape(e.path)}"] .changes-line[data-side="${e.side}"][data-line="${e.line}"] .review-add`
          )
        : root.querySelector<HTMLElement>(`.review-comment[data-comment-id="${CSS.escape(e.commentId)}"] .review-edit`)
    target?.focus()
  })

  const run = useCallback(async (title: string, work: () => Promise<void>, notConfirmed: string = EDIT_NOT_CONFIRMED): Promise<boolean> => {
    const backend = getBackend()
    setBusy(true)
    setReviewError(null)
    try {
      await work()
      return true
    } catch (err) {
      // A reply lost with the connection: it may have been applied, so the user checks before retrying.
      const text = errorCode(err) === 'NOT_CONNECTED' ? notConfirmed : backend.errors.inline(err)
      if (text) setReviewError(`${title}: ${text}`)
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const open = useCallback((e: Editor, text: string): void => {
    focusNext.current = true
    setEditor(e)
    setEditorText(text)
  }, [])

  const close = useCallback((): void => {
    const e = editorRef.current
    setEditor(null)
    if (e) restoreFocus(e)
  }, [restoreFocus])

  const save = useCallback(async (): Promise<boolean> => {
    const e = editorRef.current
    const text = textRef.current
    if (!e || text.trim() === '') return false
    const done =
      e.kind === 'new'
        ? await run(
            'Could not add the comment',
            async () => {
              await getBackend().review.add(path, { source: e.source, path: e.path, side: e.side, line: e.line, lineText: e.lineText, body: text })
            },
            ADD_NOT_CONFIRMED
          )
        : await run('Could not save the comment', () => getBackend().review.edit(path, e.commentId, text, e.startedFrom))
    if (done && editorRef.current === e) {
      setEditor(null)
      restoreFocus(e)
    }
    return done
  }, [run, path, restoreFocus])

  const remove = useCallback((comment: ReviewComment): void => {
    void run('Could not delete the comment', () => getBackend().review.remove(path, comment.id))
  }, [run, path])

  const claimFocus = useCallback((): boolean => {
    if (focusNext.current) {
      focusNext.current = false
      return true
    }
    // A remount: the old textarea had the focus if nothing holds it now.
    return !document.activeElement || document.activeElement === document.body
  }, [])

  const canWrite = review.enabled && !review.offline
  // One object while nothing it holds changes, so the memoised file diffs don't all re-render
  // (typing changes only EditorTextContext).
  const actions = useMemo<ReviewActions>(
    () => ({ editor, open, close, save, remove, claimFocus, busy, canWrite }),
    [editor, open, close, save, remove, claimFocus, busy, canWrite]
  )
  const editorTextValue = useMemo<EditorText>(() => ({ text: editorText, setText: setEditorText }), [editorText])

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
    <EditorTextContext.Provider value={editorTextValue}>
      <div ref={panelRef} className="notes-panel changes-panel" style={{ display: visible ? 'flex' : 'none' }}>
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
              void run(`Could not send the review to ${target.title}`, () => getBackend().review.send(path, target.terminalId, draft.revision), SEND_NOT_CONFIRMED)
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
                <div key={file.path} className="changes-file" data-path={file.path}>
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
                      source={source}
                      actions={actions}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </EditorTextContext.Provider>
  )
}, sameProps)
