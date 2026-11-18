import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { instanceForInfo, pullRequestLabel, useAppStore } from '../store'
import type { GitWorktreeInfo } from '../../../shared/types'
import { v2NoteDrafts } from '../v2/noteDrafts'
import { useTicketViews } from '../plugins/useTickets'
import {
  afterDelete,
  collectNotes,
  countLabel,
  deleteGoneLabel,
  deleteQuestion,
  groupNotes,
  noteKey,
  resolveNoteSelection,
  saveStatus,
  type Mark,
  type NoteRef,
  type NoteRow
} from '../allNotes'
import { splitBranch } from './Sidebar'
import { useListDetail } from './useListDetail'
import { removeNote, useNoteDraft } from './useNoteDraft'

interface Props {
  visible: boolean
  /** Live git worktrees, to tell the notes whose worktree no longer exists */
  worktrees: GitWorktreeInfo[]
}

/** A row's text with a search's match marked. */
function Marked({ text, mark }: { text: string; mark: Mark | null }): React.JSX.Element {
  if (!mark) return <>{text}</>
  return (
    <>
      {text.slice(0, mark.start)}
      <mark>{text.slice(mark.start, mark.end)}</mark>
      {text.slice(mark.end)}
    </>
  )
}

/** The selected note's editor, on the same drafts as the worktree's Notes panel. Mounted per note (keyed), so leaving a note saves it. */
function NoteEditor({ row, onTouch }: { row: NoteRow; onTouch: () => void }): React.JSX.Element {
  const draft = useNoteDraft(row.repoId, row.branch)
  return (
    <>
      <textarea
        className="allnotes-textarea"
        aria-label={`Note for ${row.branch}`}
        placeholder={`Notes for ${row.branch}…`}
        value={draft.text}
        readOnly={draft.readOnly}
        spellCheck={false}
        onChange={(e) => {
          onTouch()
          draft.onChange(e.target.value)
        }}
        onBlur={draft.onBlur}
      />
      <div className="allnotes-status muted" role="status">
        {saveStatus(draft.readOnly, draft.pending)}
      </div>
    </>
  )
}

/**
 * Every branch note in the project — including branches whose worktree has since been deleted —
 * as a list beside the selected note, which is edited in place. A search covers branch names and
 * note text. A project page: the sidebar's All Notes row opens it over the worktree detail.
 */
export function AllNotesPanel({ visible, worktrees }: Props): React.JSX.Element {
  const repositories = useAppStore((s) => s.project?.repositories) ?? []
  const offline = useAppStore((s) => s.serverOffline)
  const ticketViewOf = useTicketViews()
  const [chosen, setChosen] = useState<NoteRef | null>(null)
  const [query, setQuery] = useState('')
  /** The note being typed in: a search keeps it among its results until another row is chosen or the search changes. */
  const [held, setHeld] = useState<NoteRef | null>(null)
  /** The confirm bar: for the selected note, or for every note whose worktree is gone. */
  const [confirming, setConfirming] = useState<'one' | 'gone' | null>(null)
  // The list shows a draft's first line: redraw when any draft changes.
  const drafts = v2NoteDrafts()
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => drafts?.subscribe(redraw), [drafts])

  const entries = collectNotes(
    repositories,
    (repoId, branch) => worktrees.some((w) => w.repoId === repoId && w.branch === branch),
    (repoId, branch) => drafts?.get(repoId, branch)?.text ?? null,
    chosen
  )
  const severalRepos = repositories.length > 1
  const groups = groupNotes(entries, query, severalRepos, held)
  const rows = groups.flatMap((g) => g.rows)
  const selected = resolveNoteSelection(rows, chosen)
  const gone = entries.filter((e) => e.gone)
  const pane = useListDetail({ hasSelection: selected !== undefined, scroller: '.allnotes-scroll', selectedRow: '.ld-row.selected .ld-row-main' })

  // An emptied note stays listed only while it is selected and the page shows: leaving the page lets it go.
  const selectedEmpty = selected?.text === ''
  useEffect(() => {
    if (!visible && selectedEmpty) setChosen(null)
  }, [visible, selectedEmpty])

  // The confirm bar takes the focus when it opens (its Keep button), and gives it back when it
  // closes: to the selected row, or to the detail's Delete where a narrow page hides the list.
  const confirmBar = useRef<HTMLDivElement>(null)
  const searchField = useRef<HTMLInputElement>(null)
  const root = pane.root
  const wasConfirming = useRef(false)
  useLayoutEffect(() => {
    if (confirming) confirmBar.current?.querySelector<HTMLElement>('button')?.focus()
    else if (wasConfirming.current && (!document.activeElement || document.activeElement === document.body)) {
      // Only when closing the bar dropped the focus: a search typed while it was open keeps the focus in its field.
      const row = root.current?.querySelector<HTMLElement>('.ld-row.selected .ld-row-main')
      // A hidden row has no boxes and cannot take the focus.
      const to = row && row.getClientRects().length > 0 ? row : root.current?.querySelector<HTMLElement>('.allnotes-actions button[aria-label="Delete this note"]')
      to?.focus({ preventScroll: true })
    }
    wasConfirming.current = confirming !== null
    // `root` is a ref: the same object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming])

  const choose = (row: NoteRow): void => {
    setChosen({ repoId: row.repoId, branch: row.branch })
    // Another row lets the held note go; its own row (a narrow page, back in the list) does not.
    if (held && noteKey(held) !== row.key) setHeld(null)
    setConfirming(null)
    pane.open()
  }
  /**
   * Typing makes the note on show the chosen one and holds it. It may be on show only as the first
   * row (nothing chosen, or the chosen note is not among a search's results), and the typing can
   * change which row is first, stop the note matching the search, or empty it.
   */
  const pin = (): void => {
    if (!selected) return
    const ref = { repoId: selected.repoId, branch: selected.branch }
    if (!chosen || noteKey(chosen) !== selected.key) setChosen(ref)
    if (!held || noteKey(held) !== selected.key) setHeld(ref)
  }
  /** A new search: its results are its matches alone, and a question asked about the old results' note is dropped. */
  const search = (text: string): void => {
    setQuery(text)
    setHeld(null)
    setConfirming(null)
  }
  /** Asks about the gone notes. The bar sits in the list, so a narrow page showing a detail goes back to the list first. */
  const askGone = (): void => {
    pane.back()
    setConfirming('gone')
  }
  const show = (info: GitWorktreeInfo): void => {
    const project = useAppStore.getState().project
    const instance = project ? instanceForInfo(project, info) : undefined
    useAppStore.getState().selectWorktree({ path: info.path }, instance?.id)
  }
  const confirmDelete = (): void => {
    if (confirming === 'one' && selected) {
      removeNote(selected.repoId, selected.branch)
      setChosen(afterDelete(rows, new Set([selected.key]), selected.key))
      // A narrow page showed that note's detail: back to the list.
      pane.back()
    } else if (confirming === 'gone') {
      for (const e of gone) removeNote(e.repoId, e.branch)
      setChosen(afterDelete(rows, new Set(gone.map((e) => `${e.repoId} ${e.branch}`)), selected?.key))
      if (selected?.gone) pane.back()
    }
    setConfirming(null)
  }

  const confirm = confirming && (
    <div className="allnotes-confirm" role="alertdialog" aria-label="Delete" ref={confirmBar} onKeyDown={(e) => e.key === 'Escape' && setConfirming(null)}>
      <span>{confirming === 'one' && selected ? deleteQuestion({ branch: selected.branch }) : deleteQuestion({ gone: gone.length })}</span>
      {/* The two buttons wrap as a pair, under the question in a narrow list. */}
      <span className="allnotes-confirm-buttons">
        <button onClick={() => setConfirming(null)}>Keep</button>
        <button className="danger" disabled={offline} onClick={confirmDelete}>
          {confirming === 'gone' && gone.length > 1 ? `Delete ${gone.length}` : 'Delete'}
        </button>
      </span>
    </div>
  )

  const noteCount = repositories.reduce((n, r) => n + Object.keys(r.branchNotes ?? {}).length, 0)
  const searching = query.trim() !== ''
  const repo = selected ? repositories.find((r) => r.id === selected.repoId) : undefined
  const info = selected ? worktrees.find((w) => w.repoId === selected.repoId && w.branch === selected.branch) : undefined
  const ticket = selected ? repo?.branchTickets?.[selected.branch] : undefined
  const ticketView = ticket ? ticketViewOf(ticket) : undefined
  const ticketWords = ticketView ? (ticketView.info ? `${ticketView.label} · ${ticketView.info.status}` : `Ticket ${ticketView.label}`) : ''
  const pullRequest = selected ? repo?.branchPullRequests?.[selected.branch] : undefined
  const name = selected ? splitBranch(selected.branch) : undefined

  return (
    <div className="allnotes-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="allnotes-header">
        <h2>All Notes</h2>
        {noteCount > 0 && <span className="muted">{countLabel(noteCount)}</span>}
        <span className="allnotes-header-actions">
          {severalRepos && gone.length > 0 && !searching && (
            <button className="allnotes-quiet" disabled={offline} onClick={askGone}>
              {deleteGoneLabel(gone.length, true)}
            </button>
          )}
          {entries.length > 0 && (
            <input
              type="search"
              className="allnotes-search"
              aria-label="Search notes"
              placeholder="Search branches and notes…"
              ref={searchField}
              value={query}
              onChange={(e) => search(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') search('')
              }}
            />
          )}
        </span>
      </div>
      <div className="allnotes-scroll list-detail-host">
        {entries.length === 0 ? (
          <div className="allnotes-empty muted">No notes yet. Use the Notes panel on a worktree to write some — they are keyed to the branch and collected here.</div>
        ) : (
          <div className={`list-detail allnotes-body${pane.showDetail ? ' detail-open' : ''}`} ref={pane.root}>
            <nav className="list-detail-list allnotes-list" aria-label="Notes by branch">
              {confirming === 'gone' && confirm}
              {groups.map((group) => (
                <section key={group.id} className="ld-group" aria-label={group.heading}>
                  <div className="allnotes-group-head">
                    <h4 className="ld-group-head">{group.heading}</h4>
                    {group.id === 'gone' && (
                      <button className="allnotes-quiet" disabled={offline} onClick={askGone}>
                        {deleteGoneLabel(group.goneCount, false)}
                      </button>
                    )}
                  </div>
                  {group.rows.map((row) => (
                    <div key={row.key} className={`ld-row notes-row${row.key === selected?.key ? ' selected' : ''}${row.gone ? ' gone dim' : ''}`} data-note={row.key}>
                      <button type="button" className="ld-row-main" title={row.branch} aria-current={row.key === selected?.key ? 'true' : undefined} onClick={() => choose(row)}>
                        <span className="ld-row-text">
                          <span className="ld-row-name">
                            <Marked text={row.short} mark={row.nameMark} />
                          </span>
                          <span className="ld-row-line">
                            <Marked text={row.line} mark={row.lineMark} />
                          </span>
                        </span>
                      </button>
                      <span className="list-detail-chevron" aria-hidden="true">
                        ›
                      </span>
                    </div>
                  ))}
                </section>
              ))}
              {searching && rows.length === 0 && (
                <div className="allnotes-nomatch">
                  <span className="muted">No note or branch matches “{query.trim()}”.</span>
                  <button
                    className="allnotes-quiet"
                    onClick={() => {
                      // The button goes with the line it is on: the focus moves to the field first.
                      searchField.current?.focus()
                      search('')
                    }}
                  >
                    Clear
                  </button>
                </div>
              )}
              <p className="muted allnotes-how">A note belongs to its branch, so it outlives the worktree. Start one from the Notes panel on a worktree; edit it there or here.</p>
            </nav>
            {selected && name && (
              <section className="list-detail-detail allnotes-detail" aria-label={selected.branch}>
                <button type="button" className="list-detail-back" ref={pane.backButton} onClick={pane.back}>
                  ‹ All Notes
                </button>
                {confirming === 'one' && confirm}
                <div className="allnotes-detail-head">
                  <div className="allnotes-detail-title">
                    <h3>
                      {name.prefix && <span className="muted">{name.prefix}</span>}
                      {name.name}
                    </h3>
                    <div className="allnotes-detail-meta">
                      {severalRepos && <span className="muted">{selected.repoName}</span>}
                      {!info && <span className="allnotes-gone-tag">No worktree for this branch</span>}
                      {ticketView &&
                        (ticketView.url ? (
                          <button className="link-button" title={ticketView.info?.title} onClick={() => window.open(ticketView.url as string)}>
                            {ticketWords}
                          </button>
                        ) : (
                          <span className="muted">{ticketWords}</span>
                        ))}
                      {pullRequest && (
                        <button className="link-button" title={`Open pull request — ${pullRequest}`} onClick={() => window.open(pullRequest)}>
                          PR {pullRequestLabel(pullRequest)}
                        </button>
                      )}
                    </div>
                  </div>
                  <span className="allnotes-actions">
                    {info && <button onClick={() => show(info)}>Go to worktree</button>}
                    <button aria-label="Delete this note" disabled={offline} onClick={() => setConfirming('one')}>
                      Delete
                    </button>
                  </span>
                </div>
                <NoteEditor key={selected.key} row={selected} onTouch={pin} />
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
