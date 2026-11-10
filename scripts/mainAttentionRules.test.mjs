// scripts/mainAttentionRules.test.mjs — when main notifies, what it says, the sound, and what a dismiss asks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { attentionPlace } from '../src/shared/attentionPlace.ts'
import { serverSource } from '../src/renderer/src/notificationItems.ts'
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

test("the notification's place and the menu's source share one helper", () => {
  for (const i of [item(), item({ worktreeId: null }), item({ projectName: '' }), item({ projectName: '', worktreeId: null })]) {
    assert.equal(placeOf(i), attentionPlace(i))
    assert.equal(serverSource(i), `${attentionPlace(i)} · ${i.title}`)
  }
  assert.equal(attentionPlace(item({ projectName: '', worktreeId: null })), 'Build box · Global')
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

test('the app-wide "Show notifications" switch off: nothing is notified, focus or not', () => {
  const off = { showNotifications: false }
  for (const kind of ['decision', 'attention', 'done']) {
    assert.equal(shouldNotify(kind, item(), null, off), false, `${kind}: no window focused`)
    assert.equal(shouldNotify(kind, item(), { target: null, viewing: [] }, off), false, `${kind}: a file window focused`)
    assert.equal(shouldNotify(kind, item(), null, { showNotifications: true }), true, `${kind}: on`)
  }
  assert.equal(wantsAlert([{ audioAlerts: true }]), true, 'the sound does not follow the switch')
})

test('a pull request notice (5c-1): "PR #12 changed" with what changed; a dismiss clears the notice', () => {
  const notice = item({ sessionId: '', title: 'PR #12', pullRequest: 'Merged — no agent session to send it to' })
  assert.deepEqual(notificationText('pullRequest', notice), { title: 'PR #12 changed', body: 'Demo · Build box\nMerged — no agent session to send it to' })
  const unreadable = item({ sessionId: '', title: 'PR #12', pullRequest: 'Can’t be read: HTTP 404: Not Found' })
  assert.deepEqual(notificationText('pullRequest', unreadable), { title: 'PR #12 can’t be read', body: 'Demo · Build box\nHTTP 404: Not Found' })
  assert.deepEqual(dismissRequest(notice), { method: 'prWatch.dismiss', params: { projectId: 'p1', worktreeId: 'w1' } })
  // No session in view can stand for it: notified even in its own focused window.
  assert.equal(shouldNotify('pullRequest', notice, { target: here, viewing: ['s1'] }), true)
})
