// scripts/mainAttentionRules.test.mjs — when main notifies, what it says, the sound, and what a dismiss asks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dismissRequest, notificationText, placeOf, shouldNotify, wantsAlert } from '../src/main/attentionRules.ts'

const item = (more = {}) => ({
  key: 'k',
  serverEntryId: 'box',
  serverName: 'Build box',
  projectId: 'p1',
  projectName: 'Demo',
  worktreeId: 'w1',
  sessionId: 's1',
  title: 'Claude',
  status: 'attention',
  since: 1,
  ...more
})
const here = { serverEntryId: 'box', projectId: 'p1' }

test('notified unless its own window has focus with the session in view; done unless that window has focus', () => {
  for (const kind of ['decision', 'attention', 'done']) {
    assert.equal(shouldNotify(kind, item(), null), true, `${kind}: no window focused`)
    assert.equal(shouldNotify(kind, item(), { target: null, viewing: [] }), true, `${kind}: a file window focused`)
    assert.equal(shouldNotify(kind, item(), { target: { serverEntryId: 'box', projectId: 'p2' }, viewing: ['s1'] }), true, `${kind}: another project`)
    assert.equal(shouldNotify(kind, item(), { target: { serverEntryId: 'lab', projectId: 'p1' }, viewing: ['s1'] }), true, `${kind}: another server`)
  }
  assert.equal(shouldNotify('decision', item(), { target: here, viewing: ['s1'] }), false)
  assert.equal(shouldNotify('attention', item(), { target: here, viewing: ['s1'] }), false)
  assert.equal(shouldNotify('decision', item(), { target: here, viewing: ['s2'] }), true)
  assert.equal(shouldNotify('attention', item(), { target: here, viewing: [] }), true)
  assert.equal(shouldNotify('done', item(), { target: here, viewing: ['s2'] }), false)
  assert.equal(shouldNotify('decision', item(), { target: here, viewing: ['s2', 's1'] }), false, 'a worktree tab and a Global tab in view at once')
})

test('the texts follow the legacy window, with the project and server as the place', () => {
  assert.deepEqual(notificationText('decision', item({ question: 'Ship it?' })), { title: 'Claude needs a decision', body: 'Demo · Build box\nShip it?' })
  assert.deepEqual(notificationText('attention', item()), { title: 'Claude needs your attention', body: 'Demo · Build box' })
  assert.deepEqual(notificationText('done', item({ status: 'done' })), { title: 'Claude finished', body: 'Demo · Build box' })
  assert.equal(placeOf(item({ worktreeId: null })), 'Demo · Build box · Global')
  assert.equal(placeOf(item({ projectName: '' })), 'Build box')
})

test('one sound for a batch, if any of its projects has audio alerts on', () => {
  assert.equal(wantsAlert([]), false)
  assert.equal(wantsAlert([{ audioAlerts: false }, { audioAlerts: false }]), false)
  assert.equal(wantsAlert([{ audioAlerts: false }, { audioAlerts: true }]), true)
})

test('a dismiss clears the decision if there is one, else marks the session seen', () => {
  assert.deepEqual(dismissRequest(item({ question: 'Q?', askedAt: 2 })), { method: 'session.dismissDecision', params: { projectId: 'p1', sessionId: 's1' } })
  assert.deepEqual(dismissRequest(item({ status: 'done' })), { method: 'session.seen', params: { projectId: 'p1', sessionId: 's1' } })
})
