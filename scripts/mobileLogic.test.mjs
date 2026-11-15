// The phone app's pure modules (6a, apps/mobile/src/logic): the server-address rule, the
// attention list and its notifications, the key bar, the diff colouring, the terminal feed and
// the ref counts, the connection notices, the per-server generations, the held topic view and
// the value a promote request waits for, the quick buttons' list and built-in context, and the
// rules for adding and removing a worktree (pull request links, branch suggestions, the remove flow,
// and state/teardown.ts' check for what only the desktop can tear down first)
// and a ticket's label, link and input through the project's trackers, and what the worktree list
// says about a branch (its tag, custom tags, ticket and pull request on one line).
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkServerUrl, isPrivateHost } from '../apps/mobile/src/logic/serverUrl.ts'
import { ago, attentionKey, attentionText, mergeAttention, newItems, notificationContent, notificationRoute } from '../apps/mobile/src/logic/attention.ts'
import { KEY_BAR } from '../apps/mobile/src/logic/keys.ts'
import { classifyDiff } from '../apps/mobile/src/logic/diff.ts'
import { TerminalFeed, pageScript } from '../apps/mobile/src/logic/terminalFeed.ts'
import { connectionNotice, sessionPlaceholder } from '../apps/mobile/src/logic/connection.ts'
import { quickButtonContext, quickButtonsFor } from '../apps/mobile/src/logic/quickButtons.ts'
import { planQuickButton, resolveBuiltins } from '../src/shared/quickButtonTemplate.ts'
import { branchSuggestions, parsePullRequestUrl, prBranch, pullRequestLabel, refusedAsDirty, removeWorktree } from '../apps/mobile/src/logic/worktrees.ts'
import { activeTicketProviders, parseTicketInput, ticketView } from '../apps/mobile/src/logic/tickets.ts'
import { TEARDOWN_UNCHECKED, teardownBlocker } from '../apps/mobile/src/state/teardown.ts'
import { branchLine, repoFolder, worktreeOnBranch } from '../apps/mobile/src/logic/worktreeList.ts'
import { bumpGenerations } from '../apps/mobile/src/logic/generations.ts'
import { viewFor } from '../apps/mobile/src/logic/topicView.ts'
import { Latest } from '../apps/mobile/src/logic/latest.ts'
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

test('connection notices: none while connected; Connecting… before, Reconnecting… after a drop', () => {
  assert.equal(connectionNotice('connected'), null)
  assert.equal(connectionNotice(undefined), 'Connecting…')
  assert.equal(connectionNotice('connecting'), 'Connecting…')
  assert.equal(connectionNotice('disconnected'), 'Reconnecting…')
  assert.equal(connectionNotice('error'), 'Reconnecting…')
  assert.match(connectionNotice('needs-auth'), /pair this phone again/)
  assert.match(connectionNotice('no-token'), /pair this phone again/)
  assert.match(connectionNotice('incompatible'), /Update/)
  assert.equal(connectionNotice('closed'), 'Not connected.')
})

test("the session placeholder: a cold start's not-connected topic is Connecting…, not gone", () => {
  assert.equal(sessionPlaceholder({ hasSession: false, topic: 'error', status: undefined }), 'Connecting…')
  assert.equal(sessionPlaceholder({ hasSession: false, topic: 'error', status: 'connecting' }), 'Connecting…')
  assert.equal(sessionPlaceholder({ hasSession: false, topic: 'error', status: 'disconnected' }), 'Reconnecting…')
  assert.equal(sessionPlaceholder({ hasSession: false, topic: 'error', status: 'connected' }), 'This session is gone.')
  assert.equal(sessionPlaceholder({ hasSession: false, topic: 'ready', status: 'connected' }), 'This session is gone.')
  assert.equal(sessionPlaceholder({ hasSession: false, topic: 'loading', status: 'connecting' }), 'Loading…')
  assert.match(sessionPlaceholder({ hasSession: true, topic: 'ready', status: 'connected' }), /^Not running/)
})

test('generations are per server: bumping one leaves the others', () => {
  const a = bumpGenerations({}, ['s1'])
  assert.deepEqual(a, { s1: 1 })
  const b = bumpGenerations(a, ['s2', 's1'])
  assert.deepEqual(b, { s1: 2, s2: 1 })
  assert.equal(bumpGenerations(b, []), b)
  assert.deepEqual(a, { s1: 1 })
})

test('a held view shows only for its own key: another key is loading, never the old snapshot', () => {
  const held = { key: 's\nproject:a', view: { state: 'ready', snapshot: { id: 'a' } } }
  assert.equal(viewFor(held, 's\nproject:a'), held.view)
  assert.deepEqual(viewFor(held, 's\nproject:b'), { state: 'loading' })
  assert.deepEqual(viewFor(null, 's\nproject:a'), { state: 'loading' })
  assert.deepEqual(viewFor(held, null), { state: 'loading' })
})

test('Latest: waits for the first value; null once closed', async () => {
  const project = new Latest()
  const early = project.when()
  project.set(null)
  project.set({ id: 'p' })
  assert.deepEqual(await early, { id: 'p' })
  assert.deepEqual(await project.when(), { id: 'p' })
  const never = new Latest()
  const waiting = never.when()
  never.close()
  assert.equal(await waiting, null)
  assert.equal(await never.when(), null)
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

// ---- Background push (6b): apps/mobile/src/logic/push.ts ----
import {
  NO_PUSH_CONFIG,
  deviceAction,
  ensureDevice,
  isDeadDevice,
  keyedEpochs,
  keyedQueue,
  kindsEqual,
  needsGrant,
  pushRouteData,
  relayClient,
  relayKeyOf,
  relayUrlOf,
  routeTap,
  serverPaused,
  setGrantParams,
  syncPlan,
  withDevice,
  withTimeout
} from '../apps/mobile/src/logic/push.ts'
/** A fake relay: answers by `METHOD path`, recording each call */
const fakeRelay = (answers) => {
  const calls = []
  const fetch = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ url, path, ...init, json: init.body ? JSON.parse(init.body) : undefined })
    const a = answers[`${init.method} ${path.replace(/\/v1\/(devices|grants)\/[^/]+$/, '/v1/$1/:id')}`]
    const [status, body] = typeof a === 'function' ? a(calls.at(-1)) : (a ?? [404, { error: 'not found' }])
    return { status, json: async () => body }
  }
  return { fetch, calls }
}
const DEVICE = { relayUrl: 'https://r', deviceId: 'd1', deviceSecret: 'sec', platform: 'ios', pushToken: 'a' }

test('push: the build relay is https only; a registration key is a non-empty string', () => {
  assert.equal(relayUrlOf('https://relay.example/'), 'https://relay.example')
  assert.equal(relayUrlOf(' https://relay.example:8443/base/ '), 'https://relay.example:8443/base')
  for (const bad of ['', '  ', 'http://relay.example', 'http://192.168.1.5:7346', 'http://localhost:7346', 'https://u:p@relay.example', 'https://relay.example?x=1', 'https://relay.example#x', 'nope', 42, undefined])
    assert.equal(relayUrlOf(bad), null, String(bad))
  assert.equal(relayKeyOf(' k '), 'k')
  for (const none of ['', '  ', undefined, 3]) assert.equal(relayKeyOf(none), undefined)
  assert.match(NO_PUSH_CONFIG, /google-services\.json/)
})

test('push: register for no device or another relay or platform; otherwise send the current token', () => {
  assert.equal(deviceAction(null, 'https://r', 'ios'), 'register')
  assert.equal(deviceAction(DEVICE, 'https://r', 'ios'), 'update')
  assert.equal(deviceAction(DEVICE, 'https://other', 'ios'), 'register')
  assert.equal(deviceAction(DEVICE, 'https://r', 'android'), 'register')
})

test('push: each check sends the token (even unchanged) and the pause; a device the relay forgot (401) registers again', async () => {
  const relay = fakeRelay({
    'PUT /v1/devices/:id': (c) => [200, { updated: true, paused: c.json.paused === true }],
    'POST /v1/devices': [201, { deviceId: 'd2', deviceSecret: 'sec2' }]
  })
  const client = relayClient(relay.fetch)
  const same = await ensureDevice(client, DEVICE, 'https://r', 'ios', 'a', true)
  assert.deepEqual(same, { device: DEVICE, paused: true, registered: false })
  assert.deepEqual(relay.calls[0].json, { pushToken: 'a', paused: true })
  assert.equal(relay.calls[0].headers.authorization, 'Bearer sec')
  const rotated = await ensureDevice(client, DEVICE, 'https://r', 'ios', 'b', false)
  assert.equal(rotated.device.pushToken, 'b')
  assert.deepEqual(relay.calls[1].json, { pushToken: 'b', paused: false })

  const fresh = await ensureDevice(client, null, 'https://r', 'android', 't', false)
  assert.deepEqual(fresh, { device: { relayUrl: 'https://r', deviceId: 'd2', deviceSecret: 'sec2', platform: 'android', pushToken: 't' }, paused: false, registered: true })
  assert.equal(relay.calls.length, 3, 'not paused: no pause call after registering')

  const forgot = fakeRelay({ 'PUT /v1/devices/:id': (c) => (c.headers.authorization === 'Bearer sec' ? [401, { error: 'unauthorized' }] : [200, { updated: true, paused: true }]), 'POST /v1/devices': [201, { deviceId: 'd3', deviceSecret: 'sec3' }] })
  const again = await ensureDevice(relayClient(forgot.fetch), DEVICE, 'https://r', 'ios', 'a', true)
  assert.equal(again.device.deviceId, 'd3')
  assert.equal(again.registered, true)
  assert.deepEqual(forgot.calls.map((c) => `${c.method} ${c.path}`), ['PUT /v1/devices/d1', 'POST /v1/devices', 'PUT /v1/devices/d3'])
  assert.deepEqual(forgot.calls[2].json, { paused: true }, 'the pause is set on the new registration')

  // The new registration is kept when its pause can't be set; other failures are thrown.
  const flaky = fakeRelay({ 'POST /v1/devices': [201, { deviceId: 'd4', deviceSecret: 'sec4' }], 'PUT /v1/devices/:id': [503, { error: 'busy' }] })
  const kept = await ensureDevice(relayClient(flaky.fetch), null, 'https://r', 'ios', 'a', true)
  assert.deepEqual([kept.device.deviceId, kept.paused], ['d4', false])
  await assert.rejects(ensureDevice(relayClient(flaky.fetch), DEVICE, 'https://r', 'ios', 'a', false), /busy/)
})

test("push: registration sends the build's key; the relay's errors say what it answered", async () => {
  const relay = fakeRelay({ 'POST /v1/devices': (c) => (c.headers['x-trek-relay-key'] === 'k' ? [201, { deviceId: 'd1', deviceSecret: 'sec' }] : [401, { error: 'registration key required' }]), 'POST /v1/grants': [409, { error: 'this device has too many grants' }] })
  assert.deepEqual(await relayClient(relay.fetch, { relayKey: 'k' }).register('https://r', 'android', 'tok'), { deviceId: 'd1', deviceSecret: 'sec' })
  assert.deepEqual(relay.calls[0].json, { platform: 'android', pushToken: 'tok' })
  await assert.rejects(relayClient(relay.fetch).register('https://r', 'android', 'tok'), (err) => err.status === 401 && /registration key required/.test(err.message))
  assert.equal(relay.calls[1].headers['x-trek-relay-key'], undefined)
  const client = relayClient(relay.fetch)
  await assert.rejects(client.grant(DEVICE, 'x'.repeat(200)), /too many grants/)
  assert.equal(relay.calls[2].headers.authorization, 'Bearer sec')
  assert.equal(relay.calls[2].json.label.length, 80)
  assert.equal(relay.calls[2].headers['x-trek-relay-key'], undefined, 'the key goes only with a registration')
  await assert.rejects(relayClient(async () => { throw new Error('offline') }).register('https://r', 'ios', 't'), (err) => err.status === 0 && /could not be reached/.test(err.message))
  const answered = await relayClient(async () => ({ status: 503, json: async () => { throw new Error('not json') } })).grant(DEVICE, 'x').catch((e) => e)
  assert.deepEqual([answered.status, answered.message], [503, 'The push relay answered 503'])
})

test('push: every relay call gives up after its timeout, aborting the request', async () => {
  let signal
  const hang = (url, init) => {
    signal = init.signal
    return new Promise(() => {})
  }
  const t0 = Date.now()
  const err = await relayClient(hang, { timeoutMs: 30 }).revoke(DEVICE, 'g1').catch((e) => e)
  assert.equal(err.status, 0)
  assert.match(err.message, /could not be reached: no answer/)
  assert.equal(signal.aborted, true)
  assert.ok(Date.now() - t0 < 1000)
  await assert.rejects(withTimeout(new Promise(() => {}), 20, 'push.status'), /push.status: no answer/)
  assert.equal(await withTimeout(Promise.resolve(7), 20, 'x'), 7)
})

test('push: a grant call on a dead device sends the token and tries once more; an unknown device registers again', async () => {
  let dead = true
  const relay = fakeRelay({
    'POST /v1/grants': () => (dead ? [410, { error: 'device-dead' }] : [201, { grantId: 'g1', grantSecret: 'gs' }]),
    'PUT /v1/devices/:id': () => {
      dead = false
      return [200, { updated: true, paused: false }]
    }
  })
  const client = relayClient(relay.fetch)
  const err = await client.grant(DEVICE, 'x').catch((e) => e)
  assert.equal(isDeadDevice(err), true)
  assert.equal(isDeadDevice(Object.assign(new Error('x'), { status: 410 })), false)
  const why = []
  const out = await withDevice(DEVICE, async (w, d) => {
    why.push(w)
    return (await ensureDevice(client, d, d.relayUrl, d.platform, d.pushToken, false)).device
  }, (d) => client.grant(d, 'srv'))
  assert.deepEqual(out.result, { grantId: 'g1', grantSecret: 'gs' })
  assert.deepEqual(why, ['dead'])
  assert.deepEqual(relay.calls.slice(1).map((c) => `${c.method} ${c.path}`), ['POST /v1/grants', 'PUT /v1/devices/d1', 'POST /v1/grants'])

  const other = { ...DEVICE, deviceId: 'd9', deviceSecret: 'sec9' }
  // A 401 from the relay: recovered with a new registration, the call made with it.
  const four01 = relayClient(async (url, init) => ({ status: init.headers.authorization === 'Bearer sec' ? 401 : 201, json: async () => ({ grantId: 'g2', grantSecret: 'gs2' }) }))
  const re = await withDevice(DEVICE, async (w) => (why.push(w), other), (d) => four01.grant(d, 'x'))
  assert.deepEqual([re.result.grantId, re.device.deviceId], ['g2', 'd9'])
  assert.equal(why.at(-1), 'unknown')
  // Anything else isn't recovered: it is thrown, and only once tried.
  let tries = 0
  await assert.rejects(withDevice(DEVICE, async () => assert.fail('no recovery'), async () => {
    tries++
    throw Object.assign(new Error('slow down'), { status: 429 })
  }), /slow down/)
  assert.equal(tries, 1)
})

test('push: a new grant for none, another relay or registration, a refused one, or a server on another relay; switches compared by value', () => {
  const push = { grantId: 'g', grantSecret: 'x', kinds: { decisions: true, sessions: false, prWatch: true }, serverId: 's', relayUrl: 'https://r', deviceId: 'd1' }
  const status = { relayUrl: 'https://r', active: true, paused: false, kinds: { prWatch: true, sessions: false, decisions: true } }
  assert.equal(needsGrant(null, null, 'https://r', 'd1'), true)
  assert.equal(needsGrant(push, status, 'https://r', 'd1'), false)
  assert.equal(needsGrant(push, null, 'https://r', 'd1'), false, 'the server forgot it: the same grant again')
  assert.equal(needsGrant(push, { ...status, active: false }, 'https://r', 'd1'), true)
  assert.equal(needsGrant(push, { ...status, relayUrl: 'https://old' }, 'https://r', 'd1'), true)
  assert.equal(needsGrant(push, status, 'https://new', 'd1'), true)
  assert.equal(needsGrant(push, status, 'https://r', 'd2'), true)
  const { relayUrl: _r, deviceId: _d, ...older } = push
  assert.equal(needsGrant(older, status, 'https://r', 'd1'), true, 'a record from before relayUrl/deviceId were kept')

  const ctx = { relayUrl: 'https://r', deviceId: 'd1', paused: false }
  assert.equal(syncPlan(push, status, ctx), 'none', 'the same switches in another key order')
  assert.equal(syncPlan(push, status, { ...ctx, force: true }), 'set')
  assert.equal(syncPlan(push, { ...status, paused: true }, ctx), 'set')
  assert.equal(syncPlan(push, { ...status, kinds: { ...status.kinds, sessions: true } }, ctx), 'set')
  assert.equal(syncPlan(push, null, ctx), 'set')
  assert.equal(syncPlan(null, status, ctx), 'grant')
  assert.equal(kindsEqual({ decisions: true, sessions: true, prWatch: false }, { prWatch: false, decisions: true, sessions: true }), true)
  assert.equal(kindsEqual({ decisions: true, sessions: true, prWatch: false }, { decisions: true, sessions: true, prWatch: true }), false)
  assert.deepEqual(setGrantParams('https://r', push, true), { relayUrl: 'https://r', grantSecret: 'x', kinds: { decisions: true, sessions: false, prWatch: true }, paused: true })
})

test('push: one queue per key runs its jobs in order, a failure not stopping the next; keys run side by side', async () => {
  const run = keyedQueue()
  const log = []
  let grants = 0
  const sync = (key) =>
    run(key, async () => {
      log.push(`start ${key}`)
      await new Promise((r) => setTimeout(r, 5))
      if (key === 'a' && grants === 0) grants++
      log.push(`end ${key}`)
    })
  const failing = run('a', async () => {
    log.push('fail a')
    throw new Error('x')
  })
  await Promise.all([failing.catch(() => {}), sync('a'), sync('a'), sync('b')])
  assert.equal(grants, 1, 'the second sync sees the first one done')
  assert.deepEqual(log.filter((l) => l.endsWith(' a')), ['fail a', 'start a', 'end a', 'start a', 'end a'])
  assert.ok(log.indexOf('start b') < log.indexOf('end a'), 'another key does not wait')
  await assert.rejects(failing, /x/)
  assert.equal(await run('a', async () => 5), 5)
})

test('push: Pause all is the relay\'s: servers are told paused only while the relay does not hold it', () => {
  assert.equal(serverPaused(true, true), false, 'held at the relay: servers unpaused, so resuming there resumes them all')
  assert.equal(serverPaused(true, null), true, 'the relay could not be told: the servers hold it (fallback)')
  assert.equal(serverPaused(true, false), true, 'the relay answered otherwise: fallback')
  assert.equal(serverPaused(false, false), false)
  assert.equal(serverPaused(false, null), false, 'resumed with the relay out of reach: servers resume')
  assert.equal(serverPaused(false, true), false)
  // A server left paused by the fallback is told false once the relay holds the pause.
  const push = { grantId: 'g', grantSecret: 's', kinds: { decisions: true, sessions: true, prWatch: true }, serverId: 'srv', relayUrl: 'https://r', deviceId: 'd1' }
  const status = { active: true, relayUrl: 'https://r', paused: true, kinds: push.kinds }
  assert.equal(syncPlan(push, status, { relayUrl: 'https://r', deviceId: 'd1', paused: serverPaused(true, true) }), 'set')
  assert.equal(setGrantParams('https://r', push, serverPaused(true, true)).paused, false)
})

test('push: a forget queued behind a sync runs after it, and the sync stops before its writes once forgotten', async () => {
  const queue = keyedQueue()
  const epochs = keyedEpochs()
  const writes = []
  let release
  const gate = new Promise((r) => (release = r))
  const current = epochs.guard('srv') // taken when the sync is asked for
  const sync = queue('srv', async () => {
    await gate // the server's push.status, the relay's grant…
    if (!current()) return 'stopped'
    writes.push('storage')
    writes.push('setGrant')
    return 'synced'
  })
  epochs.bump('srv') // Remove pressed while the sync waits
  const forget = queue('srv', async () => void writes.push('clear'))
  release()
  assert.equal(await sync, 'stopped')
  await forget
  assert.deepEqual(writes, ['clear'], 'no grant written or handed over for a removed server; the clear last')
  // A sync started after the forget sees no bump of its own; another key is untouched.
  const other = epochs.guard('other')
  epochs.bump('srv')
  assert.equal(other(), true)
})

test("push: a tapped push names the server's own id (iOS: the payload's body as data; Android: data keys at the top); mapped to the entry", () => {
  const entryFor = (id) => (id === 'srv-1' ? 'entry-1' : undefined)
  // iOS: expo-notifications gives the APNs payload's `body` object as content.data.
  const iosPayload = { aps: { alert: { title: 'Trek · p', body: 'A decision is waiting' }, sound: 'default' }, body: { kind: 'decision', serverId: 'srv-1', projectId: 'p', sessionId: 's' } }
  assert.deepEqual(pushRouteData(iosPayload.body, entryFor), { kind: 'decision', serverId: 'entry-1', projectId: 'p', sessionId: 's' })
  // Android: the FCM message's data at the top, beside Google's own keys on a cold start.
  const androidData = { kind: 'pr-merged', serverId: 'srv-1', projectId: 'p', worktreeId: 'w', 'google.message_id': '0:1', 'google.sent_time': 1 }
  assert.deepEqual(pushRouteData(androidData, entryFor), { kind: 'pr-merged', serverId: 'entry-1', projectId: 'p', worktreeId: 'w' })
  assert.equal(pushRouteData({ kind: 'decision', serverId: 'unknown', projectId: 'p' }, entryFor), null)
  const local = { serverId: 'entry-1', projectId: 'p', sessionId: 's' }
  assert.equal(pushRouteData(local, entryFor), local, 'a local notification (6a) already names the entry')
  assert.equal(pushRouteData(null, entryFor), null)
})

test('push: a tap waits until the phone has loaded its servers, then is routed or dropped', () => {
  const routeData = (d) => pushRouteData(d, (id) => (id === 'srv-1' ? 'entry-1' : undefined))
  const tap = { kind: 'session-stopped', serverId: 'srv-1', projectId: 'p', sessionId: 's' }
  assert.equal(routeTap(tap, false, routeData, notificationRoute), 'wait')
  assert.deepEqual(routeTap(tap, true, routeData, notificationRoute), { pathname: '/session/[serverId]/[projectId]/[sessionId]', params: { serverId: 'entry-1', projectId: 'p', sessionId: 's' } })
  assert.equal(routeTap({ ...tap, serverId: 'gone' }, true, routeData, notificationRoute), null)
  assert.equal(routeTap({ kind: 'decision', serverId: 'srv-1', projectId: 'p' }, true, routeData, notificationRoute), null, 'no session or worktree: nothing to open')
})

test('TerminalFeed: a Windows server\'s pty sets xterm up for ConPTY before the size and the held output', () => {
  const feed = new TerminalFeed()
  feed.data('out')
  assert.deepEqual(feed.size(80, 24, 22631), [
    { type: 'windowsPty', buildNumber: 22631 },
    { type: 'size', cols: 80, rows: 24 },
    { type: 'data', data: 'out' }
  ])
})

const tkServer = (over = {}) => ({
  capabilities: [],
  plugins: [
    { id: 'voice', version: '1.0.0', defaultEnabled: true },
    { id: 'linear', version: '1.0.0', defaultEnabled: true },
    { id: 'azure-devops', version: '1.0.0', defaultEnabled: true }
  ],
  ...over
})
const tkIds = (server, settings = {}) => activeTicketProviders(server, settings).map((p) => p.id)

const qbSession = (id, extra = {}) => ({ id, title: `tab ${id}`, llm: { provider: 'claude' }, queue: [], status: 'idle', ...extra })
const qbWorktree = (id, branch, sessions) => ({ id, name: branch, path: `/r/trek-${branch}`, branch, isMain: false, loaded: true, sessions })
const qbProject = () => ({
  id: 'p',
  name: 'App',
  settings: {
    terminalButtons: [{ id: 'b1', label: 'Ship', text: 'ship [branch]' }],
    globalTerminalButtons: [{ id: 'g1', label: 'Plan', text: 'plan {WHAT}' }],
    worktreeTags: [{ id: 'review', name: 'In Review', color: '#fff' }],
    customTags: [
      { id: 'a', name: 'Alpha', color: '#000' },
      { id: 'b', name: 'Beta', color: '#000' }
    ]
  },
  repositories: [
    {
      id: 'r',
      name: 'trek',
      path: '/r/trek',
      branchData: { feat: { tag: 'review', customTags: ['b', 'a'], note: 'remember X', ticket: 'TOW-12', pr: 'https://github.com/o/r/pull/42' } },
      worktrees: [qbWorktree('w1', 'feat', [qbSession('s1', { agentSessionId: 'agent-1' }), qbSession('s2')]), qbWorktree('w2', 'bare', [qbSession('s3')])]
    }
  ],
  globalSessions: [qbSession('g', { agentSessionId: 'agent-g' })]
})
const qbNow = new Date(2026, 10, 15, 9, 5)

test('quick buttons: a worktree session gets the project buttons, a Global session the Global ones', () => {
  const project = qbProject()
  assert.deepEqual(quickButtonsFor(project, 's1').map((b) => b.id), ['b1'])
  assert.deepEqual(quickButtonsFor(project, 'g').map((b) => b.id), ['g1'])
  assert.deepEqual(quickButtonsFor(project, 'nope'), [])
  project.settings = {}
  assert.deepEqual(quickButtonsFor(project, 's1'), [])
  assert.deepEqual(quickButtonsFor(project, 'g'), [])
})

test('quick buttons: every built-in from the snapshot; ticket_url only with a link lookup', () => {
  const ctx = quickButtonContext(qbProject(), 's1', 'Claude', qbNow)
  assert.deepEqual(resolveBuiltins(ctx), {
    worktree_id: 'w1',
    worktree_name: 'feat',
    worktree_path: '/r/trek-feat',
    branch: 'feat',
    repo_name: 'trek',
    repo_path: '/r/trek',
    project_name: 'App',
    workflow_tag: 'In Review',
    labels: 'Alpha, Beta',
    ticket: 'TOW-12',
    ticket_url: undefined,
    pr_url: 'https://github.com/o/r/pull/42',
    pr_number: '42',
    note: 'remember X',
    session_title: 'tab s1',
    session_id: 'agent-1',
    terminal_id: 's1',
    agent: 'Claude',
    date: '2026-11-15',
    time: '09:05'
  })
  // Without a lookup (or with one that has no link), a button using [ticket_url] asks for it.
  assert.deepEqual(planQuickButton('see [ticket_url]', resolveBuiltins(ctx)), { inputs: [], missing: ['ticket_url'], needsModal: true })
  const noLink = quickButtonContext(qbProject(), 's1', 'Claude', qbNow, () => null)
  assert.equal(resolveBuiltins(noLink).ticket_url, undefined)

  // With the project's trackers' lookup, it is the ticket's link.
  const asked = []
  const linked = quickButtonContext(qbProject(), 's1', 'Claude', qbNow, (id) => {
    asked.push(id)
    return `https://linear.app/acme/issue/${id}`
  })
  const values = resolveBuiltins(linked)
  assert.equal(values.ticket_url, 'https://linear.app/acme/issue/TOW-12')
  assert.deepEqual(asked, ['TOW-12'])
  assert.deepEqual(planQuickButton('see [ticket_url]', values), { inputs: [], missing: [], needsModal: false })

  // The session screen's lookup: the providers on for the project, and its settings.
  const project = qbProject()
  project.settings.linearWorkspace = 'acme'
  const providers = activeTicketProviders(tkServer(), project.settings)
  const viaTrackers = quickButtonContext(project, 's1', 'Claude', qbNow, (id) => ticketView(providers, project.settings, id).url)
  assert.equal(resolveBuiltins(viaTrackers).ticket_url, 'https://linear.app/acme/issue/TOW-12')
})

test('quick buttons: what has no value: an unknown agent id or label, a branch without data, a Global session', () => {
  const project = qbProject()
  const pending = resolveBuiltins(quickButtonContext(project, 's2', undefined, qbNow))
  assert.equal(pending.session_id, undefined)
  assert.equal(pending.terminal_id, 's2')
  assert.equal(pending.agent, undefined)

  const bare = resolveBuiltins(quickButtonContext(project, 's3', 'Codex', qbNow))
  assert.equal(bare.branch, 'bare')
  for (const name of ['workflow_tag', 'labels', 'ticket', 'pr_url', 'pr_number', 'note']) assert.equal(bare[name], undefined, name)

  const global = resolveBuiltins(quickButtonContext(project, 'g', 'Claude', qbNow))
  assert.equal(global.project_name, 'App')
  assert.equal(global.session_id, 'agent-g')
  for (const name of ['worktree_id', 'worktree_name', 'worktree_path', 'branch', 'repo_name', 'repo_path', 'workflow_tag', 'labels', 'ticket', 'pr_url', 'pr_number', 'note']) assert.equal(global[name], undefined, name)

  assert.equal(quickButtonContext(project, 'nope', 'Claude', qbNow), null)
})

test('quick buttons: the main checkout resolves its branch data; a worktree without a branch has none', () => {
  const project = qbProject()
  project.repositories[0].worktrees.push(
    { ...qbWorktree('wm', 'feat', [qbSession('sm')]), isMain: true },
    (() => {
      const w = qbWorktree('wn', 'x', [qbSession('sn')])
      delete w.branch
      return w
    })()
  )
  const main = resolveBuiltins(quickButtonContext(project, 'sm', 'Claude', qbNow))
  assert.equal(main.worktree_id, 'wm')
  assert.equal(main.worktree_name, 'feat')
  assert.equal(main.branch, 'feat')
  assert.equal(main.note, 'remember X')

  const none = resolveBuiltins(quickButtonContext(project, 'sn', 'Claude', qbNow))
  assert.equal(none.worktree_id, 'wn')
  assert.equal(none.repo_name, 'trek')
  for (const name of ['branch', 'workflow_tag', 'labels', 'ticket', 'pr_url', 'pr_number', 'note']) assert.equal(none[name], undefined, name)
})

test('worktrees: a github.com pull request link, in its canonical form; its label and its branch', () => {
  assert.deepEqual(parsePullRequestUrl('https://github.com/o/r/pull/42/files?x=1'), { owner: 'o', repo: 'r', number: 42, url: 'https://github.com/o/r/pull/42' })
  assert.deepEqual(parsePullRequestUrl('  http://www.github.com/my-org/my.repo/pull/7  '), { owner: 'my-org', repo: 'my.repo', number: 7, url: 'https://github.com/my-org/my.repo/pull/7' })
  assert.equal(parsePullRequestUrl('https://www.github.com/o/r/pull/1')?.number, 1)
  for (const bad of ['https://gitlab.com/o/r/pull/1', 'github.com/o/r/pull/1', 'https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/', '']) {
    assert.equal(parsePullRequestUrl(bad), null, bad)
  }
  assert.equal(pullRequestLabel('https://github.com/o/r/pull/42'), '#42')
  assert.equal(pullRequestLabel('https://dev.azure.com/o/p/_git/r/pullrequest/9'), '#9')
  assert.equal(pullRequestLabel('https://github.com/o/r'), 'PR')
  assert.equal(prBranch(42), 'pr/42')
})

test('worktrees: branch suggestions contain the typed text, the exact match first, up to the limit', () => {
  const branches = ['main', 'feat/login', 'fix/Login-crash', 'login']
  assert.deepEqual(branchSuggestions(branches, 'login'), ['login', 'feat/login', 'fix/Login-crash'])
  assert.deepEqual(branchSuggestions(branches, ' LOGIN '), ['login', 'feat/login', 'fix/Login-crash'])
  assert.deepEqual(branchSuggestions(branches, ''), [])
  assert.deepEqual(branchSuggestions(branches, '   '), [])
  assert.deepEqual(branchSuggestions(branches, 'nope'), [])
  assert.deepEqual(branchSuggestions(branches, 'login', 2), ['login', 'feat/login'])
  const many = Array.from({ length: 20 }, (_, i) => `b${i}`)
  assert.equal(branchSuggestions(many, 'b').length, 8)
})

test("worktrees: a refused removal is a dirty one by the server's reason or git's text, as on the desktop", () => {
  const err = (code, message, details) => Object.assign(new Error(message), { code, details })
  assert.equal(refusedAsDirty(err('GIT_ERROR', 'git refused', { reason: 'dirty' })), true)
  assert.equal(refusedAsDirty(err('GIT_ERROR', "fatal: '/r/x' contains modified or untracked files, use --force to delete it")), true)
  assert.equal(refusedAsDirty(err('GIT_ERROR', 'Contains Modified Or Untracked files')), true)
  assert.equal(refusedAsDirty(err('GIT_ERROR', 'fatal: not a working tree')), false)
  assert.equal(refusedAsDirty(err('GIT_ERROR', 'no', { reason: 'locked' })), false)
  // Only git's refusal counts, whatever else the error says.
  assert.equal(refusedAsDirty(err('INTERNAL', 'contains modified or untracked files', { reason: 'dirty' })), false)
  assert.equal(refusedAsDirty(new Error('contains modified or untracked files')), false)
  assert.equal(refusedAsDirty('modified or untracked'), false)
  assert.equal(refusedAsDirty(null), false)
})

/** A remove flow whose requests and questions are recorded in `calls`. */
const removal = (worktree, over = {}) => {
  const calls = []
  const step = (name, result) => async (...args) => {
    calls.push(args.length ? `${name}(${args.join(',')})` : name)
    return typeof result === 'function' ? result(...args) : result
  }
  const deps = {
    worktree: { id: 'w1', name: 'feat', loaded: false, ...worktree },
    unload: step('unload', over.unload),
    load: step('load', over.load),
    remove: step('remove', over.remove),
    confirmRemove: step('confirmRemove', over.confirmRemove ?? true),
    confirmDiscard: step('confirmDiscard', over.confirmDiscard ?? true),
    refusedAsDirty: over.refusedAsDirty ?? refusedAsDirty
  }
  return { calls, run: () => removeWorktree(deps) }
}
const dirtyRefusal = () => Object.assign(new Error('git refused'), { code: 'GIT_ERROR', details: { reason: 'dirty' } })
const rejects = (error) => () => {
  throw error
}

test('worktrees: removing asks first, unloads a loaded worktree, then removes', async () => {
  const clean = removal({})
  assert.deepEqual(await clean.run(), { kind: 'removed' })
  assert.deepEqual(clean.calls, ['confirmRemove', 'remove(false)'])

  const declined = removal({ loaded: true }, { confirmRemove: false })
  assert.deepEqual(await declined.run(), { kind: 'cancelled' })
  assert.deepEqual(declined.calls, ['confirmRemove'])

  const loaded = removal({ loaded: true })
  assert.deepEqual(await loaded.run(), { kind: 'removed' })
  assert.deepEqual(loaded.calls, ['confirmRemove', 'unload', 'remove(false)'])
})

test('worktrees: a worktree with changes is removed with force, after the discard question', async () => {
  const dirty = removal({ dirty: true, loaded: true })
  assert.deepEqual(await dirty.run(), { kind: 'removed' })
  assert.deepEqual(dirty.calls, ['confirmDiscard', 'unload', 'remove(true)'])

  const declined = removal({ dirty: true, loaded: true }, { confirmDiscard: false })
  assert.deepEqual(await declined.run(), { kind: 'cancelled' })
  assert.deepEqual(declined.calls, ['confirmDiscard'])

  // Changes that appeared since the snapshot: git refuses, the phone asks, then forces.
  const refused = removal({}, { remove: (force) => (force ? undefined : rejects(dirtyRefusal())()) })
  assert.deepEqual(await refused.run(), { kind: 'removed' })
  assert.deepEqual(refused.calls, ['confirmRemove', 'remove(false)', 'confirmDiscard', 'remove(true)'])

  const kept = removal({ loaded: true }, { remove: rejects(dirtyRefusal()), confirmDiscard: false })
  assert.deepEqual(await kept.run(), { kind: 'cancelled' })
  assert.deepEqual(kept.calls, ['confirmRemove', 'unload', 'remove(false)', 'confirmDiscard', 'load'])

  const keptUnloaded = removal({}, { remove: rejects(dirtyRefusal()), confirmDiscard: false })
  assert.deepEqual(await keptUnloaded.run(), { kind: 'cancelled' })
  assert.deepEqual(keptUnloaded.calls, ['confirmRemove', 'remove(false)', 'confirmDiscard'])
})

test('worktrees: a failed removal loads again what the phone unloaded, and never rejects', async () => {
  const boom = new Error('boom')
  const failed = removal({ loaded: true }, { remove: rejects(boom) })
  assert.deepEqual(await failed.run(), { kind: 'failed', error: boom })
  assert.deepEqual(failed.calls, ['confirmRemove', 'unload', 'remove(false)', 'load'])

  // The reload is best effort: the removal's own error is the one reported.
  const reloadFails = removal({ loaded: true }, { remove: rejects(boom), load: rejects(new Error('load failed')) })
  assert.deepEqual(await reloadFails.run(), { kind: 'failed', error: boom })
  assert.deepEqual(reloadFails.calls, ['confirmRemove', 'unload', 'remove(false)', 'load'])

  const notLoaded = removal({}, { remove: rejects(boom) })
  assert.deepEqual(await notLoaded.run(), { kind: 'failed', error: boom })
  assert.deepEqual(notLoaded.calls, ['confirmRemove', 'remove(false)'])

  // Not unloaded by the phone, so not loaded by it either.
  const unloadFails = removal({ loaded: true }, { unload: rejects(boom) })
  assert.deepEqual(await unloadFails.run(), { kind: 'failed', error: boom })
  assert.deepEqual(unloadFails.calls, ['confirmRemove', 'unload'])

  // A forced removal that fails is not asked about again, even refused as dirty.
  const forced = removal({ dirty: true, loaded: true }, { remove: rejects(dirtyRefusal()) })
  assert.equal((await forced.run()).kind, 'failed')
  assert.deepEqual(forced.calls, ['confirmDiscard', 'unload', 'remove(true)', 'load'])

  const forcedAfterRefusal = removal({ loaded: true }, { remove: (force) => rejects(force ? boom : dirtyRefusal())() })
  assert.deepEqual(await forcedAfterRefusal.run(), { kind: 'failed', error: boom })
  assert.deepEqual(forcedAfterRefusal.calls, ['confirmRemove', 'unload', 'remove(false)', 'confirmDiscard', 'remove(true)', 'load'])

  // A question that throws is a failure too, with the reload.
  const askFails = removal({ loaded: true }, { remove: rejects(dirtyRefusal()), confirmDiscard: rejects(boom) })
  assert.deepEqual(await askFails.run(), { kind: 'failed', error: boom })
  assert.deepEqual(askFails.calls, ['confirmRemove', 'unload', 'remove(false)', 'confirmDiscard', 'load'])

  // The first question throwing: nothing was asked of the server.
  const firstAskFails = removal({ loaded: true }, { confirmRemove: rejects(boom) })
  assert.deepEqual(await firstAskFails.run(), { kind: 'failed', error: boom })
  assert.deepEqual(firstAskFails.calls, ['confirmRemove'])

  // A worktree with changes that can't be unloaded is neither removed nor loaded.
  const dirtyUnloadFails = removal({ dirty: true, loaded: true }, { unload: rejects(boom) })
  assert.deepEqual(await dirtyUnloadFails.run(), { kind: 'failed', error: boom })
  assert.deepEqual(dirtyUnloadFails.calls, ['confirmDiscard', 'unload'])
})

test('worktrees: a reload that throws instead of rejecting does not break the remove flow', async () => {
  const boom = new Error('boom')
  // `load` here is not async: it throws before it returns a promise.
  const throwingLoad = (over) => {
    const calls = []
    const step = (name, result) => async (...args) => {
      calls.push(args.length ? `${name}(${args.join(',')})` : name)
      return typeof result === 'function' ? result(...args) : result
    }
    const run = () =>
      removeWorktree({
        worktree: { id: 'w1', name: 'feat', loaded: true },
        unload: step('unload'),
        load: () => {
          calls.push('load')
          throw new Error('load threw')
        },
        remove: step('remove', over.remove),
        confirmRemove: step('confirmRemove', true),
        confirmDiscard: step('confirmDiscard', over.confirmDiscard ?? true),
        refusedAsDirty
      })
    return { calls, run }
  }
  const failed = throwingLoad({ remove: rejects(boom) })
  assert.deepEqual(await failed.run(), { kind: 'failed', error: boom })
  assert.deepEqual(failed.calls, ['confirmRemove', 'unload', 'remove(false)', 'load'])

  const declined = throwingLoad({ remove: rejects(dirtyRefusal()), confirmDiscard: false })
  assert.deepEqual(await declined.run(), { kind: 'cancelled' })
  assert.deepEqual(declined.calls, ['confirmRemove', 'unload', 'remove(false)', 'confirmDiscard', 'load'])
})

/** A server whose stack.status and env.list answer (or reject with) what is given; `asked` lists the requests. */
const teardownServer = (capabilities, answers) => {
  const asked = []
  const request = async (method) => {
    asked.push(method)
    const answer = answers[method]
    if (answer instanceof Error) throw answer
    return answer
  }
  return { asked, server: { connection: { welcome: { capabilities }, request } } }
}
const tdWorktree = { id: 'w1', path: '/r/x' }
const tdCheck = (capabilities, answers, options) => {
  const { asked, server } = teardownServer(capabilities, answers)
  return teardownBlocker(server, 'p1', 'r1', tdWorktree, options).then((why) => ({ why, asked }))
}

test("teardown: a running dev stack or Docker VM is the desktop's to tear down; a server without them has none", async () => {
  const idle = { containers: 0, upRunning: false }
  const vm = (vmState, worktreePath = '/r/x') => ({ worktreePath, vmState, profile: 'trek-x' })
  for (const options of [undefined, { strict: true }]) {
    assert.deepEqual(await tdCheck(['stacks', 'env'], { 'stack.status': idle, 'env.list': [] }, options), { why: null, asked: ['stack.status', 'env.list'] })
    assert.equal((await tdCheck(['stacks', 'env'], { 'stack.status': { containers: 2, upRunning: false }, 'env.list': [] }, options)).why, 'its dev stack is running')
    assert.equal((await tdCheck(['stacks', 'env'], { 'stack.status': { containers: 0, upRunning: true }, 'env.list': [] }, options)).why, 'its dev stack is running')
    assert.equal((await tdCheck(['stacks', 'env'], { 'stack.status': idle, 'env.list': [vm('running')] }, options)).why, 'its Docker VM (trek-x) is running')
    assert.equal((await tdCheck(['stacks', 'env'], { 'stack.status': idle, 'env.list': [vm('stopped'), vm('running', '/r/other')] }, options)).why, null)
    // Without the capabilities nothing is asked, and that is not a failed check.
    assert.deepEqual(await tdCheck(['agents'], {}, options), { why: null, asked: [] })
    assert.deepEqual(await tdCheck(['env'], { 'env.list': [] }, options), { why: null, asked: ['env.list'] })
  }
})

test('teardown: a check that fails counts as nothing running for a promote, and stops a removal', async () => {
  const down = new Error('Not connected')
  const idle = { containers: 0, upRunning: false }
  const cases = [
    { 'stack.status': down, 'env.list': [] },
    { 'stack.status': idle, 'env.list': down },
    { 'stack.status': down, 'env.list': down }
  ]
  for (const answers of cases) {
    assert.equal((await tdCheck(['stacks', 'env'], answers)).why, null)
    assert.equal((await tdCheck(['stacks', 'env'], answers, {})).why, null)
    assert.equal((await tdCheck(['stacks', 'env'], answers, { strict: true })).why, TEARDOWN_UNCHECKED)
  }
  assert.equal(TEARDOWN_UNCHECKED, 'it could not be checked whether its dev stack or Docker VM is running')
  // What was seen running is still the reason, whatever else failed.
  assert.equal((await tdCheck(['stacks', 'env'], { 'stack.status': { containers: 1, upRunning: false }, 'env.list': down }, { strict: true })).why, 'its dev stack is running')
  assert.equal(
    (await tdCheck(['stacks', 'env'], { 'stack.status': down, 'env.list': [{ worktreePath: '/r/x', vmState: 'running', profile: 'trek-x' }] }, { strict: true })).why,
    'its Docker VM (trek-x) is running'
  )
})

test("tickets: the providers on for the project, by the server's plugin list and the project's plugins setting", () => {
  assert.deepEqual(tkIds(tkServer()), ['linear', 'azure-devops'])
  assert.deepEqual(tkIds(tkServer(), { plugins: { linear: { enabled: false } } }), ['azure-devops'])
  assert.deepEqual(tkIds(tkServer(), { plugins: { linear: { enabled: false }, 'azure-devops': { enabled: false } } }), [])
  // The server's default decides a project with no setting, not the app's manifest.
  const offByDefault = tkServer({ plugins: [{ id: 'linear', version: '1.0.0', defaultEnabled: false }, { id: 'azure-devops', version: '1.0.0', defaultEnabled: true }] })
  assert.deepEqual(tkIds(offByDefault), ['azure-devops'])
  assert.deepEqual(tkIds(offByDefault, { plugins: { linear: { enabled: true } } }), ['linear', 'azure-devops'])
  // A server that lists plugins but not this one does not have it.
  assert.deepEqual(tkIds(tkServer({ plugins: [{ id: 'linear', version: '1.0.0', defaultEnabled: true }] })), ['linear'])
  assert.deepEqual(tkIds(tkServer({ plugins: [] })), [])
  // No welcome yet.
  assert.deepEqual(tkIds(undefined), [])
  assert.deepEqual(tkIds(null), [])
})

test('tickets: a server older than plugins has Azure DevOps built in, and Linear with its capability; always on there', () => {
  assert.deepEqual(tkIds({ capabilities: ['agents', 'linear'] }), ['linear', 'azure-devops'])
  assert.deepEqual(tkIds({ capabilities: ['agents'] }), ['azure-devops'])
  assert.deepEqual(tkIds({}), ['azure-devops'])
  // The project's plugins setting is not read there.
  assert.deepEqual(tkIds({ capabilities: ['linear'] }, { plugins: { linear: { enabled: false }, 'azure-devops': { enabled: false } } }), ['linear', 'azure-devops'])
})

test("tickets: a ticket's label and link from the project's settings; the raw id with no provider", () => {
  const providers = activeTicketProviders(tkServer(), {})
  assert.deepEqual(ticketView(providers, { linearWorkspace: 'acme' }, 'TOW-12'), { label: 'TOW-12', url: 'https://linear.app/acme/issue/TOW-12' })
  assert.deepEqual(ticketView(providers, {}, 'TOW-12'), { label: 'TOW-12', url: null })
  assert.deepEqual(ticketView(providers, { linearWorkspace: '' }, 'TOW-12'), { label: 'TOW-12', url: null })
  assert.deepEqual(ticketView(providers, { azureDevOpsBaseUrl: 'https://dev.azure.com/org/Proj/' }, '123'), { label: '#123', url: 'https://dev.azure.com/org/Proj/_workitems/edit/123' })
  assert.deepEqual(ticketView(providers, { linearWorkspace: 'acme' }, '123'), { label: '#123', url: null })
  assert.deepEqual(ticketView(providers, { linearWorkspace: 'acme' }, 'whatever'), { label: 'whatever', url: null })

  // Linear turned off for the project: nothing owns its ids.
  const settings = { linearWorkspace: 'acme', plugins: { linear: { enabled: false } } }
  assert.deepEqual(ticketView(activeTicketProviders(tkServer(), settings), settings, 'TOW-12'), { label: 'TOW-12', url: null })
  assert.deepEqual(ticketView([], settings, '123'), { label: '123', url: null })
})

test("tickets: typed or pasted input is taken as the desktop's ticket dialog takes it", () => {
  const both = activeTicketProviders(tkServer(), {})
  const linearOnly = activeTicketProviders(tkServer(), { plugins: { 'azure-devops': { enabled: false } } })
  assert.deepEqual(parseTicketInput(both, 'https://linear.app/acme/issue/tow-12/fix-login'), { ticketId: 'TOW-12' })
  assert.deepEqual(parseTicketInput(both, '  tow-12 '), { ticketId: 'TOW-12' })
  assert.deepEqual(parseTicketInput(both, '123'), { ticketId: '123' })
  assert.deepEqual(parseTicketInput(both, 'https://dev.azure.com/org/Proj/_workitems/edit/123'), { ticketId: '123' })

  // What no tracker on in the project reads is refused, saying what they take.
  assert.deepEqual(parseTicketInput(both, 'fix the login'), { error: 'Enter a Linear issue id (TOW-123) or issue URL, or an Azure DevOps work item id or URL.' })
  assert.deepEqual(parseTicketInput(linearOnly, '123'), { error: 'Enter a Linear issue id (TOW-123) or issue URL.' })
  assert.deepEqual(parseTicketInput(linearOnly, 'https://dev.azure.com/org/Proj/_workitems/edit/123'), { error: 'Enter a Linear issue id (TOW-123) or issue URL.' })
  assert.deepEqual(parseTicketInput(both, ''), { error: 'Enter a Linear issue id (TOW-123) or issue URL, or an Azure DevOps work item id or URL.' })
  assert.deepEqual(parseTicketInput(both, '   '), { error: 'Enter a Linear issue id (TOW-123) or issue URL, or an Azure DevOps work item id or URL.' })
  // No tracker on: where to turn one on, in the phone's words (the phone has no Settings → Plugins).
  assert.deepEqual(parseTicketInput([], 'TOW-12'), { error: "No ticket tracker is on in this project. Turn one on in the desktop app's Settings → Plugins." })
  assert.deepEqual(parseTicketInput([], ''), { error: "No ticket tracker is on in this project. Turn one on in the desktop app's Settings → Plugins." })
})

test("worktree list: a branch's line is its tag, custom tags, ticket and pull request, when present", () => {
  const settings = {
    worktreeTags: [{ id: 't1', name: 'In Review', color: '#fff' }],
    customTags: [
      { id: 'c1', name: 'urgent', color: '#fff' },
      { id: 'c2', name: 'blocked', color: '#fff' }
    ],
    linearWorkspace: 'acme'
  }
  const linear = activeTicketProviders({ plugins: [{ id: 'linear', defaultEnabled: true }] }, settings)
  const repo = {
    branchData: {
      full: { tag: 't1', customTags: ['c2', 'c1', 'gone'], ticket: 'TOW-12', pr: 'https://github.com/o/r/pull/42', note: 'not on the line' },
      tagOnly: { tag: 't1' },
      prOnly: { pr: 'https://github.com/o/r' },
      stale: { tag: 'deleted', customTags: ['gone'] },
      empty: {}
    }
  }
  // Custom tags in the project's order; one the project no longer has is left out.
  assert.equal(branchLine(settings, repo, 'full', linear), 'In Review · urgent · blocked · TOW-12 · PR #42')
  assert.equal(branchLine(settings, repo, 'tagOnly', linear), 'In Review')
  // A link without a number is still a pull request.
  assert.equal(branchLine(settings, repo, 'prOnly', linear), 'PR')
  assert.equal(branchLine(settings, repo, 'stale', linear), '')
  assert.equal(branchLine(settings, repo, 'empty', linear), '')
  assert.equal(branchLine(settings, repo, 'unknown', linear), '')
  // Not an inherited property of the record.
  assert.equal(branchLine(settings, repo, 'toString', linear), '')
  assert.equal(branchLine(settings, repo, undefined, linear), '')
  // No tracker on: the ticket's id as stored.
  assert.equal(branchLine(settings, { branchData: { b: { ticket: 'TOW-12' } } }, 'b', []), 'TOW-12')
  // A project that never set its tags has the default ones (their ids are their names).
  assert.equal(branchLine({}, { branchData: { b: { tag: 'In Progress' } } }, 'b', []), 'In Progress')
  assert.equal(branchLine({ worktreeTags: [] }, { branchData: { b: { tag: 'In Progress' } } }, 'b', []), '')
})

test('worktree list: the worktree a branch is checked out in; a missing one does not count', () => {
  const repo = {
    worktrees: [
      { id: 'm', branch: 'main', isMain: true },
      { id: 'gone', branch: 'pr/7', missing: true },
      { id: 'w7', branch: 'pr/7' },
      { id: 'detached' }
    ]
  }
  assert.equal(worktreeOnBranch(repo, 'pr/7')?.id, 'w7')
  assert.equal(worktreeOnBranch(repo, 'main')?.id, 'm')
  assert.equal(worktreeOnBranch(repo, 'pr/8'), undefined)
  assert.equal(worktreeOnBranch({ worktrees: [{ id: 'gone', branch: 'pr/7', missing: true }] }, 'pr/7'), undefined)
})

test("worktree list: a repository's folder name, from a path of either kind", () => {
  assert.equal(repoFolder('/Users/me/code/trek'), 'trek')
  assert.equal(repoFolder('/Users/me/code/trek/'), 'trek')
  assert.equal(repoFolder('C:\\code\\trek\\'), 'trek')
  assert.equal(repoFolder('trek'), 'trek')
})
