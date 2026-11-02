import test from 'node:test'
import assert from 'node:assert/strict'
import { dueDuties, parseDuties } from '../src/host/bot/duties.ts'
import { describeChanges } from '../src/host/bot/changeCheck.ts'

const HOUR = 3_600_000

test('parses scheduled and plain duties', () => {
  const duties = parseDuties('# Duties\n- Plain one\n* [every 2h] Check CI\n- [every 30m] Quick\n- [every 1d] Daily\ntext')
  assert.deepEqual(duties, [
    { text: 'Plain one', everyMs: null },
    { text: 'Check CI', everyMs: 2 * HOUR },
    { text: 'Quick', everyMs: HOUR / 2 },
    { text: 'Daily', everyMs: 24 * HOUR }
  ])
})

test('a scheduled duty is due when new or after its interval', () => {
  const duties = parseDuties('- [every 2h] A\n- [every 2h] B\n- Plain')
  const now = 10 * HOUR
  assert.deepEqual(dueDuties(duties, { A: now - HOUR }, now), ['B'])
  assert.deepEqual(dueDuties(duties, { A: now - 2 * HOUR, B: now }, now), ['A'])
})

const snap = (over = {}) => ({
  worktrees: [{ path: '/a', branch: 'm', head: 'h1' }],
  sessions: [{ id: 's', worktreeId: 'w', title: 'T', status: 'working', decision: false }],
  heartbeat: '- duty',
  ...over
})
const withStatus = (status, decision = false) =>
  snap({ sessions: [{ id: 's', worktreeId: 'w', title: 'T', status, decision }] })

test('no previous snapshot counts as a change', () => {
  assert.equal(describeChanges(null, snap()).length, 1)
})

test('identical snapshots have no changes', () => {
  assert.deepEqual(describeChanges(snap(), snap()), [])
})

test('flapping within busy or settled states is not a change', () => {
  assert.deepEqual(describeChanges(withStatus('starting'), withStatus('working')), [])
  assert.deepEqual(describeChanges(withStatus('idle'), withStatus('done')), [])
  assert.deepEqual(describeChanges(withStatus('done'), withStatus('complete')), [])
})

test('reports status, decision, HEAD, worktree and heartbeat changes', () => {
  assert.match(describeChanges(withStatus('working'), withStatus('done'))[0], /T.*working.*done/)
  assert.match(describeChanges(withStatus('working'), withStatus('attention'))[0], /attention/)
  assert.match(describeChanges(withStatus('done'), withStatus('done', true))[0], /decision/)
  assert.match(describeChanges(snap(), snap({ worktrees: [{ path: '/a', branch: 'm', head: 'h2' }] }))[0], /\/a.*h2/)
  assert.match(describeChanges(snap(), snap({ worktrees: [] }))[0], /removed.*\/a/)
  assert.match(describeChanges(snap({ worktrees: [] }), snap())[0], /new.*\/a/)
  assert.match(describeChanges(snap(), snap({ heartbeat: '- other' }))[0], /HEARTBEAT/)
  assert.match(describeChanges(snap(), snap({ sessions: [] }))[0], /ended/)
  assert.match(describeChanges(snap({ sessions: [] }), snap())[0], /started/)
})
