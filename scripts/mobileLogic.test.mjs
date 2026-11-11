// The phone app's pure modules (6a, apps/mobile/src/logic): the server-address rule, the
// attention list, the key bar and the diff colouring.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkServerUrl, isPrivateHost } from '../apps/mobile/src/logic/serverUrl.ts'
import { ago, attentionText, mergeAttention, newItems } from '../apps/mobile/src/logic/attention.ts'
import { KEY_BAR } from '../apps/mobile/src/logic/keys.ts'
import { classifyDiff } from '../apps/mobile/src/logic/diff.ts'

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
