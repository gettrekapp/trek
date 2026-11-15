// scripts/v2UiSelection.test.mjs — what a server window tells the server it shows (`ui.report`), and when it sends it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { selectionOf, selectionReporter } from '../src/renderer/src/v2/uiSelection.ts'

const PRIMARY = '__primary__:r1'
const GLOBAL = '__global__'
const ids = (more = {}) => ({
  worktrees: { [PRIMARY]: { repoId: 'r1', worktreeId: 'wm' }, w2: { repoId: 'r1', worktreeId: 'w2' } },
  worktreeByPath: { '/r': PRIMARY, '/r-feat': 'w2' },
  sessions: {
    s1: { sessionId: 's1', repoId: 'r1', worktreeId: 'w2', ptyId: null },
    sm: { sessionId: 'sm', repoId: 'r1', worktreeId: 'wm', ptyId: null },
    g1: { sessionId: 'g1', repoId: null, worktreeId: null, ptyId: null },
    a1: { sessionId: 'a1', repoId: null, worktreeId: null, ptyId: null }
  },
  legacyByWorktree: { wm: PRIMARY, w2: 'w2' },
  ...more
})
const state = (more = {}) => ({
  activeWorktreeId: 'w2',
  selected: { path: '/r-feat' },
  projectPage: null,
  terminals: {
    s1: { worktreeId: 'w2' },
    sm: { worktreeId: PRIMARY },
    g1: { worktreeId: GLOBAL },
    a1: { worktreeId: GLOBAL, context: { kind: 'automation', automationId: 'auto1' } }
  },
  activeTerminal: { w2: 's1', [PRIMARY]: 'sm' },
  globalPanelOpen: false,
  globalView: 'sessions',
  ...more
})

test('a linked worktree with an active tab', () => {
  assert.deepEqual(selectionOf(state(), ids()), { worktreeId: 'w2', sessionId: 's1' })
})

test('the main checkout: its legacy id maps to its v2 id', () => {
  assert.deepEqual(selectionOf(state({ activeWorktreeId: PRIMARY, selected: { path: '/r' } }), ids()), { worktreeId: 'wm', sessionId: 'sm' })
})

test('a worktree with no tab reports the worktree alone; one selected by path only is found by its path', () => {
  assert.deepEqual(selectionOf(state({ activeTerminal: {} }), ids()), { worktreeId: 'w2', sessionId: null })
  assert.deepEqual(selectionOf(state({ activeWorktreeId: null }), ids()), { worktreeId: 'w2', sessionId: 's1' })
  // A stale active tab: another worktree's terminal is not this one's tab.
  assert.deepEqual(selectionOf(state({ activeTerminal: { w2: 'sm' } }), ids()), { worktreeId: 'w2', sessionId: null })
})

test('no selection, no id map, and a worktree the id map does not know', () => {
  const none = { worktreeId: null, sessionId: null }
  assert.deepEqual(selectionOf(state({ activeWorktreeId: null, selected: null }), ids()), none)
  assert.deepEqual(selectionOf(state(), null), none)
  assert.deepEqual(selectionOf(state({ activeWorktreeId: 'gone', selected: { path: '/gone' }, activeTerminal: { gone: 's1' } }), ids()), none)
})

test('a project page hides the worktree', () => {
  assert.deepEqual(selectionOf(state({ projectPage: 'settings' }), ids()), { worktreeId: null, sessionId: null })
})

test('the Global panel open with a tab reports that tab and no worktree; open with none, the worktree', () => {
  const open = { globalPanelOpen: true }
  assert.deepEqual(selectionOf(state({ ...open, activeTerminal: { w2: 's1', [GLOBAL]: 'g1' } }), ids()), { worktreeId: null, sessionId: 'g1' })
  assert.deepEqual(selectionOf(state(open), ids()), { worktreeId: 'w2', sessionId: 's1' })
  // Over a project page too: it is the session the user types in.
  assert.deepEqual(selectionOf(state({ ...open, projectPage: 'notes', activeTerminal: { [GLOBAL]: 'g1' } }), ids()), { worktreeId: null, sessionId: 'g1' })
  // Closed, its active tab is not shown.
  assert.deepEqual(selectionOf(state({ activeTerminal: { w2: 's1', [GLOBAL]: 'g1' } }), ids()), { worktreeId: 'w2', sessionId: 's1' })
})

test('the Global panel shows a tab only in the view it belongs to, and none in the bot view', () => {
  const open = { globalPanelOpen: true, activeTerminal: { w2: 's1', [GLOBAL]: 'a1' } }
  assert.deepEqual(selectionOf(state({ ...open, globalView: 'automations' }), ids()), { worktreeId: null, sessionId: 'a1' })
  assert.deepEqual(selectionOf(state({ ...open, globalView: 'sessions' }), ids()), { worktreeId: 'w2', sessionId: 's1' })
  assert.deepEqual(selectionOf(state({ ...open, globalView: 'bot', activeTerminal: { w2: 's1', [GLOBAL]: 'g1' } }), ids()), { worktreeId: 'w2', sessionId: 's1' })
})

test('an active terminal the id map does not know (pending, local only) is not reported', () => {
  const terminals = { ...state().terminals, pending: { worktreeId: 'w2' }, gp: { worktreeId: GLOBAL } }
  assert.deepEqual(selectionOf(state({ terminals, activeTerminal: { w2: 'pending' } }), ids()), { worktreeId: 'w2', sessionId: null })
  assert.deepEqual(
    selectionOf(state({ terminals, globalPanelOpen: true, activeTerminal: { w2: 's1', [GLOBAL]: 'gp' } }), ids()),
    { worktreeId: 'w2', sessionId: 's1' },
    'an unknown Global tab leaves the worktree selection'
  )
})

test('the reporter sends the first selection, skips a repeat, sends a change, and repeats when forced', () => {
  const sent = []
  const reporter = selectionReporter((selection) => sent.push(selection))
  const a = { worktreeId: 'w2', sessionId: 's1' }
  reporter.report(a)
  reporter.report({ ...a })
  assert.deepEqual(sent, [a])
  reporter.report({ worktreeId: 'w2', sessionId: null })
  assert.deepEqual(sent, [a, { worktreeId: 'w2', sessionId: null }])
  reporter.report({ worktreeId: 'w2', sessionId: null }, true)
  assert.equal(sent.length, 3)
  reporter.report({ worktreeId: 'w2', sessionId: null })
  assert.equal(sent.length, 3, 'a forced send is remembered as the last sent')
})
