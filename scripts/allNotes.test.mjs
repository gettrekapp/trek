// scripts/allNotes.test.mjs — the All Notes page: which notes it lists, how they group, what a search finds, and what is selected after a delete.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_LINE,
  afterDelete,
  collectNotes,
  countLabel,
  deleteGoneLabel,
  deleteQuestion,
  groupNotes,
  markOf,
  noteKey,
  previewLine,
  resolveNoteSelection,
  saveStatus,
  shortBranch
} from '../src/renderer/src/allNotes.ts'

const repoA = { id: 'a', name: 'app', branchNotes: { 'feature/x/zeta': 'Zeta first\nsecond line', main: '\n  Things to do  \nlater', 'bug/gone': 'Old steps' } }
const repoB = { id: 'b', name: 'lib', branchNotes: { main: 'Lib note' } }
const live = (repoId, branch) => !(repoId === 'a' && branch === 'bug/gone')
const noDrafts = () => null
const keysOf = (rows) => rows.map((r) => r.key)

test('shortBranch and previewLine: what a row shows', () => {
  assert.equal(shortBranch('bugfix/accounts/fix-count'), 'fix-count')
  assert.equal(shortBranch('main'), 'main')
  assert.equal(previewLine('\n  Things to do  \nlater'), 'Things to do')
  assert.equal(previewLine('  \n\n'), '')
})

test('collectNotes: every note, by repository then branch name, marked gone where the branch has no worktree', () => {
  const entries = collectNotes([repoA, repoB], live, noDrafts, null)
  assert.deepEqual(entries.map((e) => [e.repoId, e.branch, e.gone]), [
    ['a', 'bug/gone', true],
    ['a', 'feature/x/zeta', false],
    ['a', 'main', false],
    ['b', 'main', false]
  ])
  assert.equal(entries[0].repoName, 'app')
  assert.equal(entries[1].text, 'Zeta first\nsecond line')
})

test('collectNotes: a draft is the text shown; an emptied note is listed only while it is the kept one', () => {
  const draft = (repoId, branch) => (repoId === 'a' && branch === 'main' ? 'typed just now' : repoId === 'b' ? '' : null)
  const entries = collectNotes([repoA, repoB], live, draft, null)
  assert.equal(entries.find((e) => e.repoId === 'a' && e.branch === 'main').text, 'typed just now')
  assert.equal(entries.some((e) => e.repoId === 'b'), false, 'emptied and not kept: gone from the list')
  const kept = collectNotes([repoA, repoB], live, draft, { repoId: 'b', branch: 'main' })
  assert.deepEqual(kept.filter((e) => e.repoId === 'b').map((e) => e.text), [''], 'emptied but selected: still listed')
})

test('collectNotes: the kept branch is listed even when the server has no note for it any more', () => {
  const entries = collectNotes([{ id: 'a', name: 'app', branchNotes: {} }], live, noDrafts, { repoId: 'a', branch: 'main' })
  assert.deepEqual(entries.map((e) => [e.branch, e.text]), [['main', '']])
})

test('groupNotes, one repository: with a worktree, then gone, each with its count', () => {
  const groups = groupNotes(collectNotes([repoA], live, noDrafts, null), '', false, null)
  assert.deepEqual(groups.map((g) => [g.id, g.heading, g.goneCount, g.rows.map((r) => r.branch)]), [
    ['live', 'Has a worktree · 2', 0, ['feature/x/zeta', 'main']],
    ['gone', 'Worktree gone · 1', 1, ['bug/gone']]
  ])
  const row = groups[0].rows[0]
  assert.deepEqual([row.key, row.short, row.line, row.nameMark, row.lineMark], ['a feature/x/zeta', 'zeta', 'Zeta first', null, null])
  assert.deepEqual(groupNotes([], '', false, null), [])
})

test('groupNotes, several repositories: a group per repository, its gone notes last', () => {
  const groups = groupNotes(collectNotes([repoA, repoB], live, noDrafts, null), '', true, null)
  assert.deepEqual(groups.map((g) => [g.id, g.heading, g.goneCount, g.rows.map((r) => r.branch)]), [
    ['a', 'app · 3', 1, ['feature/x/zeta', 'main', 'bug/gone']],
    ['b', 'lib · 1', 0, ['main']]
  ])
})

test('groupNotes: an emptied, kept note says so on its row', () => {
  const groups = groupNotes(collectNotes([{ id: 'a', name: 'app', branchNotes: {} }], live, noDrafts, { repoId: 'a', branch: 'main' }), '', false, null)
  assert.equal(groups[0].rows[0].line, EMPTY_LINE)
})

test('groupNotes with a search: one list of the matches, in order, with the matching line and the match marked', () => {
  const entries = collectNotes([repoA, repoB], live, noDrafts, null)
  const [group, ...rest] = groupNotes(entries, '  LATER ', true, null)
  assert.equal(rest.length, 0)
  assert.deepEqual([group.id, group.heading, group.goneCount], ['results', '1 of 4 notes', 0])
  assert.deepEqual([group.rows[0].branch, group.rows[0].line, group.rows[0].lineMark, group.rows[0].nameMark], ['main', 'later', { start: 0, end: 5 }, null])

  const byName = groupNotes(entries, 'zet', true, null)[0].rows[0]
  assert.deepEqual([byName.branch, byName.nameMark, byName.line, byName.lineMark], ['feature/x/zeta', { start: 0, end: 3 }, 'Zeta first', { start: 0, end: 3 }])

  const byPrefix = groupNotes(entries, 'feature/x', true, null)[0]
  assert.deepEqual([byPrefix.heading, byPrefix.rows[0].branch, byPrefix.rows[0].nameMark, byPrefix.rows[0].line], ['1 of 4 notes', 'feature/x/zeta', null, 'Zeta first'], 'a match in the part of the name the row does not show marks nothing')

  assert.deepEqual(keysOf(groupNotes(entries, 'main', true, null)[0].rows), ['a main', 'b main'], 'both repositories, in order')
  assert.deepEqual(groupNotes(entries, 'nothing like it', true, null), [{ id: 'results', heading: '0 of 4 notes', goneCount: 0, rows: [] }])
})

test('groupNotes with a search: the note being typed in stays in the results when it stops matching, in order; a note not held does not', () => {
  const entries = collectNotes([repoA, repoB], live, noDrafts, null)
  // entries: a bug/gone, a feature/x/zeta, a main, b main. "lib" matches only b main's text.
  assert.deepEqual(keysOf(groupNotes(entries, 'lib', true, null)[0].rows), ['b main'])
  const held = groupNotes(entries, 'lib', true, { repoId: 'a', branch: 'feature/x/zeta' })[0]
  assert.deepEqual(keysOf(held.rows), ['a feature/x/zeta', 'b main'], 'the held note, in the entries\' order')
  assert.deepEqual([held.rows[0].line, held.rows[0].lineMark, held.rows[0].nameMark], ['Zeta first', null, null], 'its first line, nothing marked')
  assert.deepEqual(keysOf(groupNotes(entries, 'lib', true, { repoId: 'b', branch: 'main' })[0].rows), ['b main'], 'held and matching: listed once')
  assert.deepEqual(keysOf(groupNotes(entries, 'lib', true, { repoId: 'a', branch: 'nope' })[0].rows), ['b main'], 'held but not listed: nothing added')
  // Without a search nothing is held: the groups are the same.
  assert.deepEqual(groupNotes(entries, '', true, { repoId: 'a', branch: 'main' }), groupNotes(entries, '', true, null))
})

test('markOf: where the search text sits, whatever its case', () => {
  assert.deepEqual(markOf('Release checklist', 'release'), { start: 0, end: 7 })
  assert.deepEqual(markOf('after the storage release', 'RELEASE'), { start: 18, end: 25 })
  assert.equal(markOf('nothing', 'release'), null)
  assert.equal(markOf('anything', '   '), null)
})

test('resolveNoteSelection: the chosen note while it is listed, else the first row', () => {
  const rows = groupNotes(collectNotes([repoA, repoB], live, noDrafts, null), '', true, null).flatMap((g) => g.rows)
  assert.equal(resolveNoteSelection(rows, { repoId: 'b', branch: 'main' }).key, 'b main')
  assert.equal(resolveNoteSelection(rows, null).key, 'a feature/x/zeta')
  assert.equal(resolveNoteSelection(rows, { repoId: 'a', branch: 'nope' }).key, 'a feature/x/zeta')
  assert.equal(resolveNoteSelection([], null), undefined)
})

test('afterDelete: the selection stays unless it was deleted; then the next row, else the one before', () => {
  const rows = groupNotes(collectNotes([repoA, repoB], live, noDrafts, null), '', true, null).flatMap((g) => g.rows)
  // rows: a feature/x/zeta, a main, a bug/gone, b main
  assert.deepEqual(afterDelete(rows, new Set(['a bug/gone']), 'a main'), { repoId: 'a', branch: 'main' }, 'not deleted: stays')
  assert.deepEqual(afterDelete(rows, new Set(['a main']), 'a main'), { repoId: 'a', branch: 'bug/gone' }, 'the next row')
  assert.deepEqual(afterDelete(rows, new Set(['a main', 'a bug/gone']), 'a main'), { repoId: 'b', branch: 'main' }, 'the next row that is left')
  assert.deepEqual(afterDelete(rows, new Set(['b main']), 'b main'), { repoId: 'a', branch: 'bug/gone' }, 'the last row: the one before')
  assert.equal(afterDelete(rows, new Set(keysOf(rows)), 'a main'), null)
  assert.equal(afterDelete(rows, new Set(['a main']), undefined), null, 'nothing was selected')
})

test('the page\'s words: counts, the delete-all action, the confirm question, the save status', () => {
  assert.equal(noteKey({ repoId: 'a', branch: 'main' }), 'a main')
  assert.equal(countLabel(1), '1 note, one per branch')
  assert.equal(countLabel(7), '7 notes, one per branch')
  assert.equal(deleteGoneLabel(1, false), 'Delete it…')
  assert.equal(deleteGoneLabel(2, false), 'Delete both…')
  assert.equal(deleteGoneLabel(5, false), 'Delete all 5…')
  assert.equal(deleteGoneLabel(3, true), 'Delete 3 with no worktree…')
  assert.equal(deleteQuestion({ branch: 'fix-count' }), 'Delete the note for fix-count?')
  assert.equal(deleteQuestion({ gone: 1 }), 'Delete 1 note whose worktree is gone?')
  assert.equal(deleteQuestion({ gone: 4 }), 'Delete 4 notes whose worktree is gone?')
  assert.equal(saveStatus(false, false), 'Saved')
  assert.equal(saveStatus(false, true), 'Saving…')
  assert.equal(saveStatus(true, false), 'Read-only while the server is offline')
  assert.equal(saveStatus(true, true), 'Read-only while the server is offline · not saved yet')
})
