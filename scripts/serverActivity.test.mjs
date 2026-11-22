// scripts/serverActivity.test.mjs — core's activity feed (campsite part 2) and the plugin host's onActivity/emitAll.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createActivityFeed } from '../server/src/activity.ts'

const ev = (n) => ({ kind: 'session.closed', projectId: 'p', at: n, terminalId: 't', worktreeId: null })

test('the feed calls every listener in order, and unsubscribe stops one', () => {
  const feed = createActivityFeed()
  const a = []
  const b = []
  feed.subscribe((e) => a.push(e.at))
  const off = feed.subscribe((e) => b.push(e.at))
  feed.emit(ev(1))
  off()
  feed.emit(ev(2))
  assert.deepEqual(a, [1, 2])
  assert.deepEqual(b, [1])
})

test('a throwing listener is logged and skipped; the others still run', () => {
  const warnings = []
  const feed = createActivityFeed({ warn: (m) => warnings.push(m), now: () => 0 })
  const seen = []
  feed.subscribe(() => { throw new Error('boom') })
  feed.subscribe((e) => seen.push(e.at))
  feed.emit(ev(1))
  feed.emit(ev(2))
  assert.deepEqual(seen, [1, 2])
  // Logged once a minute per listener, not on every event
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /boom/)
})
