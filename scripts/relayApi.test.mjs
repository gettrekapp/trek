// trek-relay (6b): the config's owner-only rule, the store (hashed secrets, 0600) and the /v1 API
// (registration, grants, auth, limits, the body cap, kinds, dead devices), with a fake provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRelayConfig } from '../relay/src/config.ts'
import { RelayStore, hashSecret, MAX_GRANTS_PER_DEVICE } from '../relay/src/store.ts'
import { startRelay } from '../relay/src/relay.ts'
import { MAX_BODY_BYTES } from '../relay/src/api.ts'
import { pushText, pushGroupOf, PUSH_KINDS, MAX_PUSH_PROJECT } from '../src/shared/push.ts'

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-relay-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakeProvider() {
  const sent = []
  let next = 'sent'
  return {
    sent,
    set result(r) {
      next = r
    },
    async send(device, message) {
      sent.push({ device: device.id, token: device.pushToken, message })
      return next
    }
  }
}

async function relay(t, providers = { ios: fakeProvider(), android: fakeProvider() }) {
  const dataDir = temp(t)
  const running = await startRelay({ dataDir, host: '127.0.0.1', port: 0 }, providers, () => {})
  t.after(() => running.close())
  const base = `http://127.0.0.1:${running.port}`
  const call = async (method, path, body, secret) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  return { call, providers, dataDir }
}

const pushBody = (extra = {}) => ({ kind: 'decision', project: 'trek-app', data: { serverId: 's1', projectId: 'p1', sessionId: 'x1' }, ...extra })

test('push text: a fixed sentence per kind, the project cut and cleaned', () => {
  assert.deepEqual(pushText('decision', 'trek-app'), { title: 'Trek · trek-app', body: 'A decision is waiting' })
  assert.equal(pushText('pr-merged', 'a\u0007b‮').title, 'Trek · ab')
  assert.equal(pushText('decision', 'x'.repeat(200)).title.length, 'Trek · '.length + MAX_PUSH_PROJECT)
  assert.equal(pushText('session-stopped', '').title, 'Trek')
  for (const kind of PUSH_KINDS) assert.ok(pushText(kind, 'p').body.length > 0)
  assert.equal(pushGroupOf('decision'), 'decisions')
  assert.equal(pushGroupOf('session-stopped'), 'sessions')
  assert.equal(pushGroupOf('pr-conflict'), 'prWatch')
})

test('config: refuses a config or credential file others can read; resolves paths against the config', (t) => {
  const dir = temp(t)
  const key = join(dir, 'AuthKey.p8')
  writeFileSync(key, 'k', { mode: 0o600 })
  const path = join(dir, 'relay.json')
  writeFileSync(path, JSON.stringify({ dataDir: 'data', apns: { keyId: 'K', teamId: 'T', bundleId: 'app.trek', keyPath: 'AuthKey.p8' } }), { mode: 0o644 })
  assert.throws(() => loadRelayConfig(path), /readable by others/)
  chmodSync(path, 0o600)
  chmodSync(key, 0o640)
  assert.throws(() => loadRelayConfig(path), /APNs key .* readable by others/)
  chmodSync(key, 0o600)
  const config = loadRelayConfig(path)
  assert.equal(config.dataDir, join(dir, 'data'))
  assert.equal(config.apns.keyPath, key)
  assert.equal(config.apns.production, false)
  assert.equal(config.port, 7346)
})

test('store: secrets are kept only as hashes, the file is 0600 and survives a reload', (t) => {
  const dir = temp(t)
  const store = new RelayStore(dir)
  const { device, secret } = store.addDevice('ios', 'apns-token-1')
  const { secret: grantSecret } = store.addGrant(device.id, 'dev server')
  const text = readFileSync(join(dir, 'relay.json'), 'utf8')
  assert.ok(!text.includes(secret) && !text.includes(grantSecret))
  assert.ok(text.includes(hashSecret(secret)))
  assert.equal(statSync(join(dir, 'relay.json')).mode & 0o777, 0o600)
  const again = new RelayStore(dir)
  assert.equal(again.deviceFor(secret)?.id, device.id)
  assert.equal(again.grantFor(grantSecret)?.device.id, device.id)
  assert.equal(again.deviceFor('nope'), undefined)
})

test('api: register, take grants, list and revoke them, rotate the token, remove the device', async (t) => {
  const { call } = await relay(t)
  const reg = await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'tok-a' })
  assert.equal(reg.status, 201)
  const { deviceId, deviceSecret } = reg.body
  assert.equal((await call('POST', '/v1/grants', { label: 'laptop' })).status, 401)
  const g = await call('POST', '/v1/grants', { label: 'dev server' }, deviceSecret)
  assert.equal(g.status, 201)
  const list = await call('GET', '/v1/grants', undefined, deviceSecret)
  assert.deepEqual(list.body.map((x) => x.label), ['dev server'])
  assert.equal((await call('PUT', `/v1/devices/${deviceId}`, { pushToken: 'tok-b' }, deviceSecret)).status, 200)
  assert.equal((await call('PUT', `/v1/devices/${deviceId}`, { pushToken: 'tok-c' }, g.body.grantSecret)).status, 401, 'a grant secret is not a device secret')
  assert.equal((await call('DELETE', `/v1/grants/${g.body.grantId}`, undefined, deviceSecret)).status, 200)
  assert.equal((await call('POST', '/v1/push', pushBody(), g.body.grantSecret)).status, 401, 'a revoked grant no longer pushes')
  assert.equal((await call('DELETE', `/v1/devices/${deviceId}`, undefined, deviceSecret)).status, 200)
  assert.equal((await call('GET', '/v1/grants', undefined, deviceSecret)).status, 401)
})

test('api: a push builds its words from the kind and project, and sends to the right device', async (t) => {
  const { call, providers } = await relay(t)
  const { deviceSecret } = (await call('POST', '/v1/devices', { platform: 'android', pushToken: 'fcm-1' })).body
  const { grantSecret } = (await call('POST', '/v1/grants', { label: 's' }, deviceSecret)).body
  const r = await call('POST', '/v1/push', pushBody({ kind: 'pr-checks-failed', title: 'ignored', body: 'ignored' }), grantSecret)
  assert.equal(r.status, 202)
  assert.equal(providers.android.sent.length, 1)
  const m = providers.android.sent[0].message
  assert.equal(providers.android.sent[0].token, 'fcm-1')
  assert.deepEqual([m.title, m.body, m.kind], ['Trek · trek-app', 'Pull request checks failed', 'pr-checks-failed'])
  assert.deepEqual(m.data, { serverId: 's1', projectId: 'p1', sessionId: 'x1' })
  assert.equal(providers.ios.sent.length, 0)
  const list = (await call('GET', '/v1/grants', undefined, deviceSecret)).body
  assert.equal(typeof list[0].lastPushAt, 'number')
})

test('api: bad input is refused (kind, ids, label, platform, token, body size, JSON, method)', async (t) => {
  const { call } = await relay(t, { ios: fakeProvider() })
  assert.equal((await call('POST', '/v1/devices', { platform: 'android', pushToken: 't' })).status, 400, 'no FCM configured')
  assert.equal((await call('POST', '/v1/devices', { platform: 'web', pushToken: 't' })).status, 400)
  assert.equal((await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'a b' })).status, 400)
  assert.equal((await call('POST', '/v1/devices', '{nope')).status, 400)
  assert.equal((await call('POST', '/v1/devices', 'x'.repeat(MAX_BODY_BYTES + 1))).status, 413)
  const { deviceSecret } = (await call('POST', '/v1/devices', { platform: 'ios', pushToken: 't' })).body
  assert.equal((await call('POST', '/v1/grants', { label: 'x'.repeat(81) }, deviceSecret)).status, 400)
  const { grantSecret } = (await call('POST', '/v1/grants', { label: 'ok' }, deviceSecret)).body
  assert.equal((await call('POST', '/v1/push', pushBody({ kind: 'free-text' }), grantSecret)).status, 400)
  assert.equal((await call('POST', '/v1/push', pushBody({ data: { serverId: 's', projectId: 'p q' } }), grantSecret)).status, 400)
  assert.equal((await call('POST', '/v1/push', pushBody({ data: { projectId: 'p' } }), grantSecret)).status, 400)
  assert.equal((await call('GET', '/v1/push', undefined, grantSecret)).status, 404)
})

test('api: limits on registrations, pushes per grant, and grants per device', async (t) => {
  const { call } = await relay(t)
  let last
  for (let i = 0; i < 11; i += 1) last = await call('POST', '/v1/devices', { platform: 'ios', pushToken: `t${i}` })
  assert.equal(last.status, 429)
  const store = new RelayStore(temp(t))
  const { device } = store.addDevice('ios', 'x')
  for (let i = 0; i < MAX_GRANTS_PER_DEVICE; i += 1) store.addGrant(device.id, `g${i}`)
  assert.equal(store.addGrant(device.id, 'one more'), 'full')
})

test('api: 30 pushes a minute per grant, then 429', async (t) => {
  const { call } = await relay(t)
  const { deviceSecret } = (await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'tok' })).body
  const { grantSecret } = (await call('POST', '/v1/grants', { label: 's' }, deviceSecret)).body
  const statuses = []
  for (let i = 0; i < 31; i += 1) statuses.push((await call('POST', '/v1/push', pushBody(), grantSecret)).status)
  assert.equal(statuses.filter((s) => s === 202).length, 30)
  assert.equal(statuses.at(-1), 429)
})

test('api: a token the provider calls gone marks the device dead (410) until a new token arrives', async (t) => {
  const { call, providers } = await relay(t)
  const { deviceId, deviceSecret } = (await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'old' })).body
  const { grantSecret } = (await call('POST', '/v1/grants', { label: 's' }, deviceSecret)).body
  providers.ios.result = 'dead'
  assert.equal((await call('POST', '/v1/push', pushBody(), grantSecret)).status, 410)
  providers.ios.result = 'sent'
  assert.equal((await call('POST', '/v1/push', pushBody(), grantSecret)).status, 410, 'stays dead without a new token')
  await call('PUT', `/v1/devices/${deviceId}`, { pushToken: 'new' }, deviceSecret)
  assert.equal((await call('POST', '/v1/push', pushBody(), grantSecret)).status, 202)
  providers.ios.result = 'failed'
  assert.equal((await call('POST', '/v1/push', pushBody(), grantSecret)).status, 502)
})
