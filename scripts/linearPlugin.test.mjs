// scripts/linearPlugin.test.mjs — the Linear plugin (plugin system phase 2; phase 5b's linear.*):
// its methods through dispatchV2 and the registry against a local stub of Linear's API (nothing
// here reaches Linear), plugins.changed, its ticket provider and its workspace setting.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretFile } from '../server/src/secrets.ts'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { dispatchV2, isCoreMethod } from '../server/src/v2.ts'
import { applySettingsPatch } from '../server/src/projects/settings.ts'
import { linearServerPlugin } from '../plugins/linear/server/index.ts'
import { linearTickets, workspaceProblem } from '../plugins/linear/shared/ticket.ts'
import { parseTicketWith, ticketView } from '../src/shared/tickets.ts'

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-linear-plugin-'))
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
      if (options.notJson) {
        res.writeHead(400, { 'content-type': 'text/html' })
        return res.end('<html>Bad Request</html>')
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
  const secretsFile = join(dir, 'secrets.json')
  const registry = createPluginRegistry({
    plugins: [linearServerPlugin],
    secretsFile,
    dataDir: join(dir, 'data'),
    hub: { emit: () => 0, eventSubscriberCount: () => 0 },
    projects: {
      require: () => {
        throw Object.assign(new Error('no project'), { code: 'NOT_FOUND' })
      }
    },
    isCoreMethod,
    coreToolNames: [],
    env: { TREK_SERVER_LINEAR_URL: stub.url }
  })
  const changes = []
  registry.onChanged((m) => changes.push(m.id))
  const call = (method, params) => dispatchV2(method, params, { plugins: registry })
  return { dir, stub, secretsFile, registry, changes, call }
}

const refused = (res, code) => {
  assert.equal(res.ok, false, JSON.stringify(res))
  assert.equal(res.error.code, code, res.error.message)
}

test('the Linear plugin registers as linear, with its legacy capability', async (t) => {
  const s = await setup(t)
  assert.deepEqual(s.registry.presence(), [{ id: 'linear', version: '1.0.0', defaultEnabled: true }])
  assert.deepEqual(s.registry.legacyCapabilities(), ['linear'])
  assert.equal(s.registry.settingRules.kind('linearWorkspace'), 'string')
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

test('linear.setKey ifAbsent (the hand-over) stores the key unchecked, and keeps a stored one', async (t) => {
  const s = await setup(t)
  assert.deepEqual((await s.call('linear.setKey', { apiKey: 'app-key', ifAbsent: true })).result, { ok: true, user: '' })
  const again = await s.call('linear.setKey', { apiKey: 'other-key', ifAbsent: true })
  assert.deepEqual(again.result, { ok: false, error: 'This server already has a key; it was kept', present: true })
  assert.equal(s.stub.requests.length, 0)
  assert.deepEqual(JSON.parse(readFileSync(s.secretsFile, 'utf8')), { linear: 'app-key' })
})

test('linear.issues looks the ids up in batches of 50 and leaves out unknown and malformed ids', async (t) => {
  const s = await setup(t)
  await s.call('linear.setKey', { apiKey: 'good-key' })
  const lookups = s.stub.requests.length
  const ids = [...Array.from({ length: 60 }, (_, i) => `TOW-${i + 1}`), 'TOW-1', 'nope', 'ABC-9']
  const res = await s.call('linear.issues', { ids })
  assert.equal(res.ok, true)
  assert.equal(res.result.length, 60)
  assert.deepEqual(res.result[0], { identifier: 'TOW-1', title: 'Title TOW-1', url: 'https://linear.app/x/issue/TOW-1', status: 'In Progress', statusType: 'started', statusColor: '#f00' })
  const sent = s.stub.requests.slice(lookups)
  assert.deepEqual(sent.map((r) => Object.keys(r.variables).length), [50, 11])
  assert.equal(sent.every((r) => r.auth === 'good-key'), true)
})

test('linear.*: a Linear that fails is TOOL_ERROR; bad arguments are BAD_REQUEST before any request', async (t) => {
  const s = await setup(t, { status: 500 })
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
  const notJson = await setup(t, { notJson: true })
  assert.deepEqual((await notJson.call('linear.setKey', { apiKey: 'good-key' })).result, { ok: false, error: 'Linear API returned 400' })
})

test('linear.setKey with an unreadable secrets file is TOOL_ERROR before any request, with or without ifAbsent', async (t) => {
  const s = await setup(t)
  mkdirSync(s.secretsFile, { recursive: true })
  for (const ifAbsent of [false, true]) {
    const res = await s.call('linear.setKey', { apiKey: 'good-key', ifAbsent })
    refused(res, 'TOOL_ERROR')
    assert.match(res.error.message, /cannot be read/)
  }
  assert.equal(s.stub.requests.length, 0)
})

test('plugins.changed: a stored key and a cleared key say so; a refused or kept key, and reads, do not', async (t) => {
  const s = await setup(t)
  await s.call('linear.setKey', { apiKey: 'bad-key' })
  assert.deepEqual(s.changes, [])
  await s.call('linear.setKey', { apiKey: 'good-key' })
  await s.call('linear.setKey', { apiKey: 'other', ifAbsent: true })
  await s.call('linear.clearKey', {})
  await s.call('linear.status', {})
  assert.deepEqual(s.changes, ['linear', 'linear'])
})

test("the ticket provider: Linear identifiers and issue URLs (implying the workspace), links from the issue or the workspace", () => {
  assert.equal(linearTickets.owns('TOW-1'), true)
  for (const id of ['tow-1', '12', 'TOW-', '-1']) assert.equal(linearTickets.owns(id), false, id)
  assert.deepEqual(linearTickets.parse('https://linear.app/acme/issue/tow-12/x'), { ticketId: 'TOW-12', settings: { linearWorkspace: 'acme' } })
  assert.deepEqual(linearTickets.parse('tow-9'), { ticketId: 'TOW-9' })
  assert.equal(linearTickets.parse('123'), null)
  assert.equal(linearTickets.parse('https://linear.app/a%20b/issue/TOW-1'), null)
  assert.equal(linearTickets.parse('https://linear.app/a.b/issue/TOW-1'), null)
  assert.equal(linearTickets.parse(`https://linear.app/${'a'.repeat(201)}/issue/TOW-1`), null)
  assert.deepEqual(linearTickets.parse('https://linear.app/my_team-1/issue/TOW-1'), { ticketId: 'TOW-1', settings: { linearWorkspace: 'my_team-1' } })
  assert.equal(linearTickets.label('TOW-1'), 'TOW-1')
  assert.equal(linearTickets.url({ linearWorkspace: 'acme' }, 'TOW-1'), 'https://linear.app/acme/issue/TOW-1')
  assert.equal(linearTickets.url({}, 'TOW-1'), null)
  assert.equal(linearTickets.url({ linearWorkspace: 'a' }, 'TOW-1', { title: 't', status: 's', statusColor: '#000', url: 'https://x' }), 'https://x')
  assert.equal(linearTickets.linkSetting.key, 'linearWorkspace')
  assert.deepEqual(parseTicketWith([linearTickets], ' https://linear.app/acme/issue/TOW-3 '), { ticketId: 'TOW-3', settings: { linearWorkspace: 'acme' }, providerId: 'linear' })
  assert.deepEqual(ticketView([linearTickets], { linearWorkspace: 'acme' }, 'TOW-3'), { label: 'TOW-3', url: 'https://linear.app/acme/issue/TOW-3', providerId: 'linear' })
})

test('the workspace setting: a slug, checked as the plugin\'s', async (t) => {
  assert.equal(workspaceProblem('my_team-1'), null)
  assert.match(workspaceProblem('a.b'), /slug/)
  assert.match(workspaceProblem('x'.repeat(201)), /slug/)
  const s = await setup(t)
  assert.deepEqual(applySettingsPatch({}, { linearWorkspace: 'acme' }, s.registry.settingRules), { linearWorkspace: 'acme' })
  assert.throws(() => applySettingsPatch({}, { linearWorkspace: 'a b' }, s.registry.settingRules), /settings\.linearWorkspace: must be a Linear workspace slug/)
})
