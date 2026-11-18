// scripts/sidebarRow.test.mjs — a sidebar row's git marks, the reason that takes over its second line, its hover card's pieces, and the Sort menu's view.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attentionGroup,
  cardAnchor,
  compareLabels,
  DEFAULT_SIDEBAR_VIEW,
  gitWords,
  groupByAttention,
  isUnloaded,
  parseSidebarView,
  rowGit,
  rowMatchesQuery,
  rowReason,
  sessionLine,
  sidebarViewChanged
} from '../src/renderer/src/sidebarRow.ts'

test('rowGit: nothing to show for a clean, in-sync or unknown worktree', () => {
  assert.equal(rowGit({}), null)
  assert.equal(rowGit({ ahead: 0, behind: 0, dirty: false }), null)
})

test('rowGit: ahead and behind are the counts; dirty is a flag, not a word', () => {
  assert.deepEqual(rowGit({ ahead: 2, behind: 1, dirty: true }), { counts: '↑2 ↓1', dirty: true })
  assert.deepEqual(rowGit({ behind: 58 }), { counts: '↓58', dirty: false })
  assert.deepEqual(rowGit({ dirty: true }), { counts: '', dirty: true })
})

test('rowReason: an ordinary row has none', () => {
  assert.equal(rowReason({ missing: false, questions: [] }), null)
})

test('rowReason: a decision shows its question', () => {
  assert.deepEqual(rowReason({ missing: false, questions: ['Move items 4–6 to a follow-up?'] }), {
    kind: 'decision',
    text: 'Decision: Move items 4–6 to a follow-up?',
    title: 'Needs a decision:\nMove items 4–6 to a follow-up?'
  })
})

test('rowReason: several decisions show the first and count the rest', () => {
  const reason = rowReason({ missing: false, questions: ['First?', 'Second?', undefined] })
  assert.equal(reason.kind, 'decision')
  assert.equal(reason.text, 'Decision: First? (+2)')
  assert.equal(reason.title, 'Needs a decision:\nFirst?\nSecond?')
})

test('rowReason: a decision with no question still says so', () => {
  assert.equal(rowReason({ missing: false, questions: [undefined] }).text, 'Needs a decision')
})

test('rowReason: a pull request notice names the pull request when its number is known', () => {
  assert.deepEqual(rowReason({ missing: false, questions: [], prNotice: 'Checks failed', prLabel: '#9410' }), {
    kind: 'notice',
    text: 'PR #9410 · Checks failed',
    title: 'Checks failed'
  })
  assert.equal(rowReason({ missing: false, questions: [], prNotice: 'Checks failed', prLabel: 'PR' }).text, 'PR · Checks failed')
  assert.equal(rowReason({ missing: false, questions: [], prNotice: 'Checks failed' }).text, 'PR · Checks failed')
})

test('rowReason: a decision outranks a notice, and a missing worktree outranks both', () => {
  assert.equal(rowReason({ missing: false, questions: ['Q?'], prNotice: 'Checks failed' }).kind, 'decision')
  const missing = rowReason({ missing: true, questions: ['Q?'], prNotice: 'Checks failed' })
  assert.equal(missing.kind, 'missing')
  assert.equal(missing.text, 'Missing on the server · delete to drop')
})

test('sessionLine: each session status has a dot and a word', () => {
  assert.deepEqual(sessionLine('working'), { dot: 'running', word: 'working' })
  assert.deepEqual(sessionLine('starting'), { dot: 'running', word: 'starting' })
  assert.deepEqual(sessionLine('attention'), { dot: 'attention', word: 'needs you' })
  assert.deepEqual(sessionLine('done'), { dot: 'done', word: 'finished' })
  assert.deepEqual(sessionLine('complete'), { dot: 'idle', word: 'complete' })
  assert.deepEqual(sessionLine('idle'), { dot: 'idle', word: 'idle' })
  assert.deepEqual(sessionLine('exited'), { dot: 'exited', word: 'exited' })
})

test('gitWords: the git marks, spelled out', () => {
  assert.equal(gitWords({}), '')
  assert.equal(gitWords({ dirty: true }), 'Uncommitted changes')
  assert.equal(gitWords({ ahead: 2, behind: 1, dirty: true }), 'Uncommitted changes · 2 ahead · 1 behind')
  assert.equal(gitWords({ behind: 58 }), '58 behind')
})

test('cardAnchor: the card hangs from the row top, or stands on its bottom in the lower part of the window', () => {
  assert.deepEqual(cardAnchor({ top: 100, bottom: 150, right: 300 }, 900), { left: 308, top: 100 })
  assert.deepEqual(cardAnchor({ top: 700, bottom: 750, right: 300 }, 900), { left: 308, bottom: 150 })
  // Never above the window's top edge
  assert.deepEqual(cardAnchor({ top: -20, bottom: 30, right: 300 }, 900), { left: 308, top: 8 })
})

test('parseSidebarView: the default for nothing stored, junk, or the wrong shape', () => {
  for (const raw of [null, undefined, '', 'nope', '42', 'null', '[]']) {
    assert.deepEqual(parseSidebarView(raw), { sort: 'manual', compact: false, hideUnloaded: false })
  }
})

test('parseSidebarView: reads each choice and ignores values it does not know', () => {
  assert.deepEqual(parseSidebarView('{"sort":"attention","compact":true,"hideUnloaded":true}'), { sort: 'attention', compact: true, hideUnloaded: true })
  assert.deepEqual(parseSidebarView('{"sort":"alphabetical"}'), { sort: 'alphabetical', compact: false, hideUnloaded: false })
  assert.deepEqual(parseSidebarView('{"sort":"recent","compact":"yes"}'), { sort: 'manual', compact: false, hideUnloaded: false })
})

test('sidebarViewChanged: only a non-default choice counts', () => {
  assert.equal(sidebarViewChanged(DEFAULT_SIDEBAR_VIEW), false)
  assert.equal(sidebarViewChanged({ ...DEFAULT_SIDEBAR_VIEW, compact: true }), true)
  assert.equal(sidebarViewChanged({ ...DEFAULT_SIDEBAR_VIEW, sort: 'attention' }), true)
})

test('compareLabels: A to Z ignoring case, numbers in number order', () => {
  const labels = ['main', 'feature/fix-10', 'Feature/fix-2', 'bugfix/a']
  assert.deepEqual([...labels].sort(compareLabels), ['bugfix/a', 'Feature/fix-2', 'feature/fix-10', 'main'])
})

test('isUnloaded: no session, or only saved ones', () => {
  assert.deepEqual(['none', 'dormant', 'idle', 'running', 'attention', 'done', 'exited'].map(isUnloaded), [true, true, false, false, false, false, false])
})

test('attentionGroup: waiting, finished, a decision or a notice needs you; a running agent is working', () => {
  assert.equal(attentionGroup('attention', undefined), 'needs')
  assert.equal(attentionGroup('done', undefined), 'needs')
  assert.equal(attentionGroup('idle', 'decision'), 'needs')
  assert.equal(attentionGroup('running', 'notice'), 'needs')
  assert.equal(attentionGroup('running', undefined), 'working')
  assert.equal(attentionGroup('idle', undefined), 'quiet')
  assert.equal(attentionGroup('none', 'missing'), 'quiet')
})

test('groupByAttention: groups in order, rows keep their own order, empty groups are left out', () => {
  const rows = [{ id: 'a', g: 'quiet' }, { id: 'b', g: 'needs' }, { id: 'c', g: 'quiet' }, { id: 'd', g: 'needs' }]
  assert.deepEqual(
    groupByAttention(rows, (r) => r.g).map((g) => [g.group, g.rows.map((r) => r.id)]),
    [['needs', ['b', 'd']], ['quiet', ['a', 'c']]]
  )
  assert.deepEqual(groupByAttention([], () => 'quiet'), [])
})

test('rowMatchesQuery: an empty query matches every row', () => {
  assert.equal(rowMatchesQuery('', ['feature/x']), true)
})

test('rowMatchesQuery: matches any field, ignoring case, and skips missing ones', () => {
  assert.equal(rowMatchesQuery('feat', ['Feature/x', undefined]), true)
  assert.equal(rowMatchesQuery('nope', ['feature/x', undefined]), false)
})

test('rowMatchesQuery: a PR number or ticket key finds the row through its chips', () => {
  const fields = ['fix/login', '#9166', 'https://github.com/o/r/pull/9166', 'ENG-412', 'Login button is broken']
  assert.equal(rowMatchesQuery('9166', fields), true)
  assert.equal(rowMatchesQuery('#9166', fields), true)
  assert.equal(rowMatchesQuery('eng-412', fields), true)
  assert.equal(rowMatchesQuery('button', fields), true)
})
