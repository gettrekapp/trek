// trek-relay's push services (6b), against local stubs only: APNs over HTTP/2 with an ES256
// provider token, FCM v1 with a service-account assertion traded for an access token, and what
// each one's answers mean (sent, the token gone, a refusal).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey } from 'node:crypto'
import { ApnsProvider, collapseId } from '../relay/src/apns.ts'
import { FcmProvider } from '../relay/src/fcm.ts'
import { ApnsToken, APNS_TOKEN_TTL_MS } from '../relay/src/jwt.ts'
import { readJwt, startApnsStub, startFcmStub, testApnsKey, testServiceAccount } from './relayStubs.mjs'

const device = (pushToken, platform = 'ios', extra = {}) => ({ id: 'd1', platform, pushToken, secretHash: 'x', createdAt: 0, ...extra })
const message = { title: 'Trek · app', body: 'A decision is waiting', kind: 'decision', data: { serverId: 's', projectId: 'p', sessionId: 'x' } }

test('apns: provider token is ES256 signed by the .p8 key, cached for 50 minutes', () => {
  const { pem, publicKey } = testApnsKey()
  let now = 1_700_000_000_000
  const token = new ApnsToken(createPrivateKey(pem), 'KEY123', 'TEAM456', () => now)
  const first = token.get()
  const jwt = readJwt(first, publicKey, 'ES256')
  assert.ok(jwt.ok)
  assert.deepEqual(jwt.header, { alg: 'ES256', typ: 'JWT', kid: 'KEY123' })
  assert.deepEqual(jwt.claims, { iss: 'TEAM456', iat: 1_700_000_000 })
  now += APNS_TOKEN_TTL_MS - 1
  assert.equal(token.get(), first)
  now += 1
  assert.notEqual(token.get(), first)
})

test('apns: sends an alert with the topic, the words and the ids (under body); reads 410 as gone', async (t) => {
  const stub = await startApnsStub()
  t.after(() => stub.close())
  const { pem } = testApnsKey()
  const logs = []
  const apns = new ApnsProvider({ origin: stub.origin, bundleId: 'app.trek.mobile', token: new ApnsToken(createPrivateKey(pem), 'K', 'T'), now: () => 1_700_000_000_000, log: (l) => logs.push(l) })
  t.after(() => apns.close())
  assert.equal(await apns.send(device('abc123'), message), 'sent')
  const p = stub.pushes[0]
  assert.equal(p.path, '/3/device/abc123')
  assert.equal(p.headers['apns-topic'], 'app.trek.mobile')
  assert.equal(p.headers['apns-push-type'], 'alert')
  assert.match(p.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  assert.deepEqual(p.body, { aps: { alert: { title: 'Trek · app', body: 'A decision is waiting' }, sound: 'default' }, body: { kind: 'decision', serverId: 's', projectId: 'p', sessionId: 'x' } })
  assert.equal(p.headers['apns-expiration'], String(1_700_000_000 + 3600), 'from the injected clock')
  assert.equal(p.headers['apns-collapse-id'], 's:p:decision')
  stub.respond = () => ({ status: 410, reason: 'Unregistered' })
  assert.equal(await apns.send(device('abc123'), message), 'dead')
  stub.respond = () => ({ status: 429, reason: 'TooManyRequests' })
  assert.equal(await apns.send(device('abc123'), message), 'unavailable')
  stub.respond = () => ({ status: 503, reason: 'ServiceUnavailable' })
  assert.equal(await apns.send(device('abc123'), message), 'unavailable')
  stub.respond = () => ({ status: 400, reason: 'BadPriority' })
  assert.equal(await apns.send(device('abc123'), message), 'rejected')
  assert.equal(logs.some((l) => /CONFIG ERROR/.test(l)), false)
})

test('apns: BadDeviceToken is gone only after a delivery; topic and environment errors are config errors, logged loudly', async (t) => {
  const stub = await startApnsStub()
  t.after(() => stub.close())
  const { pem } = testApnsKey()
  const logs = []
  const apns = new ApnsProvider({ origin: stub.origin, bundleId: 'app.trek.mobile', production: true, token: new ApnsToken(createPrivateKey(pem), 'K', 'T'), log: (l) => logs.push(l) })
  t.after(() => apns.close())
  stub.respond = () => ({ status: 400, reason: 'BadDeviceToken' })
  assert.equal(await apns.send(device('abc'), message), 'rejected', 'never delivered: likely a sandbox token sent to production')
  assert.match(logs.at(-1), /APNS CONFIG ERROR.*app\.trek\.mobile.*production/)
  assert.equal(await apns.send(device('abc', 'ios', { delivered: true }), message), 'dead')
  for (const reason of ['DeviceTokenNotForTopic', 'BadTopic', 'TopicDisallowed', 'BadCertificateEnvironment']) {
    logs.length = 0
    stub.respond = () => ({ status: 400, reason })
    assert.equal(await apns.send(device('abc', 'ios', { delivered: true }), message), 'rejected', reason)
    assert.match(logs[0], new RegExp(`APNS CONFIG ERROR: APNs answered ${reason}`))
  }
})

test('apns: collapse id is serverId:projectId:kind, hashed past 64 bytes', () => {
  assert.equal(collapseId('srv', 'proj', 'decision'), 'srv:proj:decision')
  const long = collapseId('s'.repeat(60), 'p', 'decision')
  assert.match(long, /^[0-9a-f]{64}$/)
})

test('apns: a push that gets no answer destroys the session; the next push opens a new one; an idle session is not reused', async (t) => {
  const stub = await startApnsStub()
  t.after(() => stub.close())
  const { pem } = testApnsKey()
  let now = 0
  const apns = new ApnsProvider({ origin: stub.origin, bundleId: 'b', token: new ApnsToken(createPrivateKey(pem), 'K', 'T'), timeoutMs: 200, idleMs: 60_000, now: () => now })
  t.after(() => apns.close())
  assert.equal(await apns.send(device('tok'), message), 'sent')
  assert.equal(stub.sessionsOpened(), 1)
  assert.equal(await apns.send(device('tok'), message), 'sent')
  assert.equal(stub.sessionsOpened(), 1, 'reused while fresh')
  stub.respond = () => ({ hang: true })
  assert.equal(await apns.send(device('tok'), message), 'unavailable')
  stub.respond = () => ({ status: 200 })
  assert.equal(await apns.send(device('tok'), message), 'sent')
  assert.equal(stub.sessionsOpened(), 2, 'a new connection after the timeout')
  now += 60_001
  assert.equal(await apns.send(device('tok'), message), 'sent')
  assert.equal(stub.sessionsOpened(), 3, 'an idle connection is replaced')
})

test('apns: ExpiredProviderToken re-signs and retries once', async (t) => {
  const stub = await startApnsStub()
  t.after(() => stub.close())
  const { pem } = testApnsKey()
  let calls = 0
  stub.respond = () => (++calls === 1 ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 })
  let now = 0
  const apns = new ApnsProvider({ origin: stub.origin, bundleId: 'b', token: new ApnsToken(createPrivateKey(pem), 'K', 'T', () => (now += 1000)) })
  t.after(() => apns.close())
  assert.equal(await apns.send(device('tok'), message), 'sent')
  assert.equal(stub.pushes.length, 2)
  assert.notEqual(stub.pushes[0].headers.authorization, stub.pushes[1].headers.authorization)
})

test('fcm: trades a signed assertion for an access token (cached), then sends the message', async (t) => {
  const stub = await startFcmStub()
  t.after(() => stub.close())
  const { account, publicKey } = testServiceAccount()
  const fcm = new FcmProvider({ account, fcmOrigin: stub.origin, oauthOrigin: stub.origin })
  assert.equal(await fcm.send(device('fcm-tok', 'android'), message), 'sent')
  assert.equal(await fcm.send(device('fcm-tok', 'android'), message), 'sent')
  assert.equal(stub.tokensIssued(), 1, 'the access token is reused')
  const jwt = readJwt(stub.assertions[0], publicKey, 'RS256')
  assert.ok(jwt.ok)
  assert.equal(jwt.claims.iss, account.client_email)
  assert.equal(jwt.claims.aud, account.token_uri)
  assert.equal(jwt.claims.scope, 'https://www.googleapis.com/auth/firebase.messaging')
  const m = stub.messages[0]
  assert.equal(m.url, '/v1/projects/trek-test/messages:send')
  assert.equal(m.authorization, 'Bearer access-1')
  assert.deepEqual(m.body.message.notification, { title: 'Trek · app', body: 'A decision is waiting' })
  assert.deepEqual(m.body.message.data, { kind: 'decision', serverId: 's', projectId: 'p', sessionId: 'x' }, "the same keys as APNs' body")
  assert.deepEqual(m.body.message.android, { priority: 'high', notification: { channel_id: 'default' } })
  assert.equal(m.body.message.token, 'fcm-tok')
})

test('fcm: UNREGISTERED is gone, a 401 re-fetches the token once, other errors fail', async (t) => {
  const stub = await startFcmStub()
  t.after(() => stub.close())
  const { account } = testServiceAccount()
  const fcm = new FcmProvider({ account, fcmOrigin: stub.origin, oauthOrigin: stub.origin })
  stub.respond = () => ({ status: 404, error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })
  assert.equal(await fcm.send(device('t', 'android'), message), 'dead')
  let calls = 0
  stub.respond = () => (++calls === 1 ? { status: 401, error: { status: 'UNAUTHENTICATED' } } : { status: 200 })
  assert.equal(await fcm.send(device('t', 'android'), message), 'sent')
  assert.equal(stub.tokensIssued(), 2)
  stub.respond = () => ({ status: 400, error: { status: 'INVALID_ARGUMENT' } })
  assert.equal(await fcm.send(device('t', 'android'), message), 'rejected')
  stub.respond = () => ({ status: 403, error: { status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } })
  assert.equal(await fcm.send(device('t', 'android'), message), 'dead')
  stub.respond = () => ({ status: 429, error: { status: 'RESOURCE_EXHAUSTED', details: [{ errorCode: 'QUOTA_EXCEEDED' }] } })
  assert.equal(await fcm.send(device('t', 'android'), message), 'unavailable')
  stub.respond = () => ({ status: 503, error: { status: 'UNAVAILABLE' } })
  assert.equal(await fcm.send(device('t', 'android'), message), 'unavailable')
})

test('fcm: concurrent pushes share one token exchange', async (t) => {
  const stub = await startFcmStub()
  t.after(() => stub.close())
  stub.tokenDelayMs = 100
  const { account } = testServiceAccount()
  const fcm = new FcmProvider({ account, fcmOrigin: stub.origin, oauthOrigin: stub.origin })
  const results = await Promise.all([1, 2, 3, 4].map(() => fcm.send(device('t', 'android'), message)))
  assert.deepEqual(results, ['sent', 'sent', 'sent', 'sent'])
  assert.equal(stub.tokensIssued(), 1)
})
