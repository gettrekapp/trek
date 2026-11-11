// The phone app's pure modules (6a, apps/mobile/src/logic): the server-address rule, the
// attention list and its notifications, the key bar, the diff colouring, the terminal feed and
// the ref counts, the connection notices, the per-server generations, the held topic view and
// the value a promote request waits for.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkServerUrl, isPrivateHost } from '../apps/mobile/src/logic/serverUrl.ts'
import { ago, attentionKey, attentionText, mergeAttention, newItems, notificationContent, notificationRoute } from '../apps/mobile/src/logic/attention.ts'
import { KEY_BAR } from '../apps/mobile/src/logic/keys.ts'
import { classifyDiff } from '../apps/mobile/src/logic/diff.ts'
import { TerminalFeed, pageScript } from '../apps/mobile/src/logic/terminalFeed.ts'
import { connectionNotice, sessionPlaceholder } from '../apps/mobile/src/logic/connection.ts'
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
