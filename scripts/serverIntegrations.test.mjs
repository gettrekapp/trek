// scripts/serverIntegrations.test.mjs — the server's secrets file and linear.* (phase 5b), against a
// local HTTP stub of Linear's GraphQL endpoint: nothing here reaches api.linear.app.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretFile, secretsPathFor } from '../server/src/secrets.ts'
import { createIntegrations } from '../server/src/integrations/integrations.ts'
import { dispatchV2 } from '../server/src/v2.ts'

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-integrations-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A stub of Linear's endpoint: `good-key` is a valid key; issues TOW-1 and TOW-2..TOW-120 exist. */
async function linearStub(t, options = {}) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      requests.push({ auth: req.headers.authorization, ...parsed })
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (options.status) return send(options.status, {})
      if (req.headers.authorization !== 'good-key') return send(401, {})
      if (parsed.query.includes('viewer')) return send(200, { data: { viewer: { name: 'Ada' } } })
      const data = {}
      for (const [alias, id] of Object.entries(parsed.variables)) {
        data[alias] = /^TOW-\d+$/.test(id) ? { identifier: id, title: `Title ${id}`, url: `https://linear.app/x/issue/${id}`, state: { name: 'In Progress', type: 'started', color: '#f00' } } : null
      }
      send(200, { data })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}/graphql`, requests }
}

async function setup(t, options = {}) {
  const dir = tempDir(t)
  const stub = await linearStub(t, options)
  const secretsFile = secretsPathFor(join(dir, 'config.json'))
  const integrations = createIntegrations({ secretsFile, linearEndpoint: stub.url })
  const ctx = { integrations }
  const call = (method, params) => dispatchV2(method, params, ctx)
  return { dir, stub, secretsFile, call }
}

const refused = (res, code) => {
  assert.equal(res.ok, false, JSON.stringify(res))
  assert.equal(res.error.code, code, res.error.message)
}

test('the secrets file: beside the config, 0600, set, set-if-absent and clear', (t) => {
  const dir = tempDir(t)
  const path = secretsPathFor(join(dir, 'config.json'))
  assert.equal(path, join(dir, 'secrets.json'))
  const file = createSecretFile(path)
  assert.equal(file.get('linear'), null)
  file.set('linear', 'k1')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(file.setIfAbsent('linear', 'k2'), false)
  assert.equal(file.get('linear'), 'k1')
  assert.equal(file.setIfAbsent('elevenlabs', 'e1'), true)
  file.set('linear', null)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { elevenlabs: 'e1' })
  // `__proto__` is just a name, never the object's prototype.
  file.set('__proto__', 'p')
  assert.equal(file.get('__proto__'), 'p')
  assert.equal(file.get('constructor'), null)
})

test('the secrets file: one that cannot be parsed throws, and is never replaced', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'secrets.json')
  writeFileSync(path, '{"linear": "k1", torn')
  const file = createSecretFile(path)
  assert.throws(() => file.get('linear'), /not valid JSON/)
  assert.throws(() => file.set('elevenlabs', 'e1'), /not valid JSON/)
  assert.equal(readFileSync(path, 'utf8'), '{"linear": "k1", torn')
})

test('linear.setKey checks the key with Linear, stores it 0600 and never sends it back', async (t) => {
  const s = await setup(t)
  assert.deepEqual((await s.call('linear.status', {})).result, { hasKey: false })
  // Without a key, no lookup and no request.
  assert.deepEqual((await s.call('linear.issues', { ids: ['TOW-1'] })).result, [])
  assert.equal(s.stub.requests.length, 0)

  const rejected = await s.call('linear.setKey', { apiKey: 'bad-key' })
  assert.deepEqual(rejected.result, { ok: false, error: 'Linear rejected the API key' })
  assert.deepEqual((await s.call('linear.status', {})).result, { hasKey: false })

  const set = await s.call('linear.setKey', { apiKey: '  good-key \n' })
  assert.deepEqual(set.result, { ok: true, user: 'Ada' })
  assert.equal(JSON.stringify(set).includes('good-key'), false)
  assert.deepEqual((await s.call('linear.status', {})).result, { hasKey: true })
  assert.equal(statSync(s.secretsFile).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(s.secretsFile, 'utf8')), { linear: 'good-key' })

  assert.deepEqual((await s.call('linear.clearKey', {})).result, null)
  assert.deepEqual((await s.call('linear.status', {})).result, { hasKey: false })
})

test('linear.setKey ifAbsent keeps a stored key without asking Linear', async (t) => {
  const s = await setup(t)
  assert.equal((await s.call('linear.setKey', { apiKey: 'good-key', ifAbsent: true })).result.ok, true)
  const before = s.stub.requests.length
  const again = await s.call('linear.setKey', { apiKey: 'other-key', ifAbsent: true })
  assert.deepEqual(again.result, { ok: false, error: 'This server already has a key; it was kept', present: true })
  assert.equal(s.stub.requests.length, before)
  assert.deepEqual(JSON.parse(readFileSync(s.secretsFile, 'utf8')), { linear: 'good-key' })
})

test('linear.issues looks the ids up in batches of 50 and leaves out unknown and malformed ids', async (t) => {
  const s = await setup(t)
  await s.call('linear.setKey', { apiKey: 'good-key' })
  const lookups = s.stub.requests.length
  const ids = [...Array.from({ length: 60 }, (_, i) => `TOW-${i + 1}`), 'TOW-1', 'nope', 'ABC-9']
  const res = await s.call('linear.issues', { ids })
  assert.equal(res.ok, true)
  // ABC-9 is well-formed but Linear has no such issue; "nope" is never sent; TOW-1 once.
  assert.equal(res.result.length, 60)
  assert.deepEqual(res.result[0], { identifier: 'TOW-1', title: 'Title TOW-1', url: 'https://linear.app/x/issue/TOW-1', status: 'In Progress', statusType: 'started', statusColor: '#f00' })
  const sent = s.stub.requests.slice(lookups)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent.map((r) => Object.keys(r.variables).length), [50, 11])
  assert.equal(sent.every((r) => r.auth === 'good-key'), true)
})

test('linear.*: a Linear that fails is TOOL_ERROR; bad arguments are BAD_REQUEST before any request', async (t) => {
  const s = await setup(t, { status: 500 })
  // No key yet: the check fails with Linear's status, nothing stored.
  assert.deepEqual((await s.call('linear.setKey', { apiKey: 'good-key' })).result, { ok: false, error: 'Linear API returned 500' })
  createSecretFile(s.secretsFile).set('linear', 'good-key')
  refused(await s.call('linear.issues', { ids: ['TOW-1'] }), 'TOOL_ERROR')
  const sent = s.stub.requests.length
  refused(await s.call('linear.setKey', { apiKey: 'has space' }), 'BAD_REQUEST')
  refused(await s.call('linear.setKey', { apiKey: '' }), 'BAD_REQUEST')
  refused(await s.call('linear.setKey', { apiKey: 'k', ifAbsent: 'yes' }), 'BAD_REQUEST')
  refused(await s.call('linear.issues', { ids: 'TOW-1' }), 'BAD_REQUEST')
  refused(await s.call('linear.issues', { ids: Array.from({ length: 501 }, () => 'TOW-1') }), 'BAD_REQUEST')
  refused(await s.call('linear.issues', { ids: [1] }), 'BAD_REQUEST')
  assert.equal(s.stub.requests.length, sent)
})

test('linear.*: a server without integrations answers NOT_FOUND', async () => {
  refused(await dispatchV2('linear.status', {}, {}), 'NOT_FOUND')
})
