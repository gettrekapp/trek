// scripts/campsiteNotes.test.mjs — agents in the camp (campsite part 5): an agent's text cleaned and
// measured, notes on a project's board (the newest 20), the one-a-minute limit, a report's journal
// entry, and the words the noticeboard and the Trails tab show; camp v7: notes and trail reports kept,
// migrated, restored, carried into the history and answered; the board's art and its spot on the strip.
import test from 'node:test'
import assert from 'node:assert/strict'
import { NOTES_MAX, NOTE_MAX, POST_EVERY_MS, REPORT_MAX, addNote, cleanText, dropBadNotes, isNote, isReport, noteAtOf, notesOf, takePost, textLength, whoLine } from '../plugins/campsite/shared/notes.ts'
import { JOURNAL_MAX, entryText, isEntry, note } from '../plugins/campsite/shared/journal.ts'
import { NO_NOTES, REPORT_EXCERPT, boardLabel, noteHead, notesSeenNow, reportBy, reportExcerpt, unreadNotes } from '../plugins/campsite/shared/campView.ts'
import { CAMP_VERSION, isCamp, migrateCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { restore } from '../plugins/campsite/shared/economy.ts'
import { postReport, trailEvent, trailKey, trailLogOf } from '../plugins/campsite/shared/trails.ts'
import { BOARD_H, BOARD_W, boardSpot } from '../plugins/campsite/shared/board.ts'
import { BOARD_SIZE, BUILDING_SCALE, artBottom, boardArt } from '../plugins/campsite/shared/buildingPixels.ts'
import { placeBuildings } from '../plugins/campsite/shared/campEdges.ts'
import { HIKER_W, LOG_W, TENT_W, campLayout } from '../plugins/campsite/shared/layout.ts'

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

/** An open trail of project p on worktree `w` */
const openTrail = (camp, worktreeId, branch = `feature/${worktreeId}`) => {
  camp.trails[trailKey('p', worktreeId)] = { projectId: 'p', worktreeId, repoId: 'r', branch, stage: 1, start: T0, stageAt: T0, checks: null, checksAt: null }
}

test('camp v7: a new camp has no notes; version 6 migrates with none (its trails as they were); the snapshot carries each project\'s newest note time only', () => {
  assert.equal(CAMP_VERSION, 7)
  const camp = newCamp(1, T0)
  assert.deepEqual(camp.notes, {})
  const { notes, ...v6body } = camp
  openTrail(v6body, 'w')
  const v7 = migrateCamp({ ...v6body, version: 6 })
  assert.equal(v7.version, 7)
  assert.deepEqual(v7.notes, {})
  assert.deepEqual(Object.keys(v7.trails), ['p:w'])
  assert.equal(v7.trails['p:w'].report, undefined)
  assert.ok(isCamp(v7))
  assert.deepEqual(snapshot(camp, T0).noteAt, {})
  addNote(camp, 'p', { text: 'hi', at: T0 + 7 })
  const snap = snapshot(camp, T0 + 8)
  assert.deepEqual(snap.noteAt, { p: T0 + 7 })
  assert.equal(JSON.stringify(snap).includes('"hi"'), false, 'not the notes')
})

test('restore: notes, trail reports and history reports it cannot read are dropped; the camp survives', () => {
  const camp = newCamp(1, T0)
  openTrail(camp, 'a')
  openTrail(camp, 'b')
  camp.trails['p:a'].report = { summary: 'fine', at: T0 }
  camp.trails['p:b'].report = { summary: 7, at: T0 }
  camp.trailLog.p = [{ branch: 'x', result: 'summited', start: T0, end: T0 + 1, report: { summary: 'kept', at: T0 } }, { branch: 'y', result: 'turned-back', start: T0, end: T0 + 1, report: 'bad' }]
  camp.notes = { p: [{ id: '1', text: 'ok', at: T0 }, { id: 2 }], q: null }
  const raw = JSON.parse(JSON.stringify(camp))
  assert.ok(isCamp(raw))
  restore(raw, undefined, T0)
  assert.deepEqual(raw.trails['p:a'].report, { summary: 'fine', at: T0 })
  assert.equal(Object.hasOwn(raw.trails['p:b'], 'report'), false, 'the trail stays, its report goes')
  assert.deepEqual(raw.trailLog.p.map((r) => r.report), [{ summary: 'kept', at: T0 }, undefined])
  assert.equal(raw.trailLog.p.length, 2)
  assert.deepEqual(raw.notes, { p: [{ id: '1', text: 'ok', at: T0 }] })
  const noNotes = JSON.parse(JSON.stringify(newCamp(1, T0)))
  delete noNotes.notes
  assert.ok(isCamp(noNotes), 'a camp without notes is still a camp')
  restore(noNotes, undefined, T0)
  assert.deepEqual(noNotes.notes, {})
})

test('postReport: a worktree\'s open trail keeps its latest report; none without a trail; it goes into the history when the trail ends; trailLog answers the open trails\' reports', () => {
  const camp = newCamp(1, T0)
  openTrail(camp, 'w')
  openTrail(camp, 'v')
  camp.trails['other:z'] = { projectId: 'other', worktreeId: 'z', repoId: 'r', branch: 'feature/z', stage: 0, start: T0, stageAt: T0, checks: null, checksAt: null, report: { summary: 'elsewhere', at: T0 } }
  assert.deepEqual(postReport(camp, 'p', 'nope', { summary: 's', at: T0 }), { code: 'NOT_FOUND', message: 'That worktree has no trail.' })
  const t = postReport(camp, 'p', 'w', { summary: 'first', at: T0, by: 'Claude' })
  assert.equal(t.worktreeId, 'w')
  postReport(camp, 'p', 'w', { summary: 'second', at: T0 + 1, by: 'Claude · Ash' })
  assert.deepEqual(camp.trails['p:w'].report, { summary: 'second', at: T0 + 1, by: 'Claude · Ash' }, 'a new one replaces it')
  const out = trailLogOf(camp, { projectId: 'p' })
  assert.deepEqual(out, { log: [], reports: { w: { summary: 'second', at: T0 + 1, by: 'Claude · Ash' } } })
  out.reports.w.summary = 'changed'
  assert.equal(camp.trails['p:w'].report.summary, 'second', 'copies')
  trailEvent(camp, { kind: 'worktree.removed', projectId: 'p', at: T0 + 5, repoId: 'r', worktreeId: 'w', branch: 'feature/w' }, T0 + 5)
  assert.deepEqual(camp.trailLog.p, [{ branch: 'feature/w', result: 'turned-back', start: T0, end: T0 + 5, report: { summary: 'second', at: T0 + 1, by: 'Claude · Ash' } }])
  trailEvent(camp, { kind: 'worktree.removed', projectId: 'p', at: T0 + 6, repoId: 'r', worktreeId: 'v', branch: 'feature/v' }, T0 + 6)
  assert.equal(Object.hasOwn(camp.trailLog.p[1], 'report'), false, 'no report, none in its entry')
  const after = trailLogOf(camp, { projectId: 'p' })
  assert.deepEqual(after.reports, {})
  after.log[0].report.summary = 'changed'
  assert.equal(camp.trailLog.p[0].report.summary, 'second', 'the history\'s reports are copies too')
  assert.deepEqual(trailLogOf(camp, { projectId: 'other' }).reports, { z: { summary: 'elsewhere', at: T0 } })
})

test('the board\'s art: 14×16 at the buildings\' scale, inside its grid; unread adds the fresh note and its red pin', () => {
  assert.deepEqual(BOARD_SIZE, { w: 14, h: 16 })
  assert.deepEqual([BOARD_W, BOARD_H], [14 * BUILDING_SCALE, 16 * BUILDING_SCALE])
  for (const unread of [false, true]) {
    const art = boardArt(unread)
    assert.deepEqual([art.w, art.h], [14, 16])
    for (const r of art.rects) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 14 && r.y + r.h <= 16 && r.w > 0 && r.h > 0, JSON.stringify(r))
  }
  const read = boardArt(false).rects
  const unread = boardArt(true).rects
  assert.equal(read.some((r) => r.fill === '#ff4d3d'), false, 'no red pin when read')
  assert.equal(unread.some((r) => r.fill === '#ff4d3d'), true)
  assert.deepEqual(unread.slice(0, read.length - 4), read.slice(0, read.length - 4), 'the same board under the fresh note')
})

/** A session for the layout */
const at = (n, worktreeId, status = 'working') => ({ terminalId: `t${n}`, label: `Agent ${n}`, provider: 'claude', status, decision: false, worktreeId, worktreeName: worktreeId, branch: worktreeId && `feature/${worktreeId}` })
/** Whether a spot is clear of every span by 6 px */
const clearOf = (spot, spans) => spans.every((s) => spot.x + spot.w + 6 <= s.from || spot.x - 6 >= s.to)

test('boardSpot: on the tents\' line just left of the fire when that is free; clear of tents, the log, the fire, hikers and buildings; none when nothing fits', () => {
  assert.equal(boardSpot(campLayout([], 0), []), null, 'not measured yet')
  // An empty camp: just left of the fire
  const empty = campLayout([], 1200)
  const spot = boardSpot(empty, [])
  assert.deepEqual(spot, { x: empty.fireX - 40 - 6 - BOARD_W, w: BOARD_W, h: BOARD_H, bottom: artBottom('signpost') })
  // Global's log is just left of the fire: the board goes to the nearest free stretch, clear of everything
  const sessions = [at(1, 'api'), at(2, 'api', 'attention'), at(3, 'web', 'done'), at(4, null, 'idle'), at(5, 'web', 'complete'), at(6, null)]
  const edges = placeBuildings({ lights: 1, fire: 3, garden: 2, lake: 2, cabins: 3, shed: 2, signpost: 1, tower: 0 }, 1600, sessions)
  const layout = campLayout(sessions, 1600, edges.reserve)
  const placed = [...edges.left, ...edges.right]
  const busy = boardSpot(layout, placed)
  assert.notEqual(busy, null)
  const spans = [
    { from: layout.fireX - 40, to: layout.fireX + 40 },
    ...layout.tents.map((t) => ({ from: t.x - TENT_W / 2, to: t.x + TENT_W / 2 })),
    { from: layout.log.x - LOG_W / 2, to: layout.log.x + LOG_W / 2 },
    ...layout.hikers.map((h) => ({ from: h.x - HIKER_W / 2, to: h.x + HIKER_W / 2 })),
    ...placed.map((p) => ({ from: p.x, to: p.x + p.w }))
  ]
  assert.ok(clearOf(busy, spans), JSON.stringify({ busy, spans }))
  // Of the free stretches, the one nearest to just left of the fire: no free spot is nearer
  const want = layout.fireX - 40 - 6 - BOARD_W
  for (let x = 8; x + BOARD_W <= 1600 - 8; x++) if (clearOf({ x, w: BOARD_W }, spans)) assert.ok(Math.abs(x - want) >= Math.abs(busy.x - want), `${x} is nearer than ${busy.x}`)
  // What the caller adds to avoid (the empty camp's line of text) is avoided too
  const avoided = boardSpot(empty, [], [{ from: 400, to: 800 }])
  assert.ok(avoided.x + BOARD_W + 6 <= 400, `left of the text: ${avoided.x}`)
  // Its spot (426) taken: the nearest that fits, left of what is in the way (366, 60 px off), not right of the fire (546, 120 px off)
  assert.equal(boardSpot({ width: 1000, fireX: 500, tents: [], log: null, hikers: [] }, [], [{ from: 400, to: 452 }]).x, 366)
  assert.equal(boardSpot({ width: 400, fireX: 200, tents: [], log: null, hikers: [] }, [], [{ from: 8, to: 392 }]), null, 'no room at all')
  assert.equal(boardSpot({ width: 100, fireX: 50, tents: [], log: null, hikers: [] }, []), null, 'the fire leaves no stretch wide enough')
})
