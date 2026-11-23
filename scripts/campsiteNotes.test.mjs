// scripts/campsiteNotes.test.mjs — agents in the camp (campsite part 5): an agent's text cleaned and
// measured, notes on a project's board (the newest 20), the one-a-minute limit, a report's journal
// entry, and the words the noticeboard and the Trails tab show.
import test from 'node:test'
import assert from 'node:assert/strict'
import { NOTES_MAX, NOTE_MAX, POST_EVERY_MS, REPORT_MAX, addNote, cleanText, dropBadNotes, isNote, isReport, noteAtOf, notesOf, takePost, textLength, whoLine } from '../plugins/campsite/shared/notes.ts'
import { JOURNAL_MAX, entryText, isEntry, note } from '../plugins/campsite/shared/journal.ts'
import { NO_NOTES, REPORT_EXCERPT, boardLabel, noteHead, notesSeenNow, reportBy, reportExcerpt, unreadNotes } from '../plugins/campsite/shared/campView.ts'

const T0 = 1_800_000_000_000

test('cleanText: one line, white space collapsed, trimmed; 1 to max code points', () => {
  assert.equal(cleanText('  Tests are green.\r\n\tLeft the flaky one\u2028skipped.  ', NOTE_MAX, 'note'), 'Tests are green. Left the flaky one skipped.')
  assert.equal(cleanText('a\u0000b\u001bc\u009fd', NOTE_MAX, 'note'), 'a b c d', 'control characters become spaces')
  assert.deepEqual(cleanText(' \n\t ', NOTE_MAX, 'note'), { code: 'BAD_REQUEST', message: 'The note is empty.' })
  assert.deepEqual(cleanText(42, NOTE_MAX, 'note'), { code: 'BAD_REQUEST', message: 'The note must be a string.' })
  assert.deepEqual(cleanText(undefined, REPORT_MAX, 'summary'), { code: 'BAD_REQUEST', message: 'The summary must be a string.' })
  assert.equal(cleanText('x'.repeat(NOTE_MAX), NOTE_MAX, 'note'), 'x'.repeat(NOTE_MAX))
  assert.deepEqual(cleanText('x'.repeat(NOTE_MAX + 1), NOTE_MAX, 'note'), { code: 'BAD_REQUEST', message: 'The note is too long: 141 characters (at most 140).' })
  // Code points: 140 emoji are 280 UTF-16 units, and fit
  const emoji = '🔥'.repeat(NOTE_MAX)
  assert.equal(emoji.length, 2 * NOTE_MAX)
  assert.equal(textLength(emoji), NOTE_MAX)
  assert.equal(cleanText(emoji, NOTE_MAX, 'note'), emoji)
  assert.equal(typeof cleanText('🔥'.repeat(NOTE_MAX + 1), NOTE_MAX, 'note'), 'object')
  assert.equal(cleanText('y'.repeat(REPORT_MAX), REPORT_MAX, 'summary'), 'y'.repeat(REPORT_MAX))
  assert.deepEqual(cleanText('y'.repeat(REPORT_MAX + 1), REPORT_MAX, 'summary'), { code: 'BAD_REQUEST', message: 'The summary is too long: 281 characters (at most 280).' })
})

test('addNote: newest last, the oldest past 20 dropped; ids unique per project; noteAtOf and notesOf', () => {
  const camp = { notes: {} }
  const first = addNote(camp, 'p', { text: 'one', at: T0, agent: 'claude', branch: 'feature/x', member: 'Juniper' })
  assert.deepEqual(first, { id: String(T0), text: 'one', at: T0, agent: 'claude', branch: 'feature/x', member: 'Juniper' })
  assert.equal(addNote(camp, 'p', { text: 'two', at: T0 }).id, `${T0}-2`, 'a second note at the same ms')
  assert.equal(addNote(camp, 'p', { text: 'three', at: T0 }).id, `${T0}-3`)
  for (let i = 0; i < NOTES_MAX; i++) addNote(camp, 'p', { text: `n${i}`, at: T0 + 1000 * (i + 1) })
  assert.equal(camp.notes.p.length, NOTES_MAX)
  assert.equal(camp.notes.p[0].text, 'n0', 'the three oldest went')
  assert.equal(camp.notes.p.at(-1).text, `n${NOTES_MAX - 1}`)
  addNote(camp, 'q', { text: 'elsewhere', at: T0 + 5 })
  assert.deepEqual(noteAtOf(camp), { p: T0 + 1000 * NOTES_MAX, q: T0 + 5 })
  assert.deepEqual(noteAtOf({ notes: { empty: [] } }), {})
  const out = notesOf(camp, { projectId: 'q' })
  assert.deepEqual(out, { notes: [{ id: String(T0 + 5), text: 'elsewhere', at: T0 + 5 }] })
  out.notes[0].text = 'changed'
  assert.equal(camp.notes.q[0].text, 'elsewhere', 'copies')
  assert.deepEqual(notesOf(camp, { projectId: 'nobody' }), { notes: [] })
  assert.deepEqual(notesOf(camp, { projectId: 'toString' }), { notes: [] }, "an Object member is no project")
  assert.deepEqual(notesOf(camp, {}), { code: 'BAD_REQUEST', message: 'Notes need { projectId }' })
})

test('takePost: one post a minute per key; other keys are their own', () => {
  const last = new Map()
  assert.equal(takePost(last, 'session:t1', T0), true)
  assert.equal(takePost(last, 'session:t1', T0 + POST_EVERY_MS - 1), false)
  assert.equal(takePost(last, 'session:t2', T0 + 10), true)
  assert.equal(takePost(last, 'session:t1', T0 + POST_EVERY_MS), true, 'a minute later')
  assert.deepEqual([...last.keys()], ['session:t2', 'session:t1'])
  takePost(last, 'project:p', T0 + 3 * POST_EVERY_MS)
  assert.deepEqual([...last.keys()], ['project:p'], 'keys a minute old are let go')
})

test('isNote, isReport and dropBadNotes: what this version can read', () => {
  assert.equal(isNote({ id: '1', text: 'a', at: T0 }), true)
  assert.equal(isNote({ id: '1', text: 'a', at: T0, agent: 'claude', branch: 'Global', member: 'Ash' }), true)
  for (const bad of [null, [], { id: 1, text: 'a', at: T0 }, { id: '1', at: T0 }, { id: '1', text: 'a', at: 'now' }, { id: '1', text: 'a', at: T0, agent: 3 }]) assert.equal(isNote(bad), false, JSON.stringify(bad))
  assert.equal(isReport({ summary: 's', at: T0 }), true)
  assert.equal(isReport({ summary: 's', at: T0, by: 'Claude' }), true)
  for (const bad of [null, { summary: 1, at: T0 }, { summary: 's' }, { summary: 's', at: T0, by: 2 }]) assert.equal(isReport(bad), false, JSON.stringify(bad))
  const camp = { notes: { p: [{ id: '1', text: 'ok', at: T0 }, { text: 'no id', at: T0 }], q: 'not a list', r: Array.from({ length: 25 }, (_, i) => ({ id: String(i), text: 't', at: T0 + i })) } }
  dropBadNotes(camp)
  assert.deepEqual(camp.notes.p, [{ id: '1', text: 'ok', at: T0 }])
  assert.equal(Object.hasOwn(camp.notes, 'q'), false)
  assert.equal(camp.notes.r.length, NOTES_MAX)
  assert.equal(camp.notes.r[0].id, '5', 'the newest 20')
  const none = { notes: 'garbage' }
  dropBadNotes(none)
  assert.deepEqual(none.notes, {})
  const missing = {}
  dropBadNotes(missing)
  assert.deepEqual(missing.notes, {})
})

test('a report in the journal: "Reported on <branch>: <summary>"; its branch cut like the others; read back', () => {
  const entry = { kind: 'report', at: T0, branch: 'feature/x', summary: 'Tests are green.' }
  assert.equal(entryText(entry), 'Reported on feature/x: Tests are green.')
  assert.equal(isEntry(entry), true)
  assert.equal(isEntry({ kind: 'report', at: T0, branch: 'feature/x' }), false)
  assert.equal(isEntry({ kind: 'report', at: T0, branch: 3, summary: 's' }), false)
  const member = { journal: [] }
  note(member, { kind: 'report', at: T0, branch: 'b'.repeat(100), summary: 'done' })
  assert.equal(member.journal[0].branch.length, 80)
  assert.equal(member.journal[0].summary, 'done')
  for (let i = 0; i < JOURNAL_MAX + 1; i++) note(member, { kind: 'report', at: T0 + i, branch: 'x', summary: 's' })
  assert.equal(member.journal.length, JOURNAL_MAX)
})

test('noticeboard words: who and where, the button, unread notes, the seen time, a report excerpt', () => {
  assert.equal(whoLine('claude', 'Juniper'), 'Claude · Juniper')
  assert.equal(whoLine('codex', undefined), 'Codex')
  assert.equal(whoLine(undefined, 'Ash'), 'Ash')
  assert.equal(whoLine(undefined, undefined), '')
  assert.equal(noteHead({ agent: 'claude', member: 'Juniper', branch: 'feature/x', at: T0 - 12 * 60_000 }, T0), 'Claude · Juniper on feature/x — 12 m ago')
  assert.equal(noteHead({ agent: 'gemini', branch: 'Global', at: T0 }, T0), 'Gemini on Global — just now')
  assert.equal(noteHead({ at: T0 - 2 * 3_600_000 }, T0), 'An agent — 2 h ago')
  assert.equal(NO_NOTES, 'No notes yet. Agents can leave one with camp_note.')
  assert.equal(boardLabel(0), 'Noticeboard')
  assert.equal(boardLabel(1), 'Noticeboard, 1 new note')
  assert.equal(boardLabel(2), 'Noticeboard, 2 new notes')
  assert.equal(boardLabel(null), 'Noticeboard, new notes')
  assert.equal(unreadNotes([{ at: T0 - 1 }, { at: T0 }, { at: T0 + 1 }, { at: T0 + 2 }], T0), 2)
  assert.equal(notesSeenNow(undefined, T0), T0)
  assert.equal(notesSeenNow(T0 - 5, T0), T0)
  assert.equal(notesSeenNow(T0 + 5000, T0), T0 + 5000, "a server clock ahead: the newest note's time")
  assert.equal(notesSeenNow(T0 + 9 * 86_400_000, T0), T0 + 86_400_000, 'at most a day past now')
  assert.deepEqual(reportExcerpt('Short.'), { text: 'Short.', cut: false })
  const exact = 'e'.repeat(REPORT_EXCERPT)
  assert.deepEqual(reportExcerpt(exact), { text: exact, cut: false })
  const long = `${'word '.repeat(20)}end`
  const cut = reportExcerpt(long)
  assert.equal(cut.cut, true)
  assert.equal(cut.text.endsWith('…'), true)
  assert.equal(textLength(cut.text) <= REPORT_EXCERPT, true)
  assert.equal(cut.text, `${'word '.repeat(12).trimEnd()}…`, 'cut at 59 code points, trailing space dropped')
  assert.equal(reportExcerpt('🔥'.repeat(REPORT_EXCERPT + 5)).text, `${'🔥'.repeat(REPORT_EXCERPT - 1)}…`, 'code points: never half an emoji')
  assert.equal(reportBy({ by: 'Claude · Juniper', at: T0 - 5 * 60_000 }, T0), 'Claude · Juniper, 5 m ago')
  assert.equal(reportBy({ at: T0 }, T0), 'An agent, just now')
})
