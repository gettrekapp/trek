// Background push on the server (6b): a phone's grant (write-only, per token, in the secrets file),
// and the pusher: which attention it pushes, the phone's switches and pause, skipping a connected
// token, coalescing, retries, and dropping a grant the relay refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretFile } from '../server/src/secrets.ts'
import { PushGrants, checkRelayUrl, checkSetGrant } from '../server/src/push/grants.ts'
import { COALESCE_MS, MAX_HELD_WHILE_CONNECTED, MAX_RETRY_AFTER_MS, Pusher, prPushKind } from '../server/src/push/pusher.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'

const SECRET = 'g'.repeat(43)
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-push-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function grantsIn(t, names = ['phone-a', 'phone-b']) {
  const path = join(temp(t), 'secrets.json')
  const tokens = { names }
  return { grants: new PushGrants(createSecretFile(path), () => tokens.names), path, tokens }
}

const grant = (extra = {}) => ({ relayUrl: 'https://relay.example', grantSecret: SECRET, kinds: { decisions: true, sessions: true, prWatch: true }, paused: false, ...extra })

function harness(t, { names = ['phone-a'], respond = () => 202, headers = {} } = {}) {
  const hub = new TopicHub()
  hub.publish('attention', { entries: [] })
  const { grants } = grantsIn(t, names)
  const posts = []
  const connected = new Set()
  const slept = []
  let now = 1_000_000
  const fetch = async (url, init) => {
    const status = typeof respond === 'function' ? respond(posts.length) : respond
    posts.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body), redirect: init.redirect })
    if (status === 'throw') throw new Error('connection refused')
    if (typeof status === 'object') return status
    return new Response(null, { status, headers })
  }
  const pusher = new Pusher({ hub, grants, isConnected: (n) => connected.has(n), serverId: () => 'srv-1', fetch, now: () => now, sleep: async (ms) => void slept.push(ms), log: () => {} })
  pusher.start()
  t.after(() => pusher.stop())
  return {
    hub,
    grants,
    posts,
    connected,
    pusher,
    slept,
    advance: (ms) => (now += ms),
    attention: (entries) => hub.publish('attention', { entries })
  }
}

const decisionEntry = (at = 5) => ({ projectId: 'p1', worktreeId: 'w1', sessionId: 's1', title: 'Agent', status: 'working', since: at, projectName: 'trek-app', decision: { question: 'Merge it?', at } })
const doneEntry = (since = 7) => ({ projectId: 'p1', worktreeId: 'w1', sessionId: 's2', title: 'Agent', status: 'done', since, projectName: 'trek-app' })
const prEntry = { projectId: 'p1', worktreeId: 'w1', sessionId: '', title: 'PR #3', status: 'attention', since: 9, projectName: 'trek-app', pullRequest: { text: 'checks failed', url: 'https://x' } }

test('relay URL: https, or http only on loopback; no credentials, query or fragment', () => {
  assert.equal(checkRelayUrl('https://relay.example/'), 'https://relay.example')
  assert.equal(checkRelayUrl('http://127.0.0.1:7346'), 'http://127.0.0.1:7346')
  assert.equal(checkRelayUrl('http://localhost:7346'), 'http://localhost:7346')
  assert.equal(checkRelayUrl('http://[::1]:7346'), 'http://[::1]:7346')
  assert.equal(checkRelayUrl('http://127.0.0.2:7346'), 'http://127.0.0.2:7346', "6a's loopback rule: all of 127/8")
  for (const bad of ['http://relay.example', 'http://192.168.1.4:7346', 'http://127.0.0.1.example', 'ftp://x', 'https://u:p@relay.example', 'https://relay.example/?a=1', 'nope', 'x'.repeat(600)]) {
    assert.throws(() => checkRelayUrl(bad), /relayUrl/, bad)
  }
  assert.deepEqual(checkSetGrant({ relayUrl: 'https://r.example', grantSecret: SECRET }).kinds, { decisions: true, sessions: true, prWatch: true })
  assert.throws(() => checkSetGrant({ relayUrl: 'https://r.example', grantSecret: 'short' }), /grantSecret/)
  assert.throws(() => checkSetGrant({ relayUrl: 'https://r.example', grantSecret: SECRET, kinds: { decisions: 'yes' } }), /kinds\.decisions/)
})

test('grants: per token in the secrets file (0600), status never shows the secret, a revoked token loses its grant', (t) => {
  const { grants, path, tokens } = grantsIn(t)
  grants.set('phone-a', grant({ paused: true }))
  grants.set('phone-b', grant())
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const status = grants.status('phone-a')
  assert.deepEqual(status, { relayUrl: 'https://relay.example', kinds: { decisions: true, sessions: true, prWatch: true }, paused: true, active: true })
  assert.ok(!JSON.stringify(status).includes(SECRET))
  assert.equal(grants.status('phone-c'), null)
  tokens.names = ['phone-b']
  assert.equal(grants.retain(new Set(tokens.names)), 1)
  assert.ok(!readFileSync(path, 'utf8').includes('push:phone-a'))
  assert.equal(grants.status('phone-b').active, true)
  grants.refused('phone-b', 'gone', 'some-older-secret')
  assert.equal(grants.status('phone-b').active, true, 'a refusal of an older secret leaves the grant alone')
  grants.refused('phone-b', 'gone', SECRET)
  assert.deepEqual([grants.status('phone-b').active, grants.status('phone-b').lastError], [false, 'gone'])
  assert.equal(grants.active().length, 0)
})

test('push.* over v2: write-only, per calling token, NOT_FOUND without push', (t) => {
  const { grants } = grantsIn(t)
  const ctx = { push: { grants }, tokenName: 'phone-a' }
  assert.deepEqual(dispatchV2('push.setGrant', { relayUrl: 'https://relay.example', grantSecret: SECRET, kinds: { prWatch: false } }, ctx), { ok: true, result: null })
  const status = dispatchV2('push.status', {}, ctx)
  assert.equal(status.result.kinds.prWatch, false)
  assert.ok(!JSON.stringify(status).includes(SECRET))
  assert.equal(dispatchV2('push.status', {}, { ...ctx, tokenName: 'phone-b' }).result, null, "another token doesn't see it")
  assert.equal(dispatchV2('push.setGrant', { relayUrl: 'http://relay.example', grantSecret: SECRET }, ctx).error.code, 'BAD_REQUEST')
  dispatchV2('push.clearGrant', {}, ctx)
  assert.equal(dispatchV2('push.status', {}, ctx).result, null)
  assert.equal(dispatchV2('push.status', {}, { tokenName: 'phone-a' }).error.code, 'NOT_FOUND')
})

test('pusher: a new decision and a session waiting push once each, with only the kind, project and ids', async (t) => {
  const h = harness(t)
  h.grants.set('phone-a', grant())
  h.attention([decisionEntry()])
  h.attention([decisionEntry(), doneEntry()])
  h.attention([decisionEntry(), doneEntry()])
  await h.pusher.idle()
  assert.deepEqual(h.posts.map((p) => p.body.kind), ['decision', 'session-finished'])
  assert.equal(h.posts[0].url, 'https://relay.example/v1/push')
  assert.equal(h.posts[0].auth, `Bearer ${SECRET}`)
  assert.equal(h.posts[0].redirect, 'error', 'a relay redirect is never followed')
  assert.deepEqual(h.posts[0].body, { kind: 'decision', project: 'trek-app', data: { serverId: 'srv-1', projectId: 'p1', worktreeId: 'w1', sessionId: 's1' } })
  assert.ok(!JSON.stringify(h.posts).includes('Merge it?'), "the decision's question never leaves the server")
})

test('pusher: what was already listed at start, and pull request entries, are not pushed from attention', async (t) => {
  const hub = new TopicHub()
  hub.publish('attention', { entries: [decisionEntry()] })
  const { grants } = grantsIn(t, ['phone-a'])
  grants.set('phone-a', grant())
  const posts = []
  const pusher = new Pusher({ hub, grants, isConnected: () => false, serverId: () => 's', fetch: async (u, i) => (posts.push(i), new Response(null, { status: 202 })), sleep: async () => {} })
  pusher.start()
  t.after(() => pusher.stop())
  hub.publish('attention', { entries: [decisionEntry(), prEntry] })
  await pusher.idle()
  assert.equal(posts.length, 0)
})

test('pusher: the switches, pause and a connected token stop a push', async (t) => {
  const h = harness(t, { names: ['phone-a', 'phone-b', 'phone-c'] })
  h.grants.set('phone-a', grant({ kinds: { decisions: false, sessions: true, prWatch: true } }))
  h.grants.set('phone-b', grant({ paused: true }))
  h.grants.set('phone-c', grant())
  h.connected.add('phone-c')
  h.attention([decisionEntry()])
  await h.pusher.idle()
  assert.equal(h.posts.length, 0)
  h.connected.delete('phone-c')
  h.attention([decisionEntry(), doneEntry()])
  await h.pusher.idle()
  assert.deepEqual(h.posts.map((p) => p.body.kind).sort(), ['session-finished', 'session-finished'], 'phone-a (sessions on) and phone-c')
})

test('pusher: one push per token, project and kind in 30 seconds', async (t) => {
  const h = harness(t)
  h.grants.set('phone-a', grant())
  h.pusher.notify({ kind: 'session-stopped', projectId: 'p1', projectName: 'a', sessionId: 's1' })
  h.pusher.notify({ kind: 'session-stopped', projectId: 'p1', projectName: 'a', sessionId: 's2' })
  h.pusher.notify({ kind: 'session-stopped', projectId: 'p2', projectName: 'b', sessionId: 's3' })
  await h.pusher.idle()
  h.advance(COALESCE_MS)
  h.pusher.notify({ kind: 'session-stopped', projectId: 'p1', projectName: 'a', sessionId: 's4' })
  await h.pusher.idle()
  assert.deepEqual(h.posts.map((p) => p.body.data.sessionId), ['s1', 's3', 's4'])
})

test('pusher: retries a network error or 5xx, drops a grant the relay refuses, records a 429', async (t) => {
  const flaky = harness(t, { respond: (n) => (n < 2 ? (n === 0 ? 'throw' : 503) : 202) })
  flaky.grants.set('phone-a', grant())
  flaky.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
  await flaky.pusher.idle()
  assert.equal(flaky.posts.length, 3)
  assert.equal(flaky.grants.status('phone-a').lastError, undefined)

  const gone = harness(t, { respond: 410 })
  gone.grants.set('phone-a', grant())
  gone.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
  await gone.pusher.idle()
  assert.equal(gone.grants.status('phone-a').active, false)
  assert.match(gone.grants.status('phone-a').lastError, /grant again/)
  gone.advance(COALESCE_MS)
  gone.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
  await gone.pusher.idle()
  assert.equal(gone.posts.length, 1, 'a dropped grant pushes no more')

  const limited = harness(t, { respond: 429 })
  limited.grants.set('phone-a', grant())
  limited.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
  await limited.pusher.idle()
  assert.equal(limited.posts.length, 1)
  assert.match(limited.grants.status('phone-a').lastError, /429/)
  assert.equal(limited.grants.status('phone-a').active, true)
})

test('pull request reports push their most pressing event', () => {
  assert.equal(prPushKind([{ kind: 'checksPassed' }, { kind: 'comments', count: 2 }]), 'pr-review')
  assert.equal(prPushKind([{ kind: 'checksFailed', names: [] }, { kind: 'conflict' }]), 'pr-conflict')
  assert.equal(prPushKind([{ kind: 'merged' }]), 'pr-merged')
  assert.equal(prPushKind([]), undefined)
})

test('pusher: 503 retries honouring Retry-After (capped), 422 and other 4xx are not retried', async (t) => {
  const busy = harness(t, { respond: (n) => (n < 2 ? 503 : 202), headers: { 'retry-after': '7' } })
  busy.grants.set('phone-a', grant())
  busy.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
  await busy.pusher.idle()
  assert.equal(busy.posts.length, 3)
  assert.deepEqual(busy.slept, [7000, 7000])

  const long = harness(t, { respond: (n) => (n < 1 ? 503 : 202), headers: { 'retry-after': '3600' } })
  long.grants.set('phone-a', grant())
  long.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
  await long.pusher.idle()
  assert.deepEqual(long.slept, [MAX_RETRY_AFTER_MS])

  for (const status of [422, 400, 500, 502]) {
    const h = harness(t, { respond: status })
    h.grants.set('phone-a', grant())
    h.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
    await h.pusher.idle()
    assert.equal(h.posts.length, 1, `${status} is not retried`)
    assert.equal(h.grants.status('phone-a').active, true)
    assert.ok(h.grants.status('phone-a').lastError, `${status} is recorded`)
  }
})

test('pusher: a refusal or a result for a secret the phone has since replaced leaves the new grant alone', async (t) => {
  let release
  const gate = new Promise((r) => (release = r))
  const NEW = 'n'.repeat(43)
  const h = harness(t, { respond: () => gate.then(() => new Response(null, { status: 410 })) })
  h.grants.set('phone-a', grant())
  h.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
  // While the push is on its way, the phone grants again.
  h.grants.set('phone-a', grant({ grantSecret: NEW }))
  release()
  await h.pusher.idle()
  assert.equal(h.grants.status('phone-a').active, true)
  assert.equal(h.grants.get('phone-a').grantSecret, NEW)
  assert.equal(h.grants.status('phone-a').lastError, undefined)

  let release2
  const gate2 = new Promise((r) => (release2 = r))
  const h2 = harness(t, { respond: () => gate2.then(() => new Response(null, { status: 503 })) })
  h2.grants.set('phone-a', grant())
  h2.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
  h2.grants.set('phone-a', grant({ grantSecret: NEW }))
  release2()
  await h2.pusher.idle()
  assert.equal(h2.grants.status('phone-a').lastError, undefined, "the old secret's failure is not the new grant's")
})

test('pusher: the session kinds are one group per project; an exit right after "waiting" sends "stopped" only', async (t) => {
  const h = harness(t)
  h.grants.set('phone-a', grant())
  h.attention([doneEntry()])
  h.pusher.notify({ kind: 'session-stopped', projectId: 'p1', projectName: 'trek-app', worktreeId: 'w1', sessionId: 's2' })
  await h.pusher.idle()
  assert.deepEqual(h.posts.map((p) => p.body.kind), ['session-stopped'])
  h.advance(5_000)
  h.attention([doneEntry(99)])
  await h.pusher.idle()
  assert.equal(h.posts.length, 1, 'still inside the 30 seconds for the project')
  h.pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'trek-app' })
  await h.pusher.idle()
  assert.deepEqual(h.posts.map((p) => p.body.kind), ['session-stopped', 'decision'], 'decisions are their own group')
})

test('pusher: what arrived while the token was connected is pushed when its last connection closes, if still open', async (t) => {
  const h = harness(t)
  h.grants.set('phone-a', grant())
  h.connected.add('phone-a')
  const other = { ...decisionEntry(8), sessionId: 's9' }
  h.attention([decisionEntry(), other])
  await h.pusher.idle()
  assert.equal(h.posts.length, 0)
  h.attention([decisionEntry()]) // the other decision was answered
  h.connected.delete('phone-a')
  h.pusher.tokenDisconnected('phone-a')
  await h.pusher.idle()
  assert.deepEqual(h.posts.map((p) => [p.body.kind, p.body.data.sessionId]), [['decision', 's1']])
  h.pusher.tokenDisconnected('phone-a')
  await h.pusher.idle()
  assert.equal(h.posts.length, 1, 'once')

  const capped = harness(t, { names: ['phone-b'] })
  capped.grants.set('phone-b', grant())
  capped.connected.add('phone-b')
  const many = Array.from({ length: MAX_HELD_WHILE_CONNECTED + 5 }, (_, i) => ({ ...decisionEntry(i + 1), projectId: `p${i}`, sessionId: `s${i}` }))
  capped.attention(many)
  capped.connected.delete('phone-b')
  capped.pusher.tokenDisconnected('phone-b')
  await capped.pusher.idle()
  assert.equal(capped.posts.length, MAX_HELD_WHILE_CONNECTED, 'bounded, the newest kept')
  assert.equal(capped.posts[0].body.data.sessionId, 's5')
})

test('pusher: follows attention again after the topic ends; stop() aborts a push on its way', async (t) => {
  const h = harness(t)
  h.grants.set('phone-a', grant())
  h.hub.drop('attention')
  h.hub.publish('attention', { entries: [] })
  await new Promise((r) => setTimeout(r, 1_200))
  h.attention([decisionEntry()])
  await h.pusher.idle()
  assert.equal(h.posts.length, 1)

  const hub = new TopicHub()
  hub.publish('attention', { entries: [] })
  const { grants } = grantsIn(t, ['phone-a'])
  grants.set('phone-a', grant())
  let aborted = false
  const fetch = (_u, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true
        reject(new Error('aborted'))
      })
    })
  const pusher = new Pusher({ hub, grants, isConnected: () => false, serverId: () => 's', fetch, sleep: async () => {}, log: () => {} })
  pusher.start()
  pusher.notify({ kind: 'decision', projectId: 'p1', projectName: 'a' })
  pusher.stop()
  await pusher.idle()
  assert.equal(aborted, true)
  assert.equal(grants.status('phone-a').lastError, undefined, 'a stop is not a failure')
})
