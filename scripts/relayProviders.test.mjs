// trek-relay's push services (6b), against local stubs only: APNs over HTTP/2 with an ES256
// provider token, FCM v1 with a service-account assertion traded for an access token, and what
// each one's answers mean (sent, the token gone, a refusal).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey } from 'node:crypto'
import { ApnsProvider } from '../relay/src/apns.ts'
import { FcmProvider } from '../relay/src/fcm.ts'
import { ApnsToken, APNS_TOKEN_TTL_MS } from '../relay/src/jwt.ts'
import { readJwt, startApnsStub, startFcmStub, testApnsKey, testServiceAccount } from './relayStubs.mjs'

const device = (pushToken, platform = 'ios') => ({ id: 'd1', platform, pushToken, secretHash: 'x', createdAt: 0 })
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

test('apns: sends an alert with the topic, the words and the ids; reads 410 and BadDeviceToken as gone', async (t) => {
  const stub = await startApnsStub()
  t.after(() => stub.close())
  const { pem } = testApnsKey()
  const apns = new ApnsProvider({ origin: stub.origin, bundleId: 'app.trek.mobile', token: new ApnsToken(createPrivateKey(pem), 'K', 'T') })
  t.after(() => apns.close())
  assert.equal(await apns.send(device('abc123'), message), 'sent')
  const p = stub.pushes[0]
  assert.equal(p.path, '/3/device/abc123')
  assert.equal(p.headers['apns-topic'], 'app.trek.mobile')
  assert.equal(p.headers['apns-push-type'], 'alert')
  assert.match(p.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  assert.deepEqual(p.body, { aps: { alert: { title: 'Trek · app', body: 'A decision is waiting' }, sound: 'default' }, trek: { kind: 'decision', serverId: 's', projectId: 'p', sessionId: 'x' } })
  stub.respond = () => ({ status: 410, reason: 'Unregistered' })
  assert.equal(await apns.send(device('abc123'), message), 'dead')
  stub.respond = () => ({ status: 400, reason: 'BadDeviceToken' })
  assert.equal(await apns.send(device('abc123'), message), 'dead')
  stub.respond = () => ({ status: 429, reason: 'TooManyRequests' })
  assert.equal(await apns.send(device('abc123'), message), 'failed')
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
  assert.deepEqual(m.body.message.data, { kind: 'decision', serverId: 's', projectId: 'p', sessionId: 'x' })
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
  assert.equal(await fcm.send(device('t', 'android'), message), 'failed')
})
