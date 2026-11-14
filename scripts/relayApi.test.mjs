// trek-relay (6b): the config's owner-only rule, the store (hashed secrets, 0600) and the /v1 API
// (registration, grants, auth, limits, the body cap, kinds, dead devices), with a fake provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRelayConfig } from '../relay/src/config.ts'
import { RelayStore, hashSecret, MAX_GRANTS_PER_DEVICE, DEAD_PRUNE_MS, UNGRANTED_PRUNE_MS } from '../relay/src/store.ts'
import { startRelay } from '../relay/src/relay.ts'
import { MAX_BODY_BYTES, RETRY_AFTER_S } from '../relay/src/api.ts'
import { WindowLimiter, takeAll } from '../relay/src/limits.ts'
import { pushText, pushGroupOf, PUSH_KINDS, MAX_PUSH_PROJECT } from '../src/shared/push.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

// Windows has no POSIX file modes (stat reports 0666): the 0600/0700 checks are POSIX only.
const posix = process.platform !== 'win32'

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-relay-test-'))
  t.after(() => removeDir(dir))
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

async function relay(t, providers = { ios: fakeProvider(), android: fakeProvider() }, config = {}) {
  const dataDir = temp(t)
  const logs = []
  const running = await startRelay({ dataDir, host: '127.0.0.1', port: 0, ...config }, providers, (l) => logs.push(l))
  t.after(() => running.close())
  const base = `http://127.0.0.1:${running.port}`
  const call = async (method, path, body, secret, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    })
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers }
  }
  return { call, providers, dataDir, logs, port: running.port, store: running.store }
}

const pushBody = (extra = {}) => ({ kind: 'decision', project: 'trek-app', data: { serverId: 's1', projectId: 'p1', sessionId: 'x1' }, ...extra })

test('push text: a fixed sentence per kind, the project cut and cleaned', () => {
  assert.deepEqual(pushText('decision', 'trek-app'), { title: 'Trek · trek-app', body: 'A decision is waiting' })
  assert.equal(pushText('pr-merged', 'a\u0007b‮').title, 'Trek · ab')
  assert.equal(pushText('decision', 'x'.repeat(200)).title.length, 'Trek · '.length + MAX_PUSH_PROJECT)
  assert.equal(pushText('session-stopped', '').title, 'Trek')
  assert.equal(pushText('decision', 'a\u2028b\u2029c\ufeffd\u2060e\u2064f').title, 'Trek · abcdef', 'line separators, the BOM and invisible operators go')
  const emoji = pushText('decision', '😀'.repeat(100)).title
  assert.equal(Array.from(emoji).length, 'Trek · '.length + MAX_PUSH_PROJECT, 'cut by code points')
  assert.ok(!/[\ud800-\udbff]…$/.test(emoji), 'no half surrogate pair before the ellipsis')
  for (const kind of PUSH_KINDS) assert.ok(pushText(kind, 'p').body.length > 0)
  assert.equal(pushGroupOf('decision'), 'decisions')
  assert.equal(pushGroupOf('session-stopped'), 'sessions')
  assert.equal(pushGroupOf('pr-conflict'), 'prWatch')
})

test('config: refuses a config or credential file others can read; resolves paths against the config', { skip: posixOnly('file modes (the relay refuses a config others can read by its mode)') }, (t) => {
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
  writeFileSync(path, JSON.stringify({ dataDir: 'data', trustProxy: true, registrationKey: 'r'.repeat(20), maxDevices: 5 }), { mode: 0o600 })
  assert.deepEqual([loadRelayConfig(path).trustProxy, loadRelayConfig(path).registrationKey, loadRelayConfig(path).maxDevices], [true, 'r'.repeat(20), 5])
  writeFileSync(path, JSON.stringify({ registrationKey: 'short' }), { mode: 0o600 })
  assert.throws(() => loadRelayConfig(path), /registrationKey/)
})

// /etc/hosts belongs to root: unless the tests run as root, it is someone else's.
test('config: a file owned by another user is refused', { skip: process.getuid?.() === 0 || !existsSync('/etc/hosts') }, () => {
  assert.throws(() => loadRelayConfig('/etc/hosts'), /belongs to another user/)
})

test('store: secrets are kept only as hashes, the file is 0600 and survives a reload', (t) => {
  const dir = temp(t)
  const store = new RelayStore(dir)
  const { device, secret } = store.addDevice('ios', 'apns-token-1')
  const { secret: grantSecret } = store.addGrant(device.id, 'dev server')
  const text = readFileSync(join(dir, 'relay.json'), 'utf8')
  assert.ok(!text.includes(secret) && !text.includes(grantSecret))
  assert.ok(text.includes(hashSecret(secret)))
  if (posix) assert.equal(statSync(join(dir, 'relay.json')).mode & 0o777, 0o600)
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
  providers.ios.result = 'rejected'
  assert.equal((await call('POST', '/v1/push', pushBody(), grantSecret)).status, 422, 'a refusal is final (the server does not retry)')
  providers.ios.result = 'unavailable'
  const busy = await call('POST', '/v1/push', pushBody(), grantSecret)
  assert.deepEqual([busy.status, busy.headers.get('retry-after')], [503, String(RETRY_AFTER_S)])
})

test('api: a dead device answers 410 device-dead to its grant calls until the phone sends its token (same or new)', async (t) => {
  const { call, providers } = await relay(t)
  const { deviceId, deviceSecret } = (await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'tok' })).body
  const { grantSecret } = (await call('POST', '/v1/grants', { label: 's' }, deviceSecret)).body
  providers.ios.result = 'dead'
  await call('POST', '/v1/push', pushBody(), grantSecret)
  assert.deepEqual(await call('GET', '/v1/grants', undefined, deviceSecret).then((r) => [r.status, r.body]), [410, { error: 'device-dead' }])
  assert.deepEqual(await call('POST', '/v1/grants', { label: 'x' }, deviceSecret).then((r) => [r.status, r.body]), [410, { error: 'device-dead' }])
  assert.equal((await call('PUT', `/v1/devices/${deviceId}`, { pushToken: 'tok' }, deviceSecret)).status, 200, 'the same token again')
  assert.equal((await call('GET', '/v1/grants', undefined, deviceSecret)).status, 200)
})

test('store: a token marked gone after the phone sent a new one is not marked dead (markDead checks the token sent)', (t) => {
  const store = new RelayStore(temp(t))
  const { device } = store.addDevice('ios', 'old')
  store.setPushToken(device.id, 'new')
  store.markDead(device.id, 'old')
  assert.equal(device.dead, undefined)
  store.markDead(device.id, 'new')
  assert.equal(device.dead, true)
})

test('api: a paused device accepts and drops pushes (PUT paused, pushToken optional)', async (t) => {
  const { call, providers, logs } = await relay(t)
  const { deviceId, deviceSecret } = (await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'tok' })).body
  const { grantSecret } = (await call('POST', '/v1/grants', { label: 's' }, deviceSecret)).body
  assert.equal((await call('PUT', `/v1/devices/${deviceId}`, {}, deviceSecret)).status, 400)
  assert.equal((await call('PUT', `/v1/devices/${deviceId}`, { paused: 'yes' }, deviceSecret)).status, 400)
  assert.deepEqual((await call('PUT', `/v1/devices/${deviceId}`, { paused: true }, deviceSecret)).body, { updated: true, paused: true })
  const r = await call('POST', '/v1/push', pushBody(), grantSecret)
  assert.deepEqual([r.status, r.body], [202, { accepted: true, paused: true }])
  assert.equal(providers.ios.sent.length, 0)
  assert.ok(logs.some((l) => / paused$/.test(l)))
  assert.deepEqual((await call('PUT', `/v1/devices/${deviceId}`, { paused: false }, deviceSecret)).body, { updated: true, paused: false })
  assert.equal((await call('POST', '/v1/push', pushBody(), grantSecret)).status, 202)
  assert.equal(providers.ios.sent.length, 1)
})

test('api: a registration key, when configured, is required (x-trek-relay-key)', async (t) => {
  const key = 'k'.repeat(32)
  const { call } = await relay(t, undefined, { registrationKey: key })
  assert.equal((await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'a' })).status, 401)
  assert.equal((await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'a' }, undefined, { 'x-trek-relay-key': 'k'.repeat(31) })).status, 401)
  assert.equal((await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'a' }, undefined, { 'x-trek-relay-key': key })).status, 201)
})

test('api: trustProxy reads the last X-Forwarded-For hop for the per-address limit', async (t) => {
  const { call } = await relay(t, undefined, { trustProxy: true })
  const from = (ip) => ({ 'x-forwarded-for': `9.9.9.9, ${ip}` })
  for (let i = 0; i < 10; i += 1) assert.equal((await call('POST', '/v1/devices', { platform: 'ios', pushToken: `a${i}` }, undefined, from('1.1.1.1'))).status, 201)
  assert.equal((await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'a10' }, undefined, from('1.1.1.1'))).status, 429)
  assert.equal((await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'b' }, undefined, from('2.2.2.2'))).status, 201, 'another client behind the proxy')

  const plain = await relay(t)
  for (let i = 0; i < 10; i += 1) await plain.call('POST', '/v1/devices', { platform: 'ios', pushToken: `a${i}` }, undefined, from(`3.3.3.${i}`))
  assert.equal((await plain.call('POST', '/v1/devices', { platform: 'ios', pushToken: 'z' }, undefined, from('4.4.4.4'))).status, 429, 'without trustProxy the header is ignored')
})

test('api: grants per device per minute, the device cap (503), and a reinstall replacing its old device', async (t) => {
  const { call } = await relay(t, undefined, { maxDevices: 2 })
  const a = (await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'tok-a' })).body
  const statuses = []
  for (let i = 0; i < 11; i += 1) statuses.push((await call('POST', '/v1/grants', { label: `g${i}` }, a.deviceSecret)).status)
  assert.equal(statuses.filter((s) => s === 201).length, 10)
  assert.equal(statuses.at(-1), 429)
  await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'tok-b' })
  assert.equal((await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'tok-c' })).status, 503, 'the relay is full')
  const again = await call('POST', '/v1/devices', { platform: 'ios', pushToken: 'tok-a' })
  assert.equal(again.status, 201, 'the same token replaces its device, full or not')
  assert.notEqual(again.body.deviceId, a.deviceId)
  assert.equal((await call('GET', '/v1/grants', undefined, a.deviceSecret)).status, 401, 'the old device is gone')
  assert.deepEqual((await call('GET', '/v1/grants', undefined, again.body.deviceSecret)).body, [], 'its grants with it')
})

test('api: a body over the cap is refused by its length before reading, and a stream is cut once past it', async (t) => {
  const { port, call } = await relay(t)
  assert.equal((await call('POST', '/v1/devices', 'x'.repeat(MAX_BODY_BYTES + 1))).status, 413)
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/devices', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    // The relay closes with the rest of the body unread, which resets the connection. Windows then
    // drops the 413 it had not read yet and fails the write, so there the cut is all the client sees.
    req.on('error', (err) => (!posix && err.code === 'ECONNRESET' ? resolve('reset') : reject(err)))
    const chunk = 'x'.repeat(4096)
    let n = 0
    const write = () => {
      while (n < 64 && req.write(chunk)) n += 1
      if (n < 64) req.once('drain', write)
    }
    write()
  })
  if (status !== 'reset') assert.equal(status, 413)
})

test('store: devices dead for 30 days are pruned on load; bookkeeping is flushed', async (t) => {
  const dir = temp(t)
  let now = 1_000_000
  const store = new RelayStore(dir, { now: () => now })
  const { device } = store.addDevice('ios', 'gone')
  const { device: alive } = store.addDevice('ios', 'here')
  const { grant } = store.addGrant(alive.id, 'g')
  store.addGrant(device.id, 'g')
  store.markDead(device.id, 'gone')
  store.touchGrant(grant.id)
  store.flush()
  assert.ok(JSON.parse(readFileSync(join(dir, 'relay.json'), 'utf8')).grants[0].lastPushAt, 'flushed')
  now += DEAD_PRUNE_MS - 1
  assert.equal(new RelayStore(dir, { now: () => now }).deviceCount, 2)
  now += 1
  const later = new RelayStore(dir, { now: () => now })
  assert.equal(later.deviceCount, 1)
  if (posix) assert.equal(statSync(dir).mode & 0o777, 0o700)
  const fresh = join(dir, 'sub')
  new RelayStore(fresh)
  if (posix) assert.equal(statSync(fresh).mode & 0o777, 0o700, 'the data directory is made 0700')
})

test('store: a first delivery is written at once (not debounced)', (t) => {
  const dir = temp(t)
  const store = new RelayStore(dir)
  const { device } = store.addDevice('ios', 'tok')
  store.markDelivered(device.id, 'tok')
  const saved = JSON.parse(readFileSync(join(dir, 'relay.json'), 'utf8'))
  assert.equal(saved.devices[0].delivered, true, 'on disk before any flush')
})

test('store: devices with no grant for 7 days are pruned (since registering, or since the last grant went)', (t) => {
  const dir = temp(t)
  let now = 1_000_000
  const store = new RelayStore(dir, { now: () => now })
  store.addDevice('ios', 'never-granted')
  const { device: revoked } = store.addDevice('ios', 'revoked')
  const { device: kept } = store.addDevice('ios', 'granted')
  store.addGrant(kept.id, 'g')
  now += 3 * 24 * 3_600_000
  const { grant } = store.addGrant(revoked.id, 'g')
  store.removeGrant(revoked.id, grant.id) // no grant left from here
  now = 1_000_000 + UNGRANTED_PRUNE_MS - 1
  assert.equal(store.prune(), 0)
  now += 1
  assert.equal(store.prune(), 1, 'the one never granted')
  assert.equal(store.deviceCount, 2)
  now += 3 * 24 * 3_600_000
  assert.equal(store.prune(), 1, 'the one whose last grant went 7 days ago')
  assert.equal(new RelayStore(dir, { now: () => now }).deviceCount, 1, 'the granted one stays (and the prune was saved)')
})

test('limits: a push refused per device takes nothing from its grant; the sweep is amortised', () => {
  const perGrant = new WindowLimiter(2, 60_000)
  const perDevice = new WindowLimiter(1, 60_000)
  assert.equal(takeAll(0, [perGrant, 'g'], [perDevice, 'd']), true)
  assert.equal(takeAll(1, [perGrant, 'g'], [perDevice, 'd']), false)
  assert.equal(perGrant.allows('g', 2), true, 'the refused push did not count against the grant')
  const l = new WindowLimiter(1, 10)
  for (let i = 0; i < 1_500; i += 1) l.take(`k${i}`, 0)
  l.take('late', 1_000)
  assert.ok(l.size <= 2, 'swept once the window passed')
  for (let i = 0; i < 1_500; i += 1) l.take(`m${i}`, 1_050)
  l.take('later', 1_500)
  assert.ok(l.size > 1_000, 'not swept again within a second')
})
