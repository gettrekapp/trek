// The phone app's pure modules (6a, apps/mobile/src/logic): the server-address rule, the
// attention list and its notifications, the key bar, the diff colouring, the terminal feed and
// the ref counts, the connection notices, the per-server generations, the held topic view and
// the value a promote request waits for, the quick buttons' list and built-in context, and the
// rules for adding and removing a worktree (pull request links, branch suggestions, the remove flow,
// and state/teardown.ts' check for what only the desktop can tear down first)
// and a ticket's label, link and input through the project's trackers, and what the worktree list
// says about a branch (its tag, custom tags, ticket and pull request on one line), and the Branch
// section's rules (the custom tags' toggle, the note's edit and its conflict, a pull request's input),
// and the Changes screen's review (which comments sit where on the shown diff, the draft bar, the
// comment box's state and what it sends, the server's refusals, the sessions a draft can go to, a
// commit's row) and the pull request watch (the switch, its label, a notice's line and dismissal).
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
import { branchSuggestions, parsePullRequestUrl, prBranch, pullRequestLabel, refusedAsDirty, removeQuestion, removeWorktree } from '../apps/mobile/src/logic/worktrees.ts'
import { activeTicketProviders, parseTicketInput, ticketView } from '../apps/mobile/src/logic/tickets.ts'
import { TEARDOWN_UNCHECKED, teardownBlocker } from '../apps/mobile/src/state/teardown.ts'
import { branchLine, repoFolder, worktreeOnBranch } from '../apps/mobile/src/logic/worktreeList.ts'
import { beginNoteEdit, chipColors, isNoteConflict, noteConflicted, noteSave, pullRequestInput, pullRequestText, toggledCustomTags, webLink } from '../apps/mobile/src/logic/branchDetails.ts'
import { ClientError } from '../src/shared/client/connection.ts'
import { checkExpected } from '../server/src/validate.ts'
import {
  MAX_LINES_SHOWN,
  REVIEW_CHANGED,
  barText,
  boxAfter,
  canComment,
  canSaveComment,
  commentPlace,
  commitRow,
  discardQuestion,
  draftOnDiff,
  editConflicted,
  editOf,
  editorAfter,
  elsewherePlace,
  fileMark,
  fileReview,
  gutter,
  hasUnsavedText,
  isCommentGone,
  isReplyLost,
  isReviewConflict,
  lineCap,
  newCommentAt,
  noTargetsText,
  reviewFailure,
  saveRequest,
  sendQuestion,
  sendTargets,
  writingOn
} from '../apps/mobile/src/logic/review.ts'
import { isWatching, noticeAge, noticeDismissal, noticeLine, watchAction, watchOffered, watchSuffix } from '../apps/mobile/src/logic/prWatch.ts'
import { numberedLines, patchBody } from '../src/shared/changes.ts'
import { BRANCH_SOURCE, MAX_REVIEW_BODY, MAX_REVIEW_COMMENTS, MAX_REVIEW_LINE_TEXT, isOutdated } from '../src/shared/review.ts'
import { reviewHandlers } from '../server/src/review/reviewHandlers.ts'
import { prWatchHandlers } from '../server/src/prWatch/prWatchHandlers.ts'
import { toWireError } from '../server/src/errors.ts'
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
  const { loaded = false, ...rest } = worktree
  const deps = {
    worktree: { id: 'w1', name: 'feat', ...rest },
    // Not a request or a question: not recorded.
    loaded: over.loaded ?? (() => loaded),
    ...('stillAllowed' in over ? { stillAllowed: step('stillAllowed', over.stillAllowed) } : {}),
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

  // The reload is best effort: the removal's own error is the one reported, with the failed reload said.
  const reloadFails = removal({ loaded: true }, { remove: rejects(boom), load: rejects(new Error('load failed')) })
  assert.deepEqual(await reloadFails.run(), { kind: 'failed', error: boom, reloadFailed: true })
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
        worktree: { id: 'w1', name: 'feat' },
        loaded: () => true,
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
  assert.deepEqual(await failed.run(), { kind: 'failed', error: boom, reloadFailed: true })
  assert.deepEqual(failed.calls, ['confirmRemove', 'unload', 'remove(false)', 'load'])

  const declined = throwingLoad({ remove: rejects(dirtyRefusal()), confirmDiscard: false })
  assert.deepEqual(await declined.run(), { kind: 'cancelled', reloadFailed: true })
  assert.deepEqual(declined.calls, ['confirmRemove', 'unload', 'remove(false)', 'confirmDiscard', 'load'])
})

test('worktrees: a reload that fails is reported, only for a worktree the phone unloaded', async () => {
  const boom = new Error('boom')
  const loadFails = rejects(new Error('Not connected'))
  const declined = removal({ loaded: true }, { remove: rejects(dirtyRefusal()), confirmDiscard: false, load: loadFails })
  assert.deepEqual(await declined.run(), { kind: 'cancelled', reloadFailed: true })
  assert.deepEqual(declined.calls, ['confirmRemove', 'unload', 'remove(false)', 'confirmDiscard', 'load'])

  const forced = removal({ loaded: true }, { remove: (force) => rejects(force ? boom : dirtyRefusal())(), load: loadFails })
  assert.deepEqual(await forced.run(), { kind: 'failed', error: boom, reloadFailed: true })

  // A reload that works, or none to do: nothing said.
  const reloaded = removal({ loaded: true }, { remove: rejects(boom) })
  assert.deepEqual(await reloaded.run(), { kind: 'failed', error: boom })
  const notLoaded = removal({}, { remove: rejects(boom), load: loadFails })
  assert.deepEqual(await notLoaded.run(), { kind: 'failed', error: boom })
  const unloadFails = removal({ loaded: true }, { unload: rejects(boom), load: loadFails })
  assert.deepEqual(await unloadFails.run(), { kind: 'failed', error: boom })
  assert.deepEqual(unloadFails.calls, ['confirmRemove', 'unload'])
})

test('worktrees: whether it is loaded is read after the confirmation, not at the tap', async () => {
  const boom = new Error('boom')
  // Loaded at the tap, unloaded by another client while the question was up: the phone neither
  // unloads it nor, after a failure, loads it (which would start its sessions again).
  const during = (over) => {
    let loaded = true
    return removal({}, { loaded: () => loaded, confirmRemove: () => ((loaded = false), true), ...over })
  }
  const gone = during({ remove: rejects(boom) })
  assert.deepEqual(await gone.run(), { kind: 'failed', error: boom })
  assert.deepEqual(gone.calls, ['confirmRemove', 'remove(false)'])
  const declined = during({ remove: rejects(dirtyRefusal()), confirmDiscard: false })
  assert.deepEqual(await declined.run(), { kind: 'cancelled' })
  assert.deepEqual(declined.calls, ['confirmRemove', 'remove(false)', 'confirmDiscard'])

  // The other way round: loaded while the question was up, so unloaded (and loaded again on a failure).
  let loaded = false
  const since = removal({}, { loaded: () => loaded, confirmRemove: () => ((loaded = true), true), remove: rejects(boom) })
  assert.deepEqual(await since.run(), { kind: 'failed', error: boom })
  assert.deepEqual(since.calls, ['confirmRemove', 'unload', 'remove(false)', 'load'])

  // Not read at all when the question is declined; read once otherwise.
  let reads = 0
  const count = () => (reads++, true)
  assert.deepEqual(await removal({}, { loaded: count, confirmRemove: false }).run(), { kind: 'cancelled' })
  assert.equal(reads, 0)
  assert.equal((await removal({}, { loaded: count, remove: rejects(dirtyRefusal()), confirmDiscard: false }).run()).kind, 'cancelled')
  assert.equal(reads, 1)
})

test('worktrees: the stack and VM are checked again after the confirmation, before anything is sent', async () => {
  const boom = new Error('boom')
  const allowed = removal({ loaded: true }, { stillAllowed: null })
  assert.deepEqual(await allowed.run(), { kind: 'removed' })
  assert.deepEqual(allowed.calls, ['confirmRemove', 'stillAllowed', 'unload', 'remove(false)'])

  const blocked = removal({ loaded: true }, { stillAllowed: 'its dev stack is running' })
  assert.deepEqual(await blocked.run(), { kind: 'blocked', why: 'its dev stack is running' })
  assert.deepEqual(blocked.calls, ['confirmRemove', 'stillAllowed'])

  const dirtyBlocked = removal({ dirty: true, loaded: true }, { stillAllowed: 'its Docker VM (trek-x) is running' })
  assert.deepEqual(await dirtyBlocked.run(), { kind: 'blocked', why: 'its Docker VM (trek-x) is running' })
  assert.deepEqual(dirtyBlocked.calls, ['confirmDiscard', 'stillAllowed'])

  // Not asked when the question is declined.
  const declined = removal({ loaded: true }, { stillAllowed: 'its dev stack is running', confirmRemove: false })
  assert.deepEqual(await declined.run(), { kind: 'cancelled' })
  assert.deepEqual(declined.calls, ['confirmRemove'])

  // A check that rejects, or throws, is a failure with nothing sent.
  const rejected = removal({ loaded: true }, { stillAllowed: rejects(boom) })
  assert.deepEqual(await rejected.run(), { kind: 'failed', error: boom })
  assert.deepEqual(rejected.calls, ['confirmRemove', 'stillAllowed'])
  const thrown = await removeWorktree({
    worktree: { id: 'w1', name: 'feat' },
    loaded: () => true,
    stillAllowed: () => {
      throw boom
    },
    unload: () => assert.fail('unload'),
    load: () => assert.fail('load'),
    remove: () => assert.fail('remove'),
    confirmRemove: async () => true,
    confirmDiscard: async () => true,
    refusedAsDirty
  })
  assert.deepEqual(thrown, { kind: 'failed', error: boom })

  // Asked once: not again before the discard question after a refusal.
  const refused = removal({}, { stillAllowed: null, remove: (force) => (force ? undefined : rejects(dirtyRefusal())()) })
  assert.deepEqual(await refused.run(), { kind: 'removed' })
  assert.deepEqual(refused.calls, ['confirmRemove', 'stillAllowed', 'remove(false)', 'confirmDiscard', 'remove(true)'])
})

test('worktrees: the questions, which say that a loaded worktree\'s sessions stop', () => {
  assert.deepEqual(removeQuestion('feat', false, 'remove'), { title: 'Remove feat?', message: "The worktree's folder is deleted. Its branch stays." })
  assert.deepEqual(removeQuestion('feat', true, 'remove'), {
    title: 'Remove feat?',
    message: "The worktree's folder is deleted. Its branch stays. Its running sessions will be stopped."
  })
  assert.deepEqual(removeQuestion('feat', false, 'discard'), { title: 'feat has uncommitted changes.', message: 'Removing it discards them. This cannot be undone.' })
  assert.deepEqual(removeQuestion('feat', true, 'discard'), {
    title: 'feat has uncommitted changes.',
    message: 'Removing it discards them. This cannot be undone. Its running sessions will be stopped.'
  })
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
  return { asked, server: { connection: { welcome: capabilities ? { capabilities } : undefined, request } } }
}
const tdWorktree = { id: 'w1', path: '/r/x' }
const tdCheck = (capabilities, answers, options, worktree = tdWorktree) => {
  const { asked, server } = teardownServer(capabilities, answers)
  return teardownBlocker(server, 'p1', 'r1', worktree, options).then((why) => ({ why, asked }))
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

test('teardown: a strict check tells what the server cannot have running from a check that failed', async () => {
  const idle = { containers: 0, upRunning: false }
  const strict = { strict: true }
  const both = ['stacks', 'env']
  const runningVm = { worktreePath: '/r/x', vmState: 'running', profile: 'trek-x' }
  // The errors as the server words them (machineHandlers.ts' viaTool, worktreeHandlers.ts' present, paths.ts).
  const noColima = new ClientError('TOOL_ERROR', "colima is not installed on the server (it is not on the server's PATH)", { reason: 'missing' })
  const outsideRoots = new ClientError('PATH_DENIED', 'Path not under a configured root: /r/x')
  const gone = new ClientError('BAD_REQUEST', '/r/x no longer exists; remove the worktree or create its branch again')

  // A server machine without colima has no VMs.
  assert.deepEqual(await tdCheck(both, { 'stack.status': idle, 'env.list': noColima }, strict), { why: null, asked: ['stack.status', 'env.list'] })
  assert.equal((await tdCheck(both, { 'stack.status': { containers: 1, upRunning: false }, 'env.list': noColima }, strict)).why, 'its dev stack is running')
  assert.equal((await tdCheck(both, { 'stack.status': new Error('Not connected'), 'env.list': noColima }, strict)).why, TEARDOWN_UNCHECKED)
  // Only that rejection of env.list: any other tool error, or the same one for the stack, is a failed check.
  const envFailures = [
    new ClientError('TOOL_ERROR', 'colima list exited with code 1'),
    new ClientError('TOOL_ERROR', 'the registry is unreadable', { reason: 'registry' }),
    new ClientError('INTERNAL', 'boom', { reason: 'missing' }),
    new ClientError('PATH_DENIED', '/r is not a registered repo'),
    new ClientError('TIMEOUT', 'Request timed out'),
    new ClientError('NOT_CONNECTED', 'Not connected'),
    new Error('Not connected')
  ]
  for (const err of envFailures) assert.equal((await tdCheck(both, { 'stack.status': idle, 'env.list': err }, strict)).why, TEARDOWN_UNCHECKED, err.message)
  assert.equal((await tdCheck(both, { 'stack.status': noColima, 'env.list': [] }, strict)).why, TEARDOWN_UNCHECKED)

  // A worktree git no longer lists has no stack: stack.status (which refuses it) is not asked; its VM still is.
  const missing = { ...tdWorktree, missing: true }
  assert.deepEqual(await tdCheck(both, { 'stack.status': gone, 'env.list': [] }, strict, missing), { why: null, asked: ['env.list'] })
  assert.deepEqual(await tdCheck(['stacks'], { 'stack.status': gone }, strict, missing), { why: null, asked: [] })
  assert.equal((await tdCheck(both, { 'stack.status': gone, 'env.list': [runningVm] }, strict, missing)).why, 'its Docker VM (trek-x) is running')
  assert.equal((await tdCheck(both, { 'stack.status': gone, 'env.list': new Error('Not connected') }, strict, missing)).why, TEARDOWN_UNCHECKED)
  assert.deepEqual(await tdCheck(both, { 'stack.status': gone, 'env.list': noColima }, strict, missing), { why: null, asked: ['env.list'] })
  // The same refusal for a worktree not known as missing is a failed check.
  assert.equal((await tdCheck(both, { 'stack.status': gone, 'env.list': [] }, strict)).why, TEARDOWN_UNCHECKED)

  // A worktree outside the server's allowed roots: the server runs no stack there.
  assert.deepEqual(await tdCheck(both, { 'stack.status': outsideRoots, 'env.list': [] }, strict), { why: null, asked: ['stack.status', 'env.list'] })
  assert.equal((await tdCheck(both, { 'stack.status': outsideRoots, 'env.list': [runningVm] }, strict)).why, 'its Docker VM (trek-x) is running')
  assert.equal((await tdCheck(both, { 'stack.status': outsideRoots, 'env.list': outsideRoots }, strict)).why, TEARDOWN_UNCHECKED)
  const stackFailures = [
    new ClientError('TOOL_ERROR', 'stack.sh status exited with code 1'),
    new ClientError('NOT_FOUND', 'this server has no machine services'),
    new ClientError('TIMEOUT', 'Request timed out'),
    new ClientError('INTERNAL', 'boom')
  ]
  for (const err of stackFailures) assert.equal((await tdCheck(both, { 'stack.status': err, 'env.list': [] }, strict)).why, TEARDOWN_UNCHECKED, err.message)
})

test('teardown: a connection with no welcome yet is unchecked for a removal, and asks nothing', async () => {
  assert.deepEqual(await tdCheck(undefined, {}, { strict: true }), { why: TEARDOWN_UNCHECKED, asked: [] })
  assert.deepEqual(await tdCheck(undefined, {}), { why: null, asked: [] })
  assert.deepEqual(await tdCheck(undefined, {}, {}), { why: null, asked: [] })
})

test('teardown: a promote asks and answers as before, whatever the rejection or the worktree', async () => {
  const idle = { containers: 0, upRunning: false }
  const both = ['stacks', 'env']
  const missing = { ...tdWorktree, missing: true }
  const noColima = new ClientError('TOOL_ERROR', 'colima is not installed', { reason: 'missing' })
  const gone = new ClientError('BAD_REQUEST', '/r/x no longer exists')
  assert.deepEqual(await tdCheck(both, { 'stack.status': idle, 'env.list': noColima }), { why: null, asked: ['stack.status', 'env.list'] })
  assert.deepEqual(await tdCheck(both, { 'stack.status': gone, 'env.list': [] }, undefined, missing), { why: null, asked: ['stack.status', 'env.list'] })
  assert.deepEqual(await tdCheck(both, { 'stack.status': new ClientError('PATH_DENIED', 'no'), 'env.list': [] }, {}), { why: null, asked: ['stack.status', 'env.list'] })
  assert.equal((await tdCheck(both, { 'stack.status': { containers: 1, upRunning: false }, 'env.list': [] }, undefined, missing)).why, 'its dev stack is running')
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

test('branch details: toggling a custom tag gives the new list, or null when it empties', () => {
  assert.deepEqual(toggledCustomTags(undefined, 'c1'), ['c1'])
  assert.deepEqual(toggledCustomTags([], 'c1'), ['c1'])
  assert.deepEqual(toggledCustomTags(['c1'], 'c2'), ['c1', 'c2'])
  assert.deepEqual(toggledCustomTags(['c1', 'c2'], 'c1'), ['c2'])
  assert.equal(toggledCustomTags(['c1'], 'c1'), null)
  // One the project no longer has stays as it is, as on the desktop.
  assert.deepEqual(toggledCustomTags(['gone', 'c1'], 'c1'), ['gone'])
  // The list given is not changed.
  const current = ['c1']
  toggledCustomTags(current, 'c2')
  assert.deepEqual(current, ['c1'])
})

/** The server's own guard (server/src/validate.ts, as setBranchField calls it for a note), as the phone gets its refusal. */
const noteGuard = (current, expected) => {
  try {
    checkExpected('branchData.note', current, expected)
    return null
  } catch (err) {
    return new ClientError(err.code, err.message)
  }
}

test("branch details: the server's refusal of a note that changed meanwhile is told from other errors", () => {
  const refusal = noteGuard('theirs', 'mine')
  assert.equal(refusal.code, 'CONFLICT')
  assert.equal(refusal.message, 'branchData.note changed since you read it')
  assert.equal(isNoteConflict(refusal), true)
  assert.equal(isNoteConflict(new ClientError('CONFLICT', 'branchData.note changed since you read it')), true)
  assert.equal(isNoteConflict(new ClientError('BAD_REQUEST', 'note must be a string or null')), false)
  assert.equal(isNoteConflict(new ClientError('NOT_FOUND', 'changed since you read it')), false)
  assert.equal(isNoteConflict(new Error('branchData.note changed since you read it')), false)
  assert.equal(isNoteConflict('CONFLICT'), false)
  assert.equal(isNoteConflict(null), false)
  assert.equal(isNoteConflict(undefined), false)
})

test("branch details: a note's save carries the note as it was when editing began, as the server compares it", () => {
  const fresh = beginNoteEdit(undefined)
  assert.deepEqual(fresh, { text: '', expected: null, conflict: false })
  // No note is null for the server, never '' (which it would refuse as a change) and never left out (no check at all).
  assert.deepEqual(noteSave({ ...fresh, text: 'first' }), { note: 'first', expected: null })
  assert.equal(noteGuard(undefined, noteSave(fresh).expected), null)
  assert.notEqual(noteGuard(undefined, ''), null)
  assert.equal(noteGuard('theirs', undefined), null)
  assert.deepEqual(beginNoteEdit(''), { text: '', expected: null, conflict: false })

  const edit = beginNoteEdit('as it was')
  assert.deepEqual(edit, { text: 'as it was', expected: 'as it was', conflict: false })
  assert.deepEqual(noteSave({ ...edit, text: 'mine\n  indented' }), { note: 'mine\n  indented', expected: 'as it was' })
  assert.equal(noteGuard('as it was', noteSave(edit).expected), null)
  assert.equal(isNoteConflict(noteGuard('theirs', noteSave(edit).expected)), true)
  // Written elsewhere meanwhile, also when there was none or it was cleared.
  assert.equal(isNoteConflict(noteGuard('theirs', noteSave(fresh).expected)), true)
  assert.equal(isNoteConflict(noteGuard(undefined, noteSave(edit).expected)), true)

  // An empty note clears it (blank lines and spaces only are empty).
  assert.deepEqual(noteSave({ ...edit, text: '' }), { note: null, expected: 'as it was' })
  assert.deepEqual(noteSave({ ...edit, text: ' \n\t ' }), { note: null, expected: 'as it was' })
})

test("branch details: after a conflict the user's text stays, and the next save expects the server's note shown", () => {
  const mine = { ...beginNoteEdit('as it was'), text: 'mine' }
  const conflicted = noteConflicted(mine, 'theirs')
  assert.deepEqual(conflicted, { text: 'mine', expected: 'theirs', conflict: true })
  assert.deepEqual(noteSave(conflicted), { note: 'mine', expected: 'theirs' })
  assert.equal(noteGuard('theirs', noteSave(conflicted).expected), null)
  // The edit given is not changed.
  assert.deepEqual(mine, { text: 'mine', expected: 'as it was', conflict: false })

  // The note was cleared on the server meanwhile.
  const cleared = noteConflicted(mine, undefined)
  assert.deepEqual(cleared, { text: 'mine', expected: null, conflict: true })
  assert.equal(noteGuard(undefined, noteSave(cleared).expected), null)
  assert.deepEqual(noteConflicted(mine, ''), { text: 'mine', expected: null, conflict: true })

  // Changed once more before that save: a conflict again, with the newer note.
  assert.equal(isNoteConflict(noteGuard('theirs again', noteSave(conflicted).expected)), true)
  assert.deepEqual(noteConflicted(conflicted, 'theirs again'), { text: 'mine', expected: 'theirs again', conflict: true })
})

test('branch details: a pull request box takes a github.com pull request link, saved in its canonical form', () => {
  assert.deepEqual(pullRequestInput(' https://github.com/o/r/pull/42/files '), { pr: 'https://github.com/o/r/pull/42' })
  assert.deepEqual(pullRequestInput('http://www.github.com/o/r/pull/7'), { pr: 'https://github.com/o/r/pull/7' })
  for (const bad of ['https://gitlab.com/o/r/pull/1', 'https://github.com/o/r/issues/1', '42', 'pr 42']) {
    assert.deepEqual(pullRequestInput(bad), { error: 'Not a GitHub pull request link' }, bad)
  }
  // Nothing typed is nothing to save (Clear is what unlinks).
  assert.equal(pullRequestInput(''), null)
  assert.equal(pullRequestInput('   '), null)
})

test('branch details: a pull request reads "PR #<n>"; only a web link is opened', () => {
  assert.equal(pullRequestText('https://github.com/o/r/pull/42'), 'PR #42')
  assert.equal(pullRequestText('https://dev.azure.com/o/p/_git/r/pullrequest/9'), 'PR #9')
  assert.equal(pullRequestText('https://github.com/o/r'), 'PR')
  assert.equal(webLink('https://github.com/o/r/pull/42'), 'https://github.com/o/r/pull/42')
  assert.equal(webLink(' HTTP://example.com/x '), 'HTTP://example.com/x')
  for (const not of ['', 'github.com/o/r/pull/1', 'javascript:alert(1)', 'tel:+3112345678', 'file:///etc/passwd', 'intent://x#Intent;end', 'https://', 'https://a b']) {
    assert.equal(webLink(not), null, not)
  }
  assert.equal(webLink(null), null)
  assert.equal(webLink(undefined), null)
})

test("branch details: a chip in its tag's colour has text that reads on it", () => {
  assert.deepEqual(chipColors('#5dabef'), { fill: '#5dabef', text: '#11111b' })
  assert.deepEqual(chipColors('#FFFFFF'), { fill: '#ffffff', text: '#11111b' })
  assert.deepEqual(chipColors('#000'), { fill: '#000000', text: '#ffffff' })
  assert.deepEqual(chipColors('#1e3a8a'), { fill: '#1e3a8a', text: '#ffffff' })
  assert.deepEqual(chipColors(' #ff0000 '), { fill: '#ff0000', text: '#11111b' })
  assert.deepEqual(chipColors('#0000ff'), { fill: '#0000ff', text: '#ffffff' })
  // Every default tag is a light colour.
  for (const color of ['#5dabef', '#b8a8f0', '#ff8589', '#e2a336', '#55c7e4', '#b8b8b8', '#5bb98b', '#ff7eb0']) assert.equal(chipColors(color).text, '#11111b', color)
  // Not a hex colour: a neutral chip, never text that can't be read.
  for (const bad of ['', 'red', '#12', '#12345', '#gggggg', 'rgb(1,2,3)', undefined]) assert.deepEqual(chipColors(bad), { fill: '#9399b2', text: '#11111b' }, String(bad))
})

// ── Review in Changes ────────────────────────────────────────────────────────────────────────

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const UNCOMMITTED = { kind: 'uncommitted' }
const PATCH_A = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' const c = 4',
  '\\ No newline at end of file',
  ''
].join('\n')
/** hunk, `new 1`, `old 2`, `new 2`, `new 3`, note */
const LINES_A = numberedLines(patchBody(PATCH_A))
const comment = (id, over = {}) => ({ id, source: BRANCH_SOURCE, path: 'src/a.ts', side: 'new', line: 2, lineText: 'const b = 3', body: `body of ${id}`, at: 1000, ...over })
const onAdded = comment('c1')
const onRemoved = comment('c2', { side: 'old', lineText: 'const b = 2' })
const outdated = comment('c3', { line: 3, lineText: 'const c = 5' })
const onUncommitted = comment('c4', { source: UNCOMMITTED })
const notInDiff = comment('c5', { path: 'src/gone.ts', line: 7, lineText: 'gone()' })
const onCommit = comment('c6', { source: { kind: 'commit', sha: SHA_A } })
const DRAFT = { revision: 6, comments: [onAdded, onRemoved, outdated, onUncommitted, notInDiff, onCommit] }

test('review: only a line with a side and a number can be commented on', () => {
  assert.deepEqual(LINES_A.map(canComment), [false, true, true, true, true, false])
  assert.equal(canComment({ text: 'index 1..2', kind: 'note' }), false)
})

test("review: the draft's comments on the shown diff by file, the rest elsewhere", () => {
  const shown = draftOnDiff(DRAFT, BRANCH_SOURCE, ['src/a.ts', 'src/b.ts'])
  assert.deepEqual([...shown.byPath.keys()], ['src/a.ts'])
  assert.deepEqual(shown.byPath.get('src/a.ts'), [onAdded, onRemoved, outdated])
  // Another source, a file not in this diff, a commit: in the draft's order.
  assert.deepEqual(shown.elsewhere, [onUncommitted, notInDiff, onCommit])

  const commit = draftOnDiff(DRAFT, { kind: 'commit', sha: SHA_A }, new Set(['src/a.ts']))
  assert.deepEqual(commit.byPath.get('src/a.ts'), [onCommit])
  assert.equal(commit.elsewhere.length, 5)
  // Another commit is another source.
  assert.equal(draftOnDiff(DRAFT, { kind: 'commit', sha: SHA_B }, ['src/a.ts']).elsewhere.length, 6)
  // The file list not loaded yet (or failed): nothing is shown on a file, so everything is elsewhere.
  assert.equal(draftOnDiff(DRAFT, BRANCH_SOURCE, []).elsewhere.length, 6)

  // No draft.
  const none = draftOnDiff(undefined, BRANCH_SOURCE, ['src/a.ts'])
  assert.equal(none.byPath.size, 0)
  assert.deepEqual(none.elsewhere, [])
})

test('review: a file\'s comments under their lines; one whose line reads differently is outdated, at the top', () => {
  const comments = draftOnDiff(DRAFT, BRANCH_SOURCE, ['src/a.ts']).byPath.get('src/a.ts')
  const placed = fileReview(comments, LINES_A, null)
  assert.deepEqual([...placed.byLine.entries()], [[3, [onAdded]], [2, [onRemoved]]])
  assert.deepEqual(placed.top, [outdated])
  assert.equal(placed.topTitle, 'Outdated: its line has changed')
  assert.equal(placed.newAt, -1)
  assert.equal(placed.newOnTop, false)
  // As the shared rule (and the agents' get_review_comments) sees it.
  assert.equal(isOutdated(outdated, PATCH_A), true)
  assert.equal(isOutdated(onAdded, PATCH_A), false)

  const gone = comment('c7', { line: 40, lineText: 'far away' })
  assert.equal(fileReview([outdated, gone], LINES_A, null).topTitle, 'Outdated: their lines have changed')

  // Nothing outdated: no box.
  const clean = fileReview([onAdded], LINES_A, null)
  assert.deepEqual(clean.top, [])
  assert.equal(clean.topTitle, null)
  assert.deepEqual(fileReview([], LINES_A, null), { byLine: new Map(), top: [], topTitle: null, newAt: -1, newOnTop: false })
})

test('review: a file whose patch is not shown holds its comments at the top, not as outdated', () => {
  // Binary, too large, still loading, or the diff failed: no line can say a comment is outdated.
  const held = fileReview([onAdded, outdated], undefined, null)
  assert.equal(held.byLine.size, 0)
  assert.deepEqual(held.top, [onAdded, outdated])
  assert.equal(held.topTitle, 'Comments on this file')
  assert.equal(fileReview([], undefined, null).topTitle, null)
})

test('review: where a comment was written, for one not under its line', () => {
  assert.equal(commentPlace(outdated), 'line 3: const c = 5')
  assert.equal(commentPlace(onRemoved), 'removed line 2: const b = 2')
  assert.equal(elsewherePlace(notInDiff), 'The branch against its base · src/gone.ts, line 7: gone()')
  assert.equal(elsewherePlace(onUncommitted), 'Uncommitted changes · src/a.ts, line 2: const b = 3')
  assert.equal(elsewherePlace(comment('c8', { source: { kind: 'commit', sha: SHA_A }, side: 'old' })), 'Commit aaaaaaa · src/a.ts, removed line 2: const b = 3')
})

test('review: each line of a patch has its number in the old file, the new one, or both', () => {
  const none = { old: null, new: null }
  // hunk, unchanged, removed, added, unchanged, note
  assert.deepEqual(gutter(LINES_A), [none, { old: 1, new: 1 }, { old: 2, new: null }, { old: null, new: 2 }, { old: 3, new: 3 }, none])
  // A second hunk starts where its header says, in both files; a new file has no old numbers.
  const two = numberedLines(['@@ -10,2 +10,3 @@', ' a', '+b', ' c', '@@ -40,2 +41,1 @@ fn()', '-d', ' e', '@@ -0,0 +1,1 @@', '+f'])
  assert.deepEqual(gutter(two), [
    none,
    { old: 10, new: 10 },
    { old: null, new: 11 },
    { old: 11, new: 12 },
    none,
    { old: 40, new: null },
    { old: 41, new: 41 },
    none,
    { old: null, new: 1 }
  ])
  // Lines before any hunk are notes: no numbers.
  assert.deepEqual(gutter(numberedLines(['Binary files differ'])), [none])
  assert.deepEqual(gutter([]), [])
})

test('review: the draft bar counts the comments, and those not on this diff', () => {
  assert.deepEqual(barText(1, 0), { count: '1 comment', elsewhere: null })
  assert.deepEqual(barText(6, 0), { count: '6 comments', elsewhere: null })
  assert.deepEqual(barText(6, 3), { count: '6 comments', elsewhere: '· 3 elsewhere' })
  assert.deepEqual(barText(1, 1), { count: '1 comment', elsewhere: '· 1 elsewhere' })
  const shown = draftOnDiff(DRAFT, BRANCH_SOURCE, ['src/a.ts'])
  assert.deepEqual(barText(DRAFT.comments.length, shown.elsewhere.length), { count: '6 comments', elsewhere: '· 3 elsewhere' })
})

test('review: a new comment is opened on a commentable line, with the line as a comment keeps it', () => {
  assert.equal(newCommentAt(BRANCH_SOURCE, 'src/a.ts', LINES_A[0]), null)
  assert.equal(newCommentAt(BRANCH_SOURCE, 'src/a.ts', LINES_A[5]), null)
  assert.deepEqual(newCommentAt(UNCOMMITTED, 'src/a.ts', LINES_A[2]), { kind: 'new', source: UNCOMMITTED, path: 'src/a.ts', side: 'old', line: 2, lineText: 'const b = 2' })
  // A long line is cut and its control characters dropped, as the server requires (and placeComments compares).
  const long = newCommentAt(BRANCH_SOURCE, 'src/a.ts', { text: `\u001b[31m${'x'.repeat(600)}\r`, kind: 'add', side: 'new', line: 9 })
  assert.equal(long.lineText, `[31m${'x'.repeat(MAX_REVIEW_LINE_TEXT - 4)}`)
})

test('review: a comment box saves a new comment with review.add and an edit with review.edit', () => {
  const fresh = newCommentAt(BRANCH_SOURCE, 'src/a.ts', LINES_A[3])
  assert.deepEqual(saveRequest(fresh, 'why 3?\n  not 2'), {
    method: 'review.add',
    params: { source: BRANCH_SOURCE, path: 'src/a.ts', side: 'new', line: 2, lineText: 'const b = 3', body: 'why 3?\n  not 2' }
  })
  const edit = editOf(onAdded)
  assert.deepEqual(edit, { kind: 'edit', commentId: 'c1', expected: 'body of c1', conflict: false })
  assert.deepEqual(saveRequest(edit, 'better'), { method: 'review.edit', params: { commentId: 'c1', body: 'better', expected: 'body of c1' } })

  // Nothing to save: blank, or longer than a comment may be.
  for (const text of ['', '  \n\t ']) {
    assert.equal(canSaveComment(text), false)
    assert.equal(saveRequest(fresh, text), null)
    assert.equal(saveRequest(edit, text), null)
  }
  assert.equal(canSaveComment('x'.repeat(MAX_REVIEW_BODY)), true)
  assert.equal(canSaveComment('x'.repeat(MAX_REVIEW_BODY + 1)), false)
  assert.equal(saveRequest(fresh, 'x'.repeat(MAX_REVIEW_BODY + 1)), null)
  // A pasted Windows or old-Mac line break is a line break (the server takes LF only).
  assert.equal(saveRequest(fresh, 'one\r\ntwo\rthree').params.body, 'one\ntwo\nthree')
  assert.equal(saveRequest(null, 'text'), null)
})

test('review: unsaved text is what opening another box would lose', () => {
  const fresh = newCommentAt(BRANCH_SOURCE, 'src/a.ts', LINES_A[3])
  assert.equal(hasUnsavedText(null, 'anything'), false)
  assert.equal(hasUnsavedText(fresh, ''), false)
  assert.equal(hasUnsavedText(fresh, ' \n '), false)
  assert.equal(hasUnsavedText(fresh, 'x'), true)
  const edit = editOf(onAdded)
  assert.equal(hasUnsavedText(edit, 'body of c1'), false)
  assert.equal(hasUnsavedText(edit, 'body of c1!'), true)
  // Emptied: the comment's text is not what the box holds.
  assert.equal(hasUnsavedText(edit, ''), true)
  // After a conflict the user's text is unsaved even if it is the body the edit began from.
  const theirs = { revision: 7, comments: [{ ...onAdded, body: 'theirs' }] }
  assert.equal(hasUnsavedText(editConflicted(edit, theirs), 'body of c1'), true)
})

test('review: the box closes when its comment is gone or another source is shown', () => {
  const fresh = newCommentAt(BRANCH_SOURCE, 'src/a.ts', LINES_A[3])
  assert.equal(editorAfter(null, DRAFT, BRANCH_SOURCE), null)
  // A new comment stays through any change to the draft (also with none), and is kept as the same object.
  assert.equal(editorAfter(fresh, DRAFT, BRANCH_SOURCE), fresh)
  assert.equal(editorAfter(fresh, undefined, { kind: 'branch' }), fresh)
  assert.equal(editorAfter(fresh, DRAFT, UNCOMMITTED), null)
  const onA = newCommentAt({ kind: 'commit', sha: SHA_A }, 'src/a.ts', LINES_A[3])
  assert.equal(editorAfter(onA, DRAFT, { kind: 'commit', sha: SHA_A }), onA)
  assert.equal(editorAfter(onA, DRAFT, { kind: 'commit', sha: SHA_B }), null)

  // An edit stays while its comment is in the draft, whatever is shown (it may be listed elsewhere).
  const edit = editOf(onUncommitted)
  assert.equal(editorAfter(edit, DRAFT, BRANCH_SOURCE), edit)
  assert.equal(editorAfter(edit, { revision: 7, comments: [onAdded] }, BRANCH_SOURCE), null)
  assert.equal(editorAfter(edit, undefined, BRANCH_SOURCE), null)
})

test('review: a new comment\'s box sits under its line while that reads the same, else at the file\'s top', () => {
  const fresh = newCommentAt(BRANCH_SOURCE, 'src/a.ts', LINES_A[3])
  assert.equal(writingOn(fresh, BRANCH_SOURCE, 'src/a.ts'), fresh)
  assert.equal(writingOn(fresh, BRANCH_SOURCE, 'src/b.ts'), null)
  assert.equal(writingOn(fresh, UNCOMMITTED, 'src/a.ts'), null)
  assert.equal(writingOn(editOf(onAdded), BRANCH_SOURCE, 'src/a.ts'), null)
  assert.equal(writingOn(null, BRANCH_SOURCE, 'src/a.ts'), null)

  const under = fileReview([], LINES_A, fresh)
  assert.equal(under.newAt, 3)
  assert.equal(under.newOnTop, false)
  assert.equal(under.topTitle, null)

  // A refresh changed the line: the box moves to the top, with where it was opened.
  const changed = numberedLines(patchBody(PATCH_A.replace('+const b = 3', '+const b = 30')))
  const stray = fileReview([], changed, fresh)
  assert.equal(stray.newAt, -1)
  assert.equal(stray.newOnTop, true)
  assert.equal(stray.topTitle, 'Its line is no longer in this diff')
  assert.equal(commentPlace(fresh), 'line 2: const b = 3')
  // With outdated comments there too, the box's title is theirs.
  assert.equal(fileReview([outdated], changed, fresh).topTitle, 'Outdated: its line has changed')
  // The patch no longer shown.
  const hidden = fileReview([], undefined, fresh)
  assert.equal(hidden.newOnTop, true)
  assert.equal(hidden.topTitle, 'Comments on this file')
})

/** The server's own review handlers on one worktree, as the phone gets their refusals (toWireError, then the SDK's ClientError). */
function reviewServer(review) {
  const worktree = { id: 'w1', name: 'feat', loaded: true, sessions: [{ id: 's1', title: 'Claude', status: 'idle', queue: [] }], review }
  const project = { id: 'p1', repositories: [{ id: 'r1', branchData: {}, worktrees: [worktree] }] }
  let ids = 0
  const ctx = { projects: { apply: (_id, fn) => fn(project), newId: () => `n${++ids}` } }
  const call = (method, params) => {
    try {
      reviewHandlers[method]({ projectId: 'p1', worktreeId: 'w1', ...params }, ctx)
      return null
    } catch (err) {
      const wire = toWireError(method, err)
      return new ClientError(wire.code, wire.message, wire.details)
    }
  }
  return { worktree, call }
}

test("review: the server's refusal of a draft or a comment that changed meanwhile is told from other errors", () => {
  const { worktree, call } = reviewServer({ revision: 6, comments: [onAdded, onRemoved] })
  // The revision shown is no longer the draft's: send and discard.
  for (const method of ['review.send', 'review.clear']) {
    const stale = call(method, { sessionId: 's1', revision: 5 })
    assert.equal(stale.code, 'CONFLICT', method)
    assert.equal(stale.message, 'the review changed since you read it')
    assert.equal(isReviewConflict(stale), true)
  }
  // The draft is gone (sent from the desktop): its revision is not 0 either.
  assert.equal(isReviewConflict(reviewServer(undefined).call('review.send', { sessionId: 's1', revision: 6 })), true)
  assert.equal(worktree.review.comments.length, 2)

  // An edit that began from a body the comment no longer has.
  const edited = call('review.edit', saveRequest(editOf({ ...onAdded, body: 'as I read it' }), 'mine').params)
  assert.equal(edited.code, 'CONFLICT')
  assert.equal(edited.message, 'the comment changed since you read it')
  assert.equal(isReviewConflict(edited), true)
  assert.equal(isCommentGone(edited), false)

  // A comment that no longer exists: edit and remove.
  for (const method of ['review.edit', 'review.remove']) {
    const gone = call(method, { commentId: 'c9', body: 'x', expected: 'y' })
    assert.equal(gone.code, 'NOT_FOUND', method)
    assert.equal(gone.message, 'No review comment with id "c9"')
    assert.equal(isCommentGone(gone), true)
    assert.equal(isReviewConflict(gone), false)
  }
  // NOT_FOUND for something else is not a comment gone: the worktree, the session.
  const noWorktree = call('review.remove', { worktreeId: 'w9', commentId: 'c1' })
  assert.equal(noWorktree.code, 'NOT_FOUND')
  assert.equal(isCommentGone(noWorktree), false)
  const noSession = call('review.send', { sessionId: 's9', revision: 6 })
  assert.equal(noSession.code, 'NOT_FOUND')
  assert.equal(isCommentGone(noSession), false)

  for (const not of [new Error('the review changed since you read it'), 'CONFLICT', null, undefined, new ClientError('BAD_REQUEST', 'revision must be an integer')]) {
    assert.equal(isReviewConflict(not), false)
    assert.equal(isCommentGone(not), false)
  }
})

test('review: what the error line says for each request that failed', () => {
  const { call } = reviewServer({ revision: 6, comments: [onAdded] })
  // A draft that changed is not retried: the bar shows the current one.
  assert.equal(REVIEW_CHANGED, 'The review changed on the server. Check it and send again.')
  assert.equal(reviewFailure('send', call('review.send', { sessionId: 's1', revision: 5 })), REVIEW_CHANGED)
  assert.equal(reviewFailure('clear', call('review.clear', { revision: 5 })), REVIEW_CHANGED)
  // An edit's conflict is shown by the box, not the line.
  const conflict = call('review.edit', { commentId: 'c1', body: 'mine', expected: 'stale' })
  assert.equal(reviewFailure('edit', conflict), null)
  // A comment already gone: deleting it is done; an edit of it has nowhere to go.
  const gone = call('review.remove', { commentId: 'c9' })
  assert.equal(reviewFailure('remove', gone), null)
  assert.equal(reviewFailure('edit', call('review.edit', { commentId: 'c9', body: 'x' })), 'Could not save the comment: it is no longer in the review')

  // The server's limits, in its words.
  const full = reviewServer({ revision: 200, comments: Array.from({ length: MAX_REVIEW_COMMENTS }, (_, i) => comment(`f${i}`)) })
  const refused = full.call('review.add', saveRequest(newCommentAt(BRANCH_SOURCE, 'src/a.ts', LINES_A[3]), 'one more').params)
  assert.equal(refused.code, 'BAD_REQUEST')
  assert.equal(reviewFailure('add', refused), 'Could not add the comment: a review holds at most 100 comments')
  const long = call('review.edit', { commentId: 'c1', body: 'x'.repeat(MAX_REVIEW_BODY + 1), expected: 'body of c1' })
  assert.equal(long.code, 'BAD_REQUEST')
  assert.equal(reviewFailure('edit', long), 'Could not save the comment: body must be at most 4000 characters')
  const control = call('review.add', { source: BRANCH_SOURCE, path: 'src/a.ts', side: 'new', line: 2, lineText: 'x', body: 'bell\u0007' })
  assert.equal(reviewFailure('add', control), 'Could not add the comment: body must not hold control characters other than line breaks and tabs')
  const noSession = call('review.send', { sessionId: 's9', revision: 6 })
  assert.equal(reviewFailure('send', noSession), 'Could not send the review: No session with id "s9" in this worktree')
  assert.equal(reviewFailure('remove', new ClientError('NOT_CONNECTED', 'Not connected')), 'Could not delete the comment: Not connected')
  assert.equal(reviewFailure('add', 'boom'), 'Could not add the comment: boom')
})

test('review: a reply lost with the connection says the request may have been done, so it is checked before a retry', () => {
  // What the phone's connection rejects a request with when the socket closes under it, when it was
  // not connected, and when no reply came in time (src/shared/client/connection.ts).
  const closed = new ClientError('NOT_CONNECTED', 'the connection closed')
  const timedOut = new ClientError('TIMEOUT', 'review.add timed out')
  for (const err of [closed, timedOut, new ClientError('NOT_CONNECTED', 'not connected to the server')]) assert.equal(isReplyLost(err), true)
  for (const not of [new ClientError('CONFLICT', 'the review changed since you read it'), new ClientError('BAD_REQUEST', 'x'), new Error('TIMEOUT'), 'NOT_CONNECTED', null, undefined]) {
    assert.equal(isReplyLost(not), false)
  }

  assert.equal(
    reviewFailure('add', closed),
    "Could not add the comment: The server was not connected, so the comment may not have been added. Check the file's comments once the phone is back online before adding it again."
  )
  assert.equal(
    reviewFailure('add', timedOut),
    "Could not add the comment: The server did not answer in time, so the comment may not have been added. Check the file's comments before adding it again."
  )
  assert.equal(
    reviewFailure('edit', closed),
    'Could not save the comment: The server was not connected, so the comment may not have been saved. Check it once the phone is back online before saving it again.'
  )
  assert.equal(
    reviewFailure('send', closed),
    "Could not send the review: The server was not connected, so the review may not have been sent. Check the session's queue once the phone is back online before sending it again."
  )
  assert.equal(
    reviewFailure('send', timedOut),
    "Could not send the review: The server did not answer in time, so the review may not have been sent. Check the session's queue before sending it again."
  )
  assert.equal(
    reviewFailure('clear', timedOut),
    'Could not discard the review: The server did not answer in time, so the review may not have been discarded. Check it before discarding it again.'
  )
  // A delete can be repeated: one that was done is a comment already gone, which says nothing.
  assert.equal(reviewFailure('remove', timedOut), 'Could not delete the comment: review.add timed out')
})

test('review: a large patch opens with its first 2,000 lines, and a button for the rest', () => {
  const none = { byLine: new Map(), newAt: -1 }
  assert.equal(MAX_LINES_SHOWN, 2000)
  assert.deepEqual(lineCap(none, 0, false), { shown: 0, more: null })
  assert.deepEqual(lineCap(none, 2000, false), { shown: 2000, more: null })
  assert.deepEqual(lineCap(none, 2001, false), { shown: 2000, more: 'Show all 2,001 lines' })
  assert.deepEqual(lineCap(none, 10000, false), { shown: 2000, more: 'Show all 10,000 lines' })
  assert.deepEqual(lineCap(none, 1234567, false), { shown: 2000, more: 'Show all 1,234,567 lines' })
  assert.deepEqual(lineCap(none, 10000, true), { shown: 10000, more: null })

  // Comments under lines that are not shown are counted on the button; those shown are not.
  const byLine = new Map([[10, [onAdded]], [1999, [onRemoved]], [2000, [outdated]], [7000, [onCommit, notInDiff]]])
  assert.deepEqual(lineCap({ byLine, newAt: -1 }, 10000, false), { shown: 2000, more: 'Show all 10,000 lines · 3 comments further down' })
  assert.deepEqual(lineCap({ byLine: new Map([[2000, [outdated]]]), newAt: -1 }, 10000, false), { shown: 2000, more: 'Show all 10,000 lines · 1 comment further down' })
  // The box of a comment being written is always among the lines shown (its line moved down on a reload).
  assert.deepEqual(lineCap({ byLine, newAt: 2000 }, 10000, false), { shown: 2001, more: 'Show all 10,000 lines · 2 comments further down' })
  assert.deepEqual(lineCap({ byLine, newAt: 9999 }, 10000, false), { shown: 10000, more: null })
  assert.deepEqual(lineCap({ byLine, newAt: 5 }, 10000, false), { shown: 2000, more: 'Show all 10,000 lines · 3 comments further down' })
  // So is the line of a comment being edited: its box is drawn when the file is opened again.
  assert.deepEqual(lineCap({ byLine, newAt: -1 }, 10000, false, 'c6'), { shown: 7001, more: 'Show all 10,000 lines' })
  assert.deepEqual(lineCap({ byLine, newAt: -1 }, 10000, false, 'c3'), { shown: 2001, more: 'Show all 10,000 lines · 2 comments further down' })
  assert.deepEqual(lineCap({ byLine, newAt: 2500 }, 10000, false, 'c3'), { shown: 2501, more: 'Show all 10,000 lines · 2 comments further down' })
  // One in the first lines, one that is not under a line of this file, and none.
  assert.deepEqual(lineCap({ byLine, newAt: -1 }, 10000, false, 'c1'), { shown: 2000, more: 'Show all 10,000 lines · 3 comments further down' })
  assert.deepEqual(lineCap({ byLine, newAt: -1 }, 10000, false, 'c4'), { shown: 2000, more: 'Show all 10,000 lines · 3 comments further down' })
  assert.deepEqual(lineCap({ byLine, newAt: -1 }, 10000, false, null), { shown: 2000, more: 'Show all 10,000 lines · 3 comments further down' })
})

test('review: what the phone sends is what the server takes, and a saved draft reads back as shown', () => {
  const { worktree, call } = reviewServer(undefined)
  const fresh = newCommentAt(BRANCH_SOURCE, 'src/a.ts', LINES_A[3])
  assert.equal(call('review.add', saveRequest(fresh, 'why 3?\r\nnot 2').params), null)
  assert.equal(worktree.review.revision, 1)
  const saved = worktree.review.comments[0]
  assert.equal(saved.body, 'why 3?\nnot 2')
  assert.deepEqual(fileReview(draftOnDiff(worktree.review, BRANCH_SOURCE, ['src/a.ts']).byPath.get('src/a.ts'), LINES_A, null).byLine.get(3), [saved])
  // An edit guarded by the body it began from; then one from a stale body conflicts and keeps both.
  const edit = editOf(saved)
  assert.equal(call('review.edit', saveRequest(edit, 'better').params), null)
  assert.equal(worktree.review.comments[0].body, 'better')
  assert.equal(isReviewConflict(call('review.edit', saveRequest(edit, 'mine').params)), true)
  const conflicted = editConflicted(edit, worktree.review)
  assert.deepEqual(conflicted, { kind: 'edit', commentId: saved.id, expected: 'better', conflict: true })
  // The next save overwrites the body shown, knowingly.
  assert.equal(call('review.edit', saveRequest(conflicted, 'mine').params), null)
  assert.equal(worktree.review.comments[0].body, 'mine')
})

test("review: after an edit's conflict the box keeps going, guarded by the comment's body now", () => {
  const edit = editOf(onAdded)
  const theirs = { revision: 7, comments: [onRemoved, { ...onAdded, body: 'theirs' }] }
  const conflicted = editConflicted(edit, theirs)
  assert.deepEqual(conflicted, { kind: 'edit', commentId: 'c1', expected: 'theirs', conflict: true })
  assert.deepEqual(edit, { kind: 'edit', commentId: 'c1', expected: 'body of c1', conflict: false })
  // Changed once more before that save.
  assert.deepEqual(editConflicted(conflicted, { revision: 8, comments: [{ ...onAdded, body: 'theirs again' }] }).expected, 'theirs again')
  // The comment went meanwhile (sent, deleted): nothing to edit.
  assert.equal(editConflicted(edit, { revision: 8, comments: [onRemoved] }), null)
  assert.equal(editConflicted(edit, undefined), null)
})

test('review: a conflict on an edit whose text the comment already has is that edit, done: the box closes', () => {
  // The reply to the first Save was lost (TIMEOUT, NOT_CONNECTED) though the server applied it;
  // Save again is then refused, as the comment is no longer the body the edit began from.
  const { worktree, call } = reviewServer({ revision: 6, comments: [onAdded] })
  const edit = editOf(onAdded)
  assert.equal(call('review.edit', saveRequest(edit, 'mine\r\nnow').params), null)
  assert.equal(isReviewConflict(call('review.edit', saveRequest(edit, 'mine\r\nnow').params)), true)
  assert.equal(editConflicted(edit, worktree.review, 'mine\r\nnow'), null)
  // Compared as Save sends it (line breaks as LF), and nothing else: other text is a conflict.
  assert.equal(editConflicted(edit, worktree.review, 'mine\rnow'), null)
  assert.deepEqual(editConflicted(edit, worktree.review, 'mine now'), { kind: 'edit', commentId: 'c1', expected: 'mine\nnow', conflict: true })
  assert.deepEqual(editConflicted(edit, worktree.review, 'mine\nnow '), { kind: 'edit', commentId: 'c1', expected: 'mine\nnow', conflict: true })
  // Without the text (as before) it is a conflict.
  assert.deepEqual(editConflicted(edit, worktree.review), { kind: 'edit', commentId: 'c1', expected: 'mine\nnow', conflict: true })
})

test('review: Send and Discard ask about a comment that is being written and not saved', () => {
  const fresh = newCommentAt(BRANCH_SOURCE, 'src/a.ts', LINES_A[3])
  const edit = editOf(onAdded)
  const unsaved = { title: 'Your comment is not saved', message: 'Send the review without it? What you typed is discarded.', confirm: 'Send without it' }
  // Send asks nothing with no box, a blank new comment or an edit that changed nothing.
  assert.equal(sendQuestion(null, 'x'), null)
  assert.equal(sendQuestion(fresh, ' \n'), null)
  assert.equal(sendQuestion(edit, 'body of c1'), null)
  assert.deepEqual(sendQuestion(fresh, 'x'), unsaved)
  assert.deepEqual(sendQuestion(edit, 'body of c1, better'), unsaved)

  // Discard always asks; one question, which says so when a comment being written goes too.
  const plain = { title: 'Discard 3 comments?', message: 'The review is deleted, on the desktop too. This cannot be undone.', confirm: 'Discard' }
  assert.deepEqual(discardQuestion(3, null, ''), plain)
  assert.deepEqual(discardQuestion(3, fresh, ''), plain)
  assert.deepEqual(discardQuestion(3, edit, 'body of c1'), plain)
  assert.equal(discardQuestion(1, null, '').title, 'Discard 1 comment?')
  const both = { title: 'Discard 3 comments?', message: 'The review is deleted, on the desktop too. The comment you are writing is not saved, and is discarded too. This cannot be undone.', confirm: 'Discard' }
  assert.deepEqual(discardQuestion(3, fresh, 'x'), both)
  assert.deepEqual(discardQuestion(3, edit, ''), both)
})

test('review: a box that closes under the user says why, with what was typed', () => {
  const paths = ['src/a.ts', 'src/b.ts']
  const fresh = newCommentAt(BRANCH_SOURCE, 'src/a.ts', LINES_A[3])
  const edit = editOf(onUncommitted)
  const without = { revision: 7, comments: [onAdded] }
  // Nothing closes: the same object, nothing said.
  assert.deepEqual(boxAfter(null, 'x', DRAFT, BRANCH_SOURCE, paths), { editor: null, notice: null })
  assert.equal(boxAfter(fresh, 'x', undefined, BRANCH_SOURCE, paths).editor, fresh)
  assert.equal(boxAfter(fresh, 'x', undefined, BRANCH_SOURCE, paths).notice, null)
  assert.equal(boxAfter(edit, 'x', DRAFT, BRANCH_SOURCE, paths).editor, edit)
  assert.equal(boxAfter(edit, 'x', DRAFT, BRANCH_SOURCE, []).editor, edit)

  // An edit whose comment went (sent, discarded or deleted on the desktop): the text typed is kept in the line.
  assert.deepEqual(boxAfter(edit, 'mine\nand more', without, BRANCH_SOURCE, paths), {
    editor: null,
    notice: 'The comment you were editing is no longer in the review.\nYou had written: mine\nand more'
  })
  assert.deepEqual(boxAfter(edit, 'mine', undefined, BRANCH_SOURCE, null), { editor: null, notice: 'The comment you were editing is no longer in the review.\nYou had written: mine' })
  // Emptied: it says so, with nothing to keep.
  assert.deepEqual(boxAfter(edit, ' ', without, BRANCH_SOURCE, paths), { editor: null, notice: 'The comment you were editing is no longer in the review.' })
  // Nothing changed in the box: it just closes.
  assert.deepEqual(boxAfter(edit, 'body of c4', without, BRANCH_SOURCE, paths), { editor: null, notice: null })

  // A new comment whose file a refresh took out of the diff: no row is left to draw its box in.
  assert.deepEqual(boxAfter(fresh, 'why 3?', DRAFT, BRANCH_SOURCE, ['src/b.ts']), {
    editor: null,
    notice: 'The file you were commenting on is no longer in this diff.\nYou had written: why 3?'
  })
  assert.deepEqual(boxAfter(fresh, '', DRAFT, BRANCH_SOURCE, []), { editor: null, notice: 'The file you were commenting on is no longer in this diff.' })
  // The file list is not there to judge by (not loaded yet): the box stays.
  assert.equal(boxAfter(fresh, 'why 3?', DRAFT, BRANCH_SOURCE, null).editor, fresh)
  // Another source is shown: the screen asked before showing it, so the box closes and nothing is said.
  assert.deepEqual(boxAfter(fresh, 'why 3?', DRAFT, UNCOMMITTED, ['src/b.ts']), { editor: null, notice: null })
  assert.deepEqual(boxAfter(fresh, 'why 3?', DRAFT, UNCOMMITTED, null), { editor: null, notice: null })

  // Where editorAfter closes or keeps a box, so does this.
  for (const [editor, draft, source] of [[fresh, DRAFT, BRANCH_SOURCE], [fresh, DRAFT, UNCOMMITTED], [edit, DRAFT, BRANCH_SOURCE], [edit, without, BRANCH_SOURCE], [null, DRAFT, BRANCH_SOURCE]]) {
    assert.equal(boxAfter(editor, 'x', draft, source, paths).editor, editorAfter(editor, draft, source))
  }
})

test("review: a file's header says a comment is being written on it, open or not", () => {
  const fresh = newCommentAt(BRANCH_SOURCE, 'src/a.ts', LINES_A[3])
  assert.equal(fileMark(fresh, BRANCH_SOURCE, 'src/a.ts', []), ' · writing a comment')
  assert.equal(fileMark(fresh, BRANCH_SOURCE, 'src/b.ts', []), '')
  assert.equal(fileMark(fresh, UNCOMMITTED, 'src/a.ts', []), '')
  // An edit: on the file whose comments (on the shown diff) hold the one being edited.
  assert.equal(fileMark(editOf(onRemoved), BRANCH_SOURCE, 'src/a.ts', [onAdded, onRemoved]), ' · writing a comment')
  assert.equal(fileMark(editOf(onUncommitted), BRANCH_SOURCE, 'src/a.ts', [onAdded, onRemoved]), '')
  assert.equal(fileMark(null, BRANCH_SOURCE, 'src/a.ts', [onAdded]), '')
})

test("review: a draft goes to one of a loaded worktree's open sessions, newest first", () => {
  const session = (id, status, over = {}) => ({ id, title: `Session ${id}`, status, queue: [], ptyId: `pty-${id}`, ...over })
  const worktree = { loaded: true, sessions: [session('s1', 'idle'), session('s2', 'exited'), session('s3', 'working'), session('s4', 'done', { ptyId: undefined })] }
  assert.deepEqual(sendTargets(worktree), [
    { sessionId: 's3', title: 'Session s3', status: 'working' },
    { sessionId: 's1', title: 'Session s1', status: 'idle' }
  ])
  assert.deepEqual(sendTargets({ ...worktree, loaded: false }), [])
  assert.deepEqual(sendTargets({ loaded: true, sessions: [] }), [])
  assert.equal(noTargetsText(true), 'Start a session in this worktree to send the review to')
  assert.equal(noTargetsText(false), 'Load the worktree to send the review to one of its sessions')
})

test("review: a commit's row is its subject, then its short sha, author and age", () => {
  const now = 1_700_000_000_000
  assert.deepEqual(commitRow({ sha: SHA_A, subject: 'Fix the thing', author: 'Ann', at: now - 5 * 60_000 }, now), { title: 'Fix the thing', detail: 'aaaaaaa · Ann · 5 min ago' })
  assert.deepEqual(commitRow({ sha: SHA_B, subject: '', author: '', at: now - 3 * 86_400_000 }, now), { title: '(no subject)', detail: 'bbbbbbb · 3 d ago' })
})

// ── Pull request watch ───────────────────────────────────────────────────────────────────────

test('pr watch: a branch is watched while it has a pull request and a watch', () => {
  assert.equal(isWatching(undefined), false)
  assert.equal(isWatching({}), false)
  assert.equal(isWatching({ pr: 'https://github.com/o/r/pull/1' }), false)
  // `{}` until its first poll, then `{seen}`.
  assert.equal(isWatching({ pr: 'https://github.com/o/r/pull/1', prWatch: {} }), true)
  assert.equal(isWatching({ pr: 'https://github.com/o/r/pull/1', prWatch: { seen: { checks: 'abc SUCCESS', conflict: false } } }), true)
  assert.equal(isWatching({ prWatch: {} }), false)
})

test('pr watch: the switch is offered for a linked pull request when gh is signed in, or to stop a watch', () => {
  const pr = 'https://github.com/o/r/pull/1'
  const cases = [
    // data, capable, offered, suffix, action
    [undefined, true, false, '', { label: 'Watch', watch: true }],
    [{}, true, false, '', { label: 'Watch', watch: true }],
    [{ pr }, false, false, '', { label: 'Watch', watch: true }],
    [{ pr }, true, true, '', { label: 'Watch', watch: true }],
    [{ pr, prWatch: {} }, true, true, ' · watching', { label: 'Stop watching', watch: false }],
    [{ pr, prWatch: {} }, false, true, ' · watch paused, gh signed out', { label: 'Stop watching', watch: false }],
    [{ prWatch: {} }, true, false, '', { label: 'Watch', watch: true }]
  ]
  for (const [data, capable, offered, suffix, action] of cases) {
    const what = `${JSON.stringify(data)} capable=${capable}`
    assert.equal(watchOffered(data, capable), offered, what)
    assert.equal(watchSuffix(data, capable), suffix, what)
    assert.deepEqual(watchAction(data), action, what)
  }
})

test("pr watch: the server's refusals of a watch, as the section's error line shows them", () => {
  const data = {}
  const project = { id: 'p1', repositories: [{ id: 'r1', branchData: { feat: data }, worktrees: [] }] }
  const ctx = (signedIn) => ({ prWatch: { available: () => signedIn, pollSoon() {}, forget() {} }, projects: { apply: (_id, fn) => fn(project) } })
  const call = (signedIn, watch) => {
    try {
      prWatchHandlers['branch.setPrWatch']({ projectId: 'p1', repoId: 'r1', branch: 'feat', watch }, ctx(signedIn))
      return null
    } catch (err) {
      const wire = toWireError('branch.setPrWatch', err)
      return new ClientError(wire.code, wire.message, wire.details)
    }
  }
  const signedOut = call(false, true)
  assert.equal(signedOut.code, 'TOOL_ERROR')
  assert.match(signedOut.message, /^gh is not installed or not signed in on the Trek server/)
  const noPr = call(true, true)
  assert.equal(noPr.code, 'BAD_REQUEST')
  assert.equal(noPr.message, 'feat has no linked pull request')
  data.pr = 'https://dev.azure.com/o/p/_git/r/pullrequest/9'
  const notGitHub = call(true, true)
  assert.equal(notGitHub.code, 'BAD_REQUEST')
  assert.match(notGitHub.message, /is not a GitHub pull request URL/)
})

test('pr watch: a notice on a card is one line; its age is on the phone\'s clock', () => {
  const now = 1_700_000_000_000
  const notice = { title: 'PR #12', text: 'Checks failed: build, lint', url: 'https://github.com/o/r/pull/12', at: now - 3 * 60_000 }
  assert.equal(noticeLine(notice), 'PR #12: Checks failed: build, lint')
  assert.equal(noticeLine({ ...notice, text: 'Can’t be read:\n gh said no ' }), 'PR #12: Can’t be read: gh said no')
  assert.equal(noticeAge(notice, now), '3 min ago')
  // The server's clock ahead of the phone's.
  assert.equal(noticeAge({ ...notice, at: now + 60_000 }, now), 'just now')
})

test('pr watch: only a pull request item of a worktree can be dismissed from the Attention list', () => {
  const entry = { projectId: 'p1', worktreeId: 'w1', sessionId: '', title: 'PR #12', status: 'attention', since: 1, projectName: 'Trek', pullRequest: { text: 'Merged', url: 'https://github.com/o/r/pull/12' } }
  assert.deepEqual(noticeDismissal(entry), { projectId: 'p1', worktreeId: 'w1' })
  assert.equal(noticeDismissal({ ...entry, pullRequest: undefined, sessionId: 's1' }), null)
  assert.equal(noticeDismissal({ ...entry, worktreeId: null }), null)
})
