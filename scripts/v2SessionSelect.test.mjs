// scripts/v2SessionSelect.test.mjs — main asking a server window to show a session, and what it reports in view.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sameIds, selectStep, sessionsInView, viewReporter } from '../src/renderer/src/v2/sessionSelect.ts'

const select = { projectId: 'p1', sessionId: 's1', worktreeId: 'w1' }
const view = (more = {}) => ({
  here: { serverEntryId: 'box', projectId: 'p1' },
  projected: true,
  terminals: { s1: { worktreeId: 'r1:w1' } },
  legacyByWorktree: { w1: 'r1:w1' },
  ...more
})

test('a select waits while the window boots, then reveals the tab', () => {
  assert.deepEqual(selectStep(select, view({ here: null })), { wait: true }, 'serverWindow not set yet')
  assert.deepEqual(selectStep(select, view({ projected: false })), { wait: true }, 'no snapshot yet')
  assert.deepEqual(selectStep(select, view({ terminals: {}, legacyByWorktree: {} })), { wait: true }, 'the session is not in yet')
  assert.deepEqual(selectStep(select, view()), { reveal: 's1' })
})

test('a session with no tab selects its worktree; another project drops the select', () => {
  assert.deepEqual(selectStep(select, view({ terminals: {} })), { worktree: 'r1:w1' })
  assert.deepEqual(selectStep({ ...select, worktreeId: null }, view({ terminals: {} })), { wait: true }, 'a Global session waits for its tab')
  assert.deepEqual(selectStep(select, view({ here: { serverEntryId: 'box', projectId: 'p2' } })), { drop: true })
})

const state = (more = {}) => ({
  serverWindow: { serverEntryId: 'box', projectId: 'p1' },
  terminals: { s1: { worktreeId: 'r1:w1' }, g1: { worktreeId: '__global__' } },
  activeTerminal: { 'r1:w1': 's1', __global__: 'g1' },
  activeWorktreeId: 'r1:w1',
  globalPanelOpen: false,
  globalView: 'sessions',
  ...more
})

test("in view: the selected worktree's tab, and the open Global panel's", () => {
  assert.deepEqual(sessionsInView(state()), ['s1'])
  assert.deepEqual(sessionsInView(state({ globalPanelOpen: true })), ['s1', 'g1'])
  assert.deepEqual(sessionsInView(state({ globalPanelOpen: true, globalView: 'bot' })), ['s1'])
  assert.deepEqual(sessionsInView(state({ activeWorktreeId: null })), [])
  assert.deepEqual(sessionsInView(state({ serverWindow: null, globalPanelOpen: true })), [], 'a file window reports none')
  assert.equal(sameIds(['a', 'b'], ['a', 'b']), true)
  assert.equal(sameIds(['a'], ['a', 'b']), false)
})

test('the view is reported the first time, even empty, then only when it changes', () => {
  const sent = []
  const report = viewReporter((ids) => sent.push(ids))
  report([])
  report([])
  report(['s1'])
  report(['s1'])
  report([])
  assert.deepEqual(sent, [[], ['s1'], []], 'a reloaded window clears what main kept from before')
})
