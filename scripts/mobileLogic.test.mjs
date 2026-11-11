// The phone app's pure modules (6a, apps/mobile/src/logic): the server-address rule, the
// attention list and its notifications, the key bar, the diff colouring, the terminal feed and
// the ref counts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkServerUrl, isPrivateHost } from '../apps/mobile/src/logic/serverUrl.ts'
import { ago, attentionKey, attentionText, mergeAttention, newItems, notificationContent, notificationRoute } from '../apps/mobile/src/logic/attention.ts'
import { KEY_BAR } from '../apps/mobile/src/logic/keys.ts'
import { classifyDiff } from '../apps/mobile/src/logic/diff.ts'
import { TerminalFeed, isTerminalReply, pageScript } from '../apps/mobile/src/logic/terminalFeed.ts'
import { RefCounts } from '../apps/mobile/src/logic/refCount.ts'

test('wss:// is always allowed; ws:// only to a private address, with a warning', () => {
  assert.deepEqual(checkServerUrl(' wss://dev.example.com '), { ok: true, url: 'wss://dev.example.com' })
  const lan = checkServerUrl('ws://192.168.1.20:7345')
  assert.equal(lan.ok, true)
  assert.match(lan.warning, /Not encrypted/)
  for (const url of ['ws://10.0.0.5', 'ws://172.20.1.1', 'ws://100.101.1.2', 'ws://studio.local:7345', 'ws://[fd7a:115c:a1e0::1]', 'ws://127.0.0.1']) {
    assert.equal(checkServerUrl(url).ok, true, url)
  }
  for (const url of ['ws://dev.example.com', 'ws://8.8.8.8', 'ws://172.32.0.1', 'ws://100.128.0.1', 'https://dev.example.com', 'dev.example.com', '']) {
    assert.equal(checkServerUrl(url).ok, false, url)
  }
  assert.equal(isPrivateHost('[::ffff:192.168.0.1]'), true)
  // URL writes that one in hex, which the rule doesn't read: refused, failing closed.
  assert.equal(checkServerUrl('ws://[::ffff:192.168.0.1]').ok, false)
})

test('attention: every server merged, newest first, with keys unique across servers', () => {
  const entry = (sessionId, since, extra = {}) => ({ projectId: 'p', worktreeId: 'w', sessionId, title: sessionId, status: 'attention', since, projectName: 'App', ...extra })
  const items = mergeAttention([
    { serverId: 'a', serverName: 'A', entries: [entry('s1', 10), entry('', 30, { pullRequest: { text: 'Checks failed', url: 'u' } })] },
    { serverId: 'b', serverName: 'B', entries: [entry('s1', 20, { decision: { question: 'Ship?', at: 20 } })] }
  ])
  assert.deepEqual(items.map((i) => [i.serverName, i.title, i.since]), [['A', '', 30], ['B', 's1', 20], ['A', 's1', 10]])
  assert.equal(new Set(items.map((i) => i.key)).size, 3)
  assert.deepEqual(items.map(attentionText), ['Checks failed', 'Decision: Ship?', 'Needs you'])
  assert.deepEqual(newItems(items, new Set([items[0].key])).map((i) => i.since), [20, 10])
  assert.equal(attentionText({ ...entry('s', 1), status: 'done' }), 'Finished')
})

test('ago', () => {
  assert.equal(ago(0, 5_000), 'just now')
  assert.equal(ago(0, 3 * 60_000), '3 min ago')
  assert.equal(ago(0, 2 * 3_600_000), '2 h ago')
  assert.equal(ago(0, 3 * 86_400_000), '3 d ago')
})

test('the key bar writes the terminal sequences', () => {
  const byName = Object.fromEntries(KEY_BAR.map((k) => [k.name, k.data]))
  assert.deepEqual(byName, { Enter: '\r', Escape: '\x1b', Tab: '\t', 'Control C': '\x03', Up: '\x1b[A', Down: '\x1b[B', Left: '\x1b[D', Right: '\x1b[C', y: 'y', n: 'n' })
})

test('a unified diff, classed line by line', () => {
  const patch = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n'
  assert.deepEqual(classifyDiff(patch).map((l) => l.kind), ['meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add'])
  assert.deepEqual(classifyDiff(''), [])
})

test("attention keys: an entry's key is the same in the merged list and in a later snapshot", () => {
  const entry = { projectId: 'p', worktreeId: 'w', sessionId: 's1', title: 'Fix', status: 'attention', since: 5, projectName: 'App' }
  const [item] = mergeAttention([{ serverId: 'a', serverName: 'A', entries: [entry] }])
  assert.equal(item.key, attentionKey('a', { ...entry }))
  assert.notEqual(attentionKey('a', entry), attentionKey('b', entry))
  assert.equal(attentionKey('a', { ...entry, sessionId: '' }), 'a/p/pr:w/5')
})

test("a notification never shows a decision's question, and routes to its session or worktree", () => {
  const base = { serverId: 'a', serverName: 'A', key: 'k', projectId: 'p', worktreeId: 'w', sessionId: 's1', title: 'Fix', status: 'attention', since: 5, projectName: 'App' }
  const decision = notificationContent({ ...base, decision: { question: 'Drop the users table?', at: 5 } })
  assert.equal(decision.title, 'App: Fix')
  assert.equal(decision.body, 'A decision is waiting in App')
  assert.doesNotMatch(JSON.stringify(decision), /users table/)
  assert.deepEqual(decision.data, { serverId: 'a', projectId: 'p', sessionId: 's1', worktreeId: 'w' })
  const pr = notificationContent({ ...base, sessionId: '', title: '', pullRequest: { text: 'Checks failed', url: 'u' } })
  assert.deepEqual([pr.title, pr.body, pr.data.sessionId], ['App', 'Checks failed', undefined])
  assert.equal(notificationContent({ ...base, status: 'done' }).body, 'Finished')

  assert.deepEqual(notificationRoute(decision.data), { pathname: '/session/[serverId]/[projectId]/[sessionId]', params: { serverId: 'a', projectId: 'p', sessionId: 's1' } })
  assert.deepEqual(notificationRoute(pr.data), { pathname: '/worktree/[serverId]/[projectId]/[worktreeId]', params: { serverId: 'a', projectId: 'p', worktreeId: 'w' } })
  for (const bad of [null, undefined, 'x', {}, { serverId: 'a' }, { serverId: 'a', projectId: 'p' }, { serverId: 'a', projectId: 'p', sessionId: 3 }, { serverId: '', projectId: 'p', sessionId: 's' }]) {
    assert.equal(notificationRoute(bad), null, JSON.stringify(bad))
  }
})

test('the terminal feed holds output until the pty size is known, then sends the size first', () => {
  const feed = new TerminalFeed()
  assert.deepEqual(feed.reset(), [{ type: 'reset' }])
  // The replay arrives before attach resolves: held.
  assert.deepEqual(feed.data('one '), [])
  assert.deepEqual(feed.data('two'), [])
  assert.deepEqual(feed.size(120, 40), [{ type: 'size', cols: 120, rows: 40 }, { type: 'data', data: 'one two' }])
  // Live output then goes straight through; a pty.resized is just the size.
  assert.deepEqual(feed.data('live'), [{ type: 'data', data: 'live' }])
  assert.deepEqual(feed.size(100, 30), [{ type: 'size', cols: 100, rows: 30 }])
  // A reconnect: reset clears what was held and holds again until the re-attach's size.
  assert.deepEqual(feed.reset(), [{ type: 'reset' }])
  assert.deepEqual(feed.data('replay'), [])
  assert.deepEqual(feed.reset(), [{ type: 'reset' }])
  assert.deepEqual(feed.data('again'), [])
  assert.deepEqual(feed.size(90, 20), [{ type: 'size', cols: 90, rows: 20 }, { type: 'data', data: 'again' }])
})

test("the page script applies a batch in order, in one call", () => {
  const seen = []
  const window = { __trek: (m) => seen.push(m) }
  const script = pageScript([{ type: 'size', cols: 3, rows: 2 }, { type: 'data', data: 'a\u2028"</script>' }])
  // eslint-disable-next-line no-new-func
  assert.equal(new Function('window', `return ${script.replace(/; true;$/, '')}`)(window), undefined)
  assert.deepEqual(seen, [{ type: 'size', cols: 3, rows: 2 }, { type: 'data', data: 'a\u2028"</script>' }])
  // Before the page is up, it does nothing.
  assert.doesNotThrow(() => new Function('window', script)({}))
})

test("xterm's own query replies are dropped; typing isn't", () => {
  for (const reply of ['\x1b[12;40R', '\x1b[?1;2c', '\x1b[?62;22c', '\x1b[?c', '\x1b[>0;276;0c']) assert.equal(isTerminalReply(reply), true, JSON.stringify(reply))
  for (const typed of ['a', '\r', '\x1b', '\x1b[A', '\x1b[1;5C', 'c', '12;40R', '\x1b[12;40Rx', '\x1b[200~paste\x1b[201~']) assert.equal(isTerminalReply(typed), false, JSON.stringify(typed))
})

test('ref counts: on for the first user, off after the last', () => {
  const counts = new RefCounts()
  assert.equal(counts.acquire('p'), true)
  assert.equal(counts.acquire('p'), false)
  assert.equal(counts.acquire('q'), true)
  assert.equal(counts.release('p'), false)
  assert.equal(counts.has('p'), true)
  assert.equal(counts.release('p'), true)
  assert.equal(counts.has('p'), false)
  assert.equal(counts.release('p'), false)
  assert.equal(counts.acquire('p'), true)
})
