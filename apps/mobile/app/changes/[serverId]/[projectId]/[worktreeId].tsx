// A worktree's changes. With the server's `review` capability: what is compared (the branch
// against its base, the uncommitted work, or one commit), each file's patch on tap with numbered
// lines, line comments on it (the worktree's draft review, held by the server in the project
// topic and shared with the desktop), and the draft bar that sends the draft to one of the
// worktree's sessions or discards it. The rules are logic/review.ts'. Without the capability (an
// older server): the branch against its base, read-only (6a).
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  BRANCH_SOURCE,
  CAPABILITY,
  sameSource,
  sourceKey,
  sourceLabel,
  type ChangedFile,
  type ChangesSource,
  type CommitInfo,
  type NumberedLine,
  type Project,
  type ReviewComment,
  type ReviewDraft,
  type ServerConnection,
  type Worktree,
  type WorktreeChanges
} from '../../../../src/shared.ts'
import { errorMessage, useConnectionNotice, useServer, useTopic } from '../../../../src/state/hooks.ts'
import { useServers } from '../../../../src/state/ServersProvider.tsx'
import { classifyDiff } from '../../../../src/logic/diff.ts'
import {
  barText,
  commitRow,
  draftOnDiff,
  editConflicted,
  editOf,
  editorAfter,
  hasUnsavedText,
  isReviewConflict,
  newCommentAt,
  noTargetsText,
  reviewFailure,
  saveRequest,
  sendTargets,
  writingOn,
  type CommentEditor,
  type ReviewAction
} from '../../../../src/logic/review.ts'
import { confirmAlert } from '../../../../src/ui/alerts.ts'
import { Button } from '../../../../src/ui/Button.tsx'
import { ReviewContext, type ReviewActions, type ReviewUi } from '../../../../src/ui/CommentBox.tsx'
import { FileDiff } from '../../../../src/ui/FileDiff.tsx'
import { ReviewBar } from '../../../../src/ui/ReviewBar.tsx'
import { colors, ui } from '../../../../src/ui/theme.ts'

interface Params {
  serverId: string
  projectId: string
  worktreeId: string
}

export default function ChangesScreen(): React.JSX.Element {
  const { serverId, projectId, worktreeId } = useLocalSearchParams<{ serverId: string; projectId: string; worktreeId: string }>()
  const server = useServer(serverId)
  // The capability as the server's current welcome has it; while its connection is being made again
  // the last answer holds, so a review being written is not taken off the screen.
  const review = useRef<boolean | null>(null)
  const welcome = server?.connection.welcome
  if (welcome) review.current = welcome.capabilities.includes(CAPABILITY.review)
  return review.current ? (
    // Keyed by the worktree: a comment begun on one is never saved to another.
    <ReviewChanges key={`${serverId}\n${projectId}\n${worktreeId}`} serverId={serverId} projectId={projectId} worktreeId={worktreeId} />
  ) : (
    <ReadOnlyChanges serverId={serverId} projectId={projectId} worktreeId={worktreeId} />
  )
}

// ── A server without `review`: the branch against its base, read-only ──────────────────────────

const LINE_COLOR = { add: colors.ok, del: colors.danger, hunk: colors.accent, meta: colors.muted, context: colors.text }

function ReadOnlyChanges({ serverId, projectId, worktreeId }: Params): React.JSX.Element {
  const server = useServer(serverId)
  const [changes, setChanges] = useState<WorktreeChanges | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [patches, setPatches] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!server) return
    setLoading(true)
    setError(null)
    try {
      setChanges(await server.connection.request('worktree.changes', { projectId, worktreeId }))
      setPatches({})
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [server, projectId, worktreeId])
  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (path: string): Promise<void> => {
    if (open === path) return setOpen(null)
    setOpen(path)
    if (patches[path] !== undefined || !server) return
    try {
      const result = await server.connection.request('worktree.diff', { projectId, worktreeId, paths: [path] })
      setPatches((p) => ({ ...p, [path]: result[path] ?? '' }))
    } catch (err) {
      setPatches((p) => ({ ...p, [path]: `Could not read the diff: ${errorMessage(err)}` }))
    }
  }

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.pad} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
      {error ? <Text style={ui.error}>{error}</Text> : null}
      {changes ? <Text style={ui.muted}>{changes.base ? `Against ${changes.base}, with the uncommitted work` : 'Uncommitted work'}</Text> : null}
      {changes && changes.files.length === 0 ? <Text style={ui.muted}>No changes.</Text> : null}
      {changes?.files.map((f) => (
        <View key={f.path} style={ui.card}>
          <Pressable accessibilityRole="button" onPress={() => void toggle(f.path)}>
            <Text style={ui.text}>{f.path}</Text>
            <Text style={ui.muted}>
              {f.status}
              {f.binary ? ' · binary' : ` · +${f.added} −${f.deleted}`}
            </Text>
          </Pressable>
          {open === f.path ? (
            <ScrollView horizontal>
              <View>
                {patches[f.path] === undefined ? <Text style={ui.muted}>Loading…</Text> : null}
                {classifyDiff(patches[f.path] ?? '').map((line, i) => (
                  <Text key={i} style={[ui.mono, { color: LINE_COLOR[line.kind] }]}>
                    {line.text || ' '}
                  </Text>
                ))}
              </View>
            </ScrollView>
          ) : null}
        </View>
      ))}
    </ScrollView>
  )
}

// ── With `review`: sources, line comments, the draft bar ───────────────────────────────────────

/** A file's patch as it was read: its text (undefined when the diff has none for it), or why it could not be read. */
type ReadPatch = { patch: string | undefined } | { error: string }

/** What was loaded, with the view (worktree and source) it belongs to: another view never shows it. */
interface Held<T> {
  view: string
  value: T
}

const NO_FILES: ChangedFile[] = []
const NO_COMMENTS: readonly ReviewComment[] = []
const NO_PATCHES: Record<string, ReadPatch> = {}

/** A row that only shows a note: there is no patch to ask for. */
const noteOnly = (file: ChangedFile): boolean => !!(file.binary || file.tooLarge || file.unreadable)

function findWorktree(project: Project, worktreeId: string): Worktree | undefined {
  for (const repo of project.repositories) for (const worktree of repo.worktrees) if (worktree.id === worktreeId) return worktree
  return undefined
}

function ReviewChanges({ serverId, projectId, worktreeId }: Params): React.JSX.Element {
  const server = useServer(serverId)
  // The registry's connection at the time of a request: a question can stay up while the phone
  // replaces its connections.
  const { get: currentServer } = useServers()
  const topic = useTopic(serverId, `project:${projectId}`)
  const notice = useConnectionNotice(serverId)
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // ── What is compared, its files and their patches ──
  const [source, setSource] = useState<ChangesSource>(BRANCH_SOURCE)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const view = `${projectId}\n${worktreeId}\n${sourceKey(source)}`
  const [heldChanges, setChanges] = useState<Held<WorktreeChanges> | null>(null)
  const [heldPatches, setPatches] = useState<Held<Record<string, ReadPatch>> | null>(null)
  const [heldError, setError] = useState<Held<string> | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const [loading, setLoading] = useState(false)
  const changes = heldChanges?.view === view ? heldChanges.value : null
  const patches = heldPatches?.view === view ? heldPatches.value : NO_PATCHES
  const error = heldError?.view === view ? heldError.value : null
  const files = changes?.files ?? NO_FILES
  /** The load whose answers are taken: an answer to an earlier one (another source, a refresh since) is dropped. */
  const loadId = useRef(0)

  const readPatch = useCallback(
    async (conn: ServerConnection, id: number, asked: ChangesSource, askedView: string, path: string): Promise<void> => {
      let read: ReadPatch
      try {
        const result = await conn.request('worktree.diff', { projectId, worktreeId, source: asked, paths: [path] })
        read = { patch: Object.hasOwn(result, path) ? result[path] : undefined }
      } catch (err) {
        read = { error: errorMessage(err) }
      }
      if (!mounted.current || loadId.current !== id) return
      setPatches((held) => ({ view: askedView, value: { ...(held?.view === askedView ? held.value : {}), [path]: read } }))
    },
    [projectId, worktreeId]
  )

  /**
   * Reads the file list of the shown source, then the open file's patch again; the other files'
   * patches are dropped and read when they are opened. The open file keeps its patch on screen
   * until the new one is there. Runs when the source changes, on pull to refresh, and when the
   * server's connection is made again (the phone does not poll).
   */
  const load = useCallback(async (): Promise<void> => {
    if (!server) return
    const asked = sourceRef.current
    const askedView = `${projectId}\n${worktreeId}\n${sourceKey(asked)}`
    const id = ++loadId.current
    const current = (): boolean => mounted.current && loadId.current === id
    setLoading(true)
    setError(null)
    try {
      const result = await server.connection.request('worktree.changes', { projectId, worktreeId, source: asked })
      if (!current()) return
      setChanges({ view: askedView, value: result })
      const shown = openRef.current
      const file = shown === null ? undefined : result.files.find((f) => f.path === shown)
      if (shown !== null && !file) setOpen(null)
      setPatches((held) => ({ view: askedView, value: file && held?.view === askedView && Object.hasOwn(held.value, file.path) ? { [file.path]: held.value[file.path] } : {} }))
      if (file && !noteOnly(file)) await readPatch(server.connection, id, asked, askedView, file.path)
    } catch (err) {
      if (current()) setError({ view: askedView, value: errorMessage(err) })
    } finally {
      if (current()) setLoading(false)
    }
  }, [server, projectId, worktreeId, readPatch])
  useEffect(() => {
    void load()
  }, [load, view])

  const toggle = (file: ChangedFile): void => {
    if (open === file.path) {
      setOpen(null)
      return
    }
    setOpen(file.path)
    if (!server || noteOnly(file)) return
    const have = Object.hasOwn(patches, file.path) ? patches[file.path] : undefined
    if (have && !('error' in have)) return
    // A patch that could not be read is asked for again, and reads "Loading…" meanwhile.
    if (have) setPatches((held) => (held?.view === view ? { view, value: Object.fromEntries(Object.entries(held.value).filter(([path]) => path !== file.path)) } : held))
    void readPatch(server.connection, loadId.current, source, view, file.path)
  }

  // ── The commit list ──
  const [picking, setPicking] = useState(false)
  const [commits, setCommits] = useState<CommitInfo[] | null>(null)
  const [commitsError, setCommitsError] = useState<string | null>(null)
  const commitsId = useRef(0)
  const listCommits = async (): Promise<void> => {
    if (picking) {
      setPicking(false)
      return
    }
    setPicking(true)
    setCommitsError(null)
    if (!server) return
    const id = ++commitsId.current
    try {
      const list = await server.connection.request('worktree.commits', { projectId, worktreeId })
      if (mounted.current && commitsId.current === id) setCommits(list)
    } catch (err) {
      if (mounted.current && commitsId.current === id) setCommitsError(`Could not list the commits: ${errorMessage(err)}`)
    }
  }

  // ── The draft ──
  const project = topic.state === 'ready' ? topic.snapshot : null
  const worktree = project ? findWorktree(project, worktreeId) : undefined
  // The worktree's draft in the snapshot. One object per revision (a revision never repeats on a
  // worktree, and every change makes a new one), so a patch to anything else in the project draws
  // no diff again; the last one stays while the topic is not there (reconnecting).
  const heldDraft = useRef<ReviewDraft | undefined>(undefined)
  if (project && heldDraft.current?.revision !== worktree?.review?.revision) heldDraft.current = worktree?.review
  const draft = heldDraft.current
  // The draft as last rendered: what a refusal, which comes later, is shown with.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const onDiff = useMemo(() => draftOnDiff(draft, source, files.map((f) => f.path)), [draft, source, files])

  // ── The comment box and the review's requests ──
  const [editor, setEditor] = useState<CommentEditor | null>(null)
  const editorRef = useRef(editor)
  editorRef.current = editor
  /** The text typed in the open box (ReviewActions.text). */
  const text = useRef('')
  const [busy, setBusy] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  // One request at a time, and one question at a time, also for two taps before anything is drawn disabled.
  const running = useRef(false)
  const asking = useRef(false)

  // The box closes when its comment is gone or another source is shown (never for a topic that is
  // only away: the snapshot it is judged by is the last one read).
  const known = project !== null
  useEffect(() => {
    if (known) setEditor((now) => editorAfter(now, draft, source))
  }, [known, draft, source])

  /** A question before something that cannot be taken back; false when it is declined, or cannot be asked now. */
  const ask = async (title: string, message: string, confirm: string): Promise<boolean> => {
    if (asking.current || running.current) return false
    asking.current = true
    try {
      return (await confirmAlert(title, message, confirm, true)) && mounted.current
    } finally {
      asking.current = false
    }
  }

  /**
   * One review request at a time, over the connection the server has now; true when the server took
   * it. A failure shows in the error line above the bar, unless `handled` takes it: the snapshot
   * stays the truth, and nothing is tried again.
   */
  const request = async (action: ReviewAction, work: (conn: ServerConnection) => Promise<unknown>, handled?: (err: unknown) => boolean): Promise<boolean> => {
    if (running.current) return false
    const now = currentServer(serverId)
    if (!now) {
      setReviewError(reviewFailure(action, new Error('Not connected')))
      return false
    }
    running.current = true
    setBusy(true)
    setReviewError(null)
    try {
      await work(now.connection)
      return true
    } catch (err) {
      if (mounted.current && !handled?.(err)) setReviewError(reviewFailure(action, err))
      return false
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const ref = { projectId, worktreeId }

  /** Opens a box in place of the one that is open, whose unsaved text is asked about first. */
  const openBox = async (next: CommentEditor, initial: string): Promise<void> => {
    if (running.current) return
    if (hasUnsavedText(editorRef.current, text.current) && !(await ask('Discard your comment?', 'The comment you were writing is not saved.', 'Discard'))) return
    text.current = initial
    setReviewError(null)
    setEditor(next)
  }

  const openNew = (path: string, line: NumberedLine): void => {
    const next = newCommentAt(sourceRef.current, path, line)
    if (!next) return
    const now = editorRef.current
    // The line whose box is open already.
    if (now?.kind === 'new' && now.path === next.path && now.side === next.side && now.line === next.line && now.lineText === next.lineText && sameSource(now.source, next.source)) return
    void openBox(next, '')
  }

  const save = async (): Promise<void> => {
    const saving = editorRef.current
    const req = saveRequest(saving, text.current)
    if (!saving || !req) return
    const done =
      req.method === 'review.add'
        ? await request('add', (conn) => conn.request('review.add', { ...ref, ...req.params }))
        : await request(
            'edit',
            (conn) => conn.request('review.edit', { ...ref, ...req.params }),
            (err) => {
              if (saving.kind !== 'edit' || !isReviewConflict(err)) return false
              // The box stays open with the user's text; the next Save is guarded by the comment's
              // body on the server, shown under it. Never saved again by itself.
              setEditor((now) => (now === saving ? editConflicted(saving, draftRef.current) : now))
              return true
            }
          )
    // Any other failure (a reply that was lost too) leaves the box open with its text.
    if (done && mounted.current) setEditor((now) => (now === saving ? null : now))
  }

  const remove = async (comment: ReviewComment): Promise<void> => {
    const body = comment.body.length > 200 ? `${comment.body.slice(0, 200)}…` : comment.body
    if (!(await ask('Delete this comment?', body, 'Delete'))) return
    void request('remove', (conn) => conn.request('review.remove', { ...ref, commentId: comment.id }))
  }

  /** `revision` is the draft's as the bar showed it when the session was tapped: a draft that changed since is refused, and not sent again. */
  const send = (sessionId: string, revision: number): void => {
    void request('send', (conn) => conn.request('review.send', { ...ref, sessionId, revision }))
  }

  const discard = async (revision: number, count: number): Promise<void> => {
    if (!(await ask(`Discard ${barText(count, 0).count}?`, 'The review is deleted, on the desktop too. This cannot be undone.', 'Discard'))) return
    void request('clear', (conn) => conn.request('review.clear', { ...ref, revision }))
  }

  /** Another source: a new comment being written would close with it, so its text is asked about first. */
  const choose = async (next: ChangesSource): Promise<void> => {
    setPicking(false)
    if (sameSource(next, source)) return
    const now = editorRef.current
    if (now?.kind === 'new' && hasUnsavedText(now, text.current) && !(await ask('Discard your comment?', 'The comment you were writing is not saved.', 'Discard'))) return
    setOpen(null)
    setSource(next)
  }

  // ── The open box in view, above the keyboard ──
  const port = useRef<ComponentRef<typeof View>>(null)
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null)
  const offset = useRef(0)
  /** Scrolls the list just far enough that the box's bottom (its Save) is in the list's visible part, without pushing its top out. */
  const reveal = useCallback((box: ComponentRef<typeof View>): void => {
    requestAnimationFrame(() => {
      port.current?.measureInWindow((_x, top, _width, height) => {
        box.measureInWindow((_bx, boxTop, _boxWidth, boxHeight) => {
          const by = Math.min(boxTop + boxHeight + 8 - (top + height), boxTop - top)
          if (by > 0) scroller.current?.scrollTo({ y: offset.current + by, animated: true })
        })
      })
    })
  }, [])
  // The home indicator's inset is under the bar only while the keyboard is away.
  const [keyboardUp, setKeyboardUp] = useState(false)
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true))
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false))
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])
  const inset = keyboardUp ? 0 : insets.bottom

  // One object for the screen's life: each callback is the latest render's.
  const latest = useRef({ openNew, openBox, save, remove })
  latest.current = { openNew, openBox, save, remove }
  const actions = useMemo<ReviewActions>(
    () => ({
      text,
      openNew: (path, line) => latest.current.openNew(path, line),
      openEdit: (comment) => void latest.current.openBox(editOf(comment), comment.body),
      save: () => void latest.current.save(),
      cancel: () => setEditor(null),
      remove: (comment) => void latest.current.remove(comment),
      reveal
    }),
    [reveal]
  )
  const canWrite = !!server
  const edit = editor?.kind === 'edit' ? editor : null
  const reviewUi = useMemo<ReviewUi>(() => ({ edit, busy, canWrite, actions }), [edit, busy, canWrite, actions])

  const subject = source.kind === 'commit' ? commits?.find((c) => c.sha === source.sha)?.subject : undefined
  const now = Date.now()
  const hasDraft = draft !== undefined && draft.comments.length > 0

  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      <ReviewContext.Provider value={reviewUi}>
        <View ref={port} collapsable={false} style={styles.port}>
          <ScrollView
            ref={scroller}
            style={ui.screen}
            contentContainerStyle={ui.pad}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={16}
            onScroll={(e) => {
              offset.current = e.nativeEvent.contentOffset.y
            }}
            refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
          >
            {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
            <View style={[ui.row, { flexWrap: 'wrap' }]}>
              <Button ghost={source.kind !== 'branch'} selected={source.kind === 'branch'} label="Branch" onPress={() => void choose(BRANCH_SOURCE)} />
              <Button ghost={source.kind !== 'uncommitted'} selected={source.kind === 'uncommitted'} label="Uncommitted" onPress={() => void choose({ kind: 'uncommitted' })} />
              <Button ghost={source.kind !== 'commit'} selected={source.kind === 'commit'} label="Commit" onPress={() => void listCommits()} />
            </View>
            {picking ? (
              <View style={ui.card}>
                {commitsError ? <Text style={ui.error}>{commitsError}</Text> : null}
                {commits === null && !commitsError ? <Text style={ui.muted}>{server ? 'Loading…' : 'Not connected'}</Text> : null}
                {commits?.length === 0 ? <Text style={ui.muted}>No commits.</Text> : null}
                {commits?.map((c) => {
                  const row = commitRow(c, now)
                  const chosen = source.kind === 'commit' && source.sha === c.sha
                  return (
                    <Pressable
                      key={c.sha}
                      accessibilityRole="button"
                      accessibilityState={{ selected: chosen }}
                      onPress={() => void choose({ kind: 'commit', sha: c.sha })}
                      style={({ pressed }) => [styles.commit, { opacity: pressed ? 0.7 : 1 }]}
                    >
                      <Text style={[ui.text, chosen ? { color: colors.accent } : null]}>{row.title}</Text>
                      <Text style={ui.muted}>{row.detail}</Text>
                    </Pressable>
                  )
                })}
              </View>
            ) : null}
            <Text style={ui.muted}>{sourceLabel(source, subject)}</Text>
            {error ? <Text style={ui.error}>{error}</Text> : null}
            {project && !worktree ? <Text style={ui.muted}>This worktree is gone.</Text> : null}
            {changes && files.length === 0 ? <Text style={ui.muted}>No changes.</Text> : null}
            {files.map((f) => {
              const comments = onDiff.byPath.get(f.path) ?? NO_COMMENTS
              const expanded = open === f.path
              const read = Object.hasOwn(patches, f.path) ? patches[f.path] : undefined
              return (
                <View key={f.path} style={ui.card}>
                  <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => toggle(f)}>
                    <Text style={ui.text}>{f.path}</Text>
                    <Text style={ui.muted}>
                      {f.status}
                      {f.binary ? ' · binary' : ` · +${f.added} −${f.deleted}`}
                      {comments.length > 0 ? <Text style={{ color: colors.accent }}>{` · ${barText(comments.length, 0).count}`}</Text> : null}
                    </Text>
                  </Pressable>
                  {expanded ? (
                    <FileDiff
                      file={f}
                      patch={read && 'patch' in read ? read.patch : undefined}
                      loading={read === undefined && !noteOnly(f)}
                      failed={read && 'error' in read ? read.error : null}
                      comments={comments}
                      writing={writingOn(editor, source, f.path)}
                      canWrite={canWrite}
                      onOpen={actions.openNew}
                    />
                  ) : null}
                </View>
              )
            })}
          </ScrollView>
        </View>
        {reviewError ? (
          <Text accessibilityRole="alert" style={[ui.error, styles.error, hasDraft ? null : { paddingBottom: 8 + inset }]}>
            {reviewError}
          </Text>
        ) : null}
        {hasDraft ? (
          <ReviewBar draft={draft} elsewhere={onDiff.elsewhere} targets={worktree ? sendTargets(worktree) : []} noTargets={noTargetsText(worktree?.loaded === true)} inset={inset} onSend={send} onDiscard={(revision, count) => void discard(revision, count)} />
        ) : null}
      </ReviewContext.Provider>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  port: { flex: 1 },
  commit: { paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  error: { backgroundColor: colors.panel, paddingHorizontal: 16, paddingTop: 8 }
})
