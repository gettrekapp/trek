// scripts/attentionMenu.test.mjs — the notifications menu: main's attention feed and what it lists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAttentionFeed } from '../src/renderer/src/v2/attentionFeed.ts'
import { menuEntries, serverSource, statusText } from '../src/renderer/src/notificationItems.ts'

const tick = () => new Promise((r) => setImmediate(r))
const item = (sessionId, more = {}) => ({
  key: JSON.stringify(['box', 'p1', sessionId]),
  serverEntryId: 'box',
  serverName: 'Build box',
  projectId: 'p1',
  projectName: 'Demo',
  worktreeId: 'w1',
  sessionId,
  title: 'Claude',
  status: 'attention',
  since: 100,
  ...more
})

function fakeApi() {
  let answer
  let fail
  let broadcast = null
  let reads = 0
  return {
    api: {
      list: () => {
        reads++
        return new Promise((resolve, reject) => {
          answer = resolve
          fail = reject
        })
      },
      onChanged: (cb) => {
        broadcast = cb
        return () => (broadcast = null)
      }
    },
    answer: (s) => answer(s),
    fail: (err) => fail(err),
    broadcast: (s) => broadcast(s),
    reads: () => reads
  }
}

test('the feed reads once on the first subscriber and keeps the highest seq', async () => {
  const fake = fakeApi()
  const feed = createAttentionFeed(fake.api)
  assert.deepEqual(feed.get(), [])
  let heard = 0
  feed.subscribe(() => heard++)
  feed.subscribe(() => heard++)
  assert.equal(fake.reads(), 1)
  fake.broadcast({ seq: 5, items: [item('new')] })
  fake.answer({ seq: 4, items: [item('old')] })
  await tick()
  assert.deepEqual(feed.get().map((i) => i.sessionId), ['new'], 'a read older than a broadcast is dropped')
  const same = feed.get()
  fake.broadcast({ seq: 5, items: [] })
  assert.equal(feed.get(), same, 'the same seq again changes nothing')
  assert.equal(heard, 2)
})

test('a failed first read lists nothing until a broadcast', async () => {
  const fake = fakeApi()
  const feed = createAttentionFeed(fake.api)
  const warn = console.warn
  console.warn = () => {}
  try {
    feed.subscribe(() => {})
    fake.fail(new Error('boom'))
    await tick()
  } finally {
    console.warn = warn
  }
  assert.deepEqual(feed.get(), [])
  fake.broadcast({ seq: 1, items: [item('s1')] })
  assert.equal(feed.get().length, 1)
})

test("a file window lists its own decisions and every server's entries, newest first", () => {
  const local = [{ terminalId: 't1', question: 'Local?', requestedAt: 150 }]
  const entries = menuEntries(local, null, [item('s1', { since: 100 }), item('s2', { status: 'idle', since: 300, question: 'Ship?', askedAt: 300 })], (id) => `main · ${id}`)
  assert.deepEqual(entries, [
    { kind: 'server', id: item('s2').key, source: 'Demo · Build box · Claude', text: 'Ship?', at: 300, decision: true, stale: false },
    { kind: 'local', id: 't1', source: 'main · t1', text: 'Local?', at: 150 },
    { kind: 'server', id: item('s1').key, source: 'Demo · Build box · Claude', text: 'Needs your attention', at: 100, decision: false, stale: false }
  ])
})

test("a server window's own decision shows once: main's entry stands for it, the local one stays while main has none", () => {
  const here = { serverEntryId: 'box', projectId: 'p1' }
  const local = [{ terminalId: 's1', question: 'Ship?', requestedAt: 300 }]
  assert.deepEqual(menuEntries(local, here, [], () => 'tab').map((e) => e.kind), ['local'], 'before main lists it')
  const asked = item('s1', { status: 'idle', since: 300, question: 'Ship?', askedAt: 300 })
  assert.deepEqual(menuEntries(local, here, [asked], () => 'tab').map((e) => e.kind), ['server'])
  assert.deepEqual(menuEntries(local, { serverEntryId: 'box', projectId: 'p2' }, [asked], () => 'tab').map((e) => e.kind), ['local', 'server'], 'another project of the server keeps both')
})

test('labels: Global, no project name, stale, and the status texts', () => {
  assert.equal(serverSource(item('s', { worktreeId: null })), 'Demo · Build box · Global · Claude')
  assert.equal(serverSource(item('s', { projectName: '' })), 'Build box · Claude')
  assert.equal(menuEntries([], null, [item('s', { stale: true })], () => '')[0].stale, true)
  assert.deepEqual(['attention', 'done', 'idle'].map(statusText), ['Needs your attention', 'Finished', 'idle'])
})
