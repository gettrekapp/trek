// scripts/mainAttention.test.mjs — main's attention aggregator: the merged list and notify-once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { attentionKey, createAttention, newMoment } from '../src/main/attention.ts'

const SECRET = 'tok-S3CRET-never-in-an-item'

/** A RegisteredServer as the aggregator sees it: a status and an attention subscription, driven by hand. */
function fakeSource(status = 'connected') {
  const statusListeners = new Set()
  const listeners = new Set()
  const source = {
    // Never read by the aggregator; here to prove it never reaches an item.
    entry: { token: SECRET, url: 'ws://secret-host:1' },
    connection: {
      status,
      on: (_kind, l) => {
        statusListeners.add(l)
        return () => statusListeners.delete(l)
      }
    },
    mirror: {
      subscribe: (topic, l) => {
        assert.equal(topic, 'attention')
        listeners.add(l)
        return () => listeners.delete(l)
      }
    }
  }
  return {
    source,
    listeners,
    statusListeners,
    snapshot: (entries) => [...listeners].forEach((l) => l({ snapshot: { entries }, rev: 1 })),
    payload: (snapshot) => [...listeners].forEach((l) => l({ snapshot, rev: 1 })),
    error: (code) => [...listeners].forEach((l) => l({ error: { code, message: code } })),
    setStatus: (s) => {
      source.connection.status = s
      ;[...statusListeners].forEach((l) => l({ status: s }))
    }
  }
}

function setup(names = { box: 'Box', lab: 'Lab' }) {
  const changes = []
  const raised = []
  const attention = createAttention({
    serverName: (id) => names[id] ?? '',
    changed: (s) => changes.push(s),
    raised: (events) => raised.push(...events)
  })
  return { attention, changes, raised, names, last: () => changes.at(-1) }
}

const entry = (sessionId, more = {}) => ({
  projectId: 'p1',
  projectName: 'Demo',
  worktreeId: 'w1',
  sessionId,
  title: `Tab ${sessionId}`,
  status: 'attention',
  since: 100,
  ...more
})

test('the first snapshot after linking is the baseline: listed, never raised', () => {
  const { attention, raised, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1'), entry('s2', { status: 'idle', since: 300, decision: { question: 'Ship it?', at: 300 } })])
  assert.deepEqual(raised, [])
  assert.deepEqual(last().items, [
    {
      key: attentionKey('box', 'p1', 's2'),
      serverEntryId: 'box',
      serverName: 'Box',
      projectId: 'p1',
      projectName: 'Demo',
      worktreeId: 'w1',
      sessionId: 's2',
      title: 'Tab s2',
      status: 'idle',
      since: 300,
      question: 'Ship it?',
      askedAt: 300
    },
    {
      key: attentionKey('box', 'p1', 's1'),
      serverEntryId: 'box',
      serverName: 'Box',
      projectId: 'p1',
      projectName: 'Demo',
      worktreeId: 'w1',
      sessionId: 's1',
      title: 'Tab s1',
      status: 'attention',
      since: 100
    }
  ])
})

test('a new decision is raised once; the same snapshot again (a resubscribe) raises nothing', () => {
  const { attention, raised } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([])
  const asked = entry('s1', { status: 'working', since: 500, decision: { question: 'Ship it?', at: 500 }, audioAlerts: true })
  box.snapshot([asked])
  box.snapshot([asked])
  box.snapshot([{ ...asked }])
  assert.deepEqual(raised.map((e) => [e.kind, e.item.sessionId, e.item.question, e.audioAlerts]), [['decision', 's1', 'Ship it?', true]])
})

test('what came up while the link was down is raised after the reconnect; what was seen is not', () => {
  const { attention, raised } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('old')])
  box.setStatus('disconnected')
  box.setStatus('connected')
  box.snapshot([entry('old'), entry('new', { status: 'done', since: 900 })])
  assert.deepEqual(raised.map((e) => [e.kind, e.item.sessionId]), [['done', 'new']])
})

test('a new since (attention again after working) or a newer decision raises again', () => {
  const { attention, raised } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([])
  box.snapshot([entry('s1', { since: 100 })])
  box.snapshot([])
  box.snapshot([entry('s1', { since: 200 })])
  box.snapshot([entry('s1', { since: 200, decision: { question: 'A?', at: 300 } })])
  box.snapshot([entry('s1', { since: 200, decision: { question: 'B?', at: 400 } })])
  assert.deepEqual(raised.map((e) => [e.kind, e.item.since, e.item.question]), [
    ['attention', 100, undefined],
    ['attention', 200, undefined],
    ['decision', 200, 'A?'],
    ['decision', 200, 'B?']
  ])
})

test('a decision and attention new at once raise one event, the decision', () => {
  const { attention, raised } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([])
  box.snapshot([entry('s1', { since: 100, decision: { question: 'Q?', at: 100 } })])
  assert.deepEqual(raised.map((e) => e.kind), ['decision'])
  assert.equal(newMoment(entry('s', { status: 'idle' }), undefined), null, 'an idle entry with no decision is nothing new')
})

test('unlinking drops the server and its items; linking again (a new URL) is a new baseline', () => {
  const { attention, raised, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  attention.unlinked('box')
  assert.deepEqual(last().items, [])
  assert.equal(box.listeners.size, 0, 'unsubscribed')
  const again = fakeSource()
  attention.linked('box', again.source)
  again.snapshot([entry('s1'), entry('s2', { since: 999 })])
  assert.deepEqual(raised, [], 'the new link starts from a baseline')
  assert.deepEqual(last().items.map((i) => i.sessionId), ['s2', 's1'])
})

test('a topic error or a dropped connection keeps the items, marked stale, until the next snapshot', () => {
  const { attention, changes, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  box.error('INTERNAL')
  assert.equal(last().items[0].stale, true)
  const count = changes.length
  box.error('INTERNAL')
  assert.equal(changes.length, count, 'a second error changes nothing')
  box.snapshot([entry('s1')])
  assert.equal(Object.hasOwn(last().items[0], 'stale'), false)
  box.setStatus('disconnected')
  assert.equal(last().items[0].stale, true)
  const down = changes.length
  box.setStatus('connected')
  assert.equal(changes.length, down, 'coming back broadcasts nothing: the items stay stale until fresh data')
  assert.equal(attention.snapshot().items[0].stale, true)
  box.snapshot([entry('s1')])
  assert.equal(Object.hasOwn(last().items[0], 'stale'), false)
  box.error('CLOSED')
  assert.equal(Object.hasOwn(last().items[0], 'stale'), false, 'CLOSED: unlinked follows')
})

test('the first snapshot after a topic error is raised and not stale', () => {
  const { attention, raised, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  box.error('INTERNAL')
  assert.equal(last().items[0].stale, true)
  box.snapshot([entry('s1'), entry('s2', { status: 'done', since: 700 })])
  assert.deepEqual(raised.map((e) => [e.kind, e.item.sessionId, Object.hasOwn(e.item, 'stale')]), [['done', 's2', false]])
  assert.deepEqual(last().items.map((i) => Object.hasOwn(i, 'stale')), [false, false])
})

test('TOPIC_ENDED clears the server\'s entries: the topic never comes back on that connection', () => {
  const { attention, changes, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  box.error('TOPIC_ENDED')
  assert.deepEqual(last().items, [])
  const count = changes.length
  box.setStatus('disconnected')
  box.error('TOPIC_ENDED')
  assert.equal(changes.length, count, 'nothing left to mark stale or clear')
})

test('an error before the first snapshot: the snapshot after it is still the baseline', () => {
  const { attention, changes, raised, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.error('INTERNAL')
  assert.equal(changes.length, 0, 'nothing listed, nothing to mark stale')
  box.snapshot([entry('s1')])
  assert.deepEqual(raised, [])
  assert.deepEqual(last().items.map((i) => [i.sessionId, Object.hasOwn(i, 'stale')]), [['s1', false]])
})

test('a payload without an entries list keeps the items, stale, and what was seen', () => {
  const { attention, raised, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  box.payload({ entries: 'nope' })
  assert.deepEqual(last().items.map((i) => [i.sessionId, i.stale]), [['s1', true]])
  box.payload(null)
  assert.deepEqual(attention.snapshot().items.map((i) => i.sessionId), ['s1'])
  box.snapshot([entry('s1')])
  assert.deepEqual(raised, [], 's1 was seen: nothing raised again')
  assert.equal(Object.hasOwn(last().items[0], 'stale'), false)
})

test('relabel after every server is unlinked broadcasts nothing', () => {
  const { attention, changes, names, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  attention.unlinked('box')
  assert.deepEqual(last().items, [])
  const count = changes.length
  names.box = 'Build box'
  attention.relabel()
  assert.equal(changes.length, count)
})

test('linking the same id twice with no unlinked between drops the first link', () => {
  const { attention, raised, last } = setup()
  const first = fakeSource()
  attention.linked('box', first.source)
  first.snapshot([entry('s1')])
  const second = fakeSource()
  attention.linked('box', second.source)
  assert.equal(first.listeners.size, 0, 'the first mirror is unsubscribed')
  assert.equal(first.statusListeners.size, 0, 'and its status listener is off')
  assert.deepEqual(last().items, [])
  second.snapshot([entry('s1'), entry('s2', { since: 999 })])
  assert.deepEqual(raised, [], 'the second link starts from a baseline')
  assert.deepEqual(last().items.map((i) => i.sessionId), ['s2', 's1'])
})

test('items from two servers merge newest first and stay apart by server; seq grows', () => {
  const { attention, changes, last } = setup()
  const box = fakeSource()
  const lab = fakeSource()
  attention.linked('box', box.source)
  attention.linked('lab', lab.source)
  box.snapshot([entry('s1', { since: 100 })])
  lab.snapshot([entry('s1', { since: 200, projectName: 'Other' })])
  assert.deepEqual(last().items.map((i) => [i.serverName, i.projectName, i.sessionId]), [['Lab', 'Other', 's1'], ['Box', 'Demo', 's1']])
  assert.notEqual(last().items[0].key, last().items[1].key)
  const seqs = changes.map((c) => c.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  assert.equal(new Set(seqs).size, seqs.length)
})

test('relabel broadcasts a renamed server, and nothing when nothing changed', () => {
  const { attention, changes, names, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  const count = changes.length
  attention.relabel()
  assert.equal(changes.length, count)
  names.box = 'Build box'
  attention.relabel()
  assert.equal(last().items[0].serverName, 'Build box')
})

test('malformed entries are skipped; a server older than 3d has no projectName', () => {
  const { attention, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  const { projectName: _, ...older } = entry('s1')
  box.snapshot([older, null, { projectId: 1 }, entry('s2', { decision: { question: 7, at: 1 } }), entry('s3', { worktreeId: null })])
  assert.deepEqual(last().items.map((i) => [i.sessionId, i.projectName, i.worktreeId]), [['s1', '', 'w1'], ['s3', 'Demo', null]])
})

test('no item carries the token, the URL or a field outside the allowed set', () => {
  const { attention, changes } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1', { token: SECRET, url: 'ws://secret-host:1', decision: { question: 'Q?', at: 1, extra: SECRET } })])
  const allowed = new Set(['key', 'serverEntryId', 'serverName', 'projectId', 'projectName', 'worktreeId', 'sessionId', 'title', 'status', 'since', 'question', 'askedAt', 'stale'])
  for (const c of changes) {
    assert.equal(JSON.stringify(c).includes(SECRET), false)
    assert.equal(JSON.stringify(c).includes('secret-host'), false)
    for (const i of c.items) for (const k of Object.keys(i)) assert.ok(allowed.has(k), k)
  }
})

test('find by key; close unsubscribes everything and stops broadcasts', () => {
  const { attention, changes } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  assert.equal(attention.find(attentionKey('box', 'p1', 's1'))?.sessionId, 's1')
  assert.equal(attention.find(attentionKey('box', 'p1', 'nope')), undefined)
  const count = changes.length
  attention.close()
  assert.equal(box.listeners.size, 0)
  assert.equal(changes.length, count)
  attention.linked('box', fakeSource().source)
  assert.equal(changes.length, count)
})
