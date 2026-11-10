// scripts/serverIntegrations.test.mjs — the server's secrets file, linear.*, voice.* and skills.list (phase 5b),
// against local HTTP stubs of Linear's and ElevenLabs' APIs: nothing here reaches either service.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretFile, secretsPathFor } from '../server/src/secrets.ts'
import { createIntegrations, testEndpoint } from '../server/src/integrations/integrations.ts'
import { readBodyCapped } from '../src/host/httpBody.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'

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

/** A stub of ElevenLabs' API: `good-voice` is a valid key with two voices; speech is `mp3:<voice>:<model>:<text>`. */
async function elevenLabsStub(t, options = {}) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, key: req.headers['xi-api-key'], body })
      if (options.status) {
        res.writeHead(options.status)
        return res.end('quota exceeded')
      }
      if (req.headers['xi-api-key'] !== 'good-voice') {
        res.writeHead(401)
        return res.end()
      }
      if (req.method === 'GET' && req.url === '/v1/voices') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ voices: [{ voice_id: 'v1', name: 'Rachel' }, { voice_id: 'v2', name: 'Adam' }] }))
      }
      const speech = /^\/v1\/text-to-speech\/([^?]+)\?output_format=mp3_44100_128$/.exec(req.url)
      if (req.method === 'POST' && speech) {
        const { text, model_id } = JSON.parse(body)
        if (options.audioBytes) {
          // A clip over the cap, streamed without a content-length.
          res.writeHead(200, { 'content-type': 'audio/mpeg', 'transfer-encoding': 'chunked' })
          const chunk = Buffer.alloc(64 * 1024, 1)
          for (let sent = 0; sent < options.audioBytes; sent += chunk.length) res.write(chunk)
          return res.end()
        }
        res.writeHead(200, { 'content-type': 'audio/mpeg' })
        return res.end(`mp3:${decodeURIComponent(speech[1])}:${model_id}:${text}`)
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests }
}

async function setup(t, options = {}) {
  const dir = tempDir(t)
  const stub = await linearStub(t, options)
  const voiceStub = await elevenLabsStub(t, options.voice)
  const secretsFile = secretsPathFor(join(dir, 'config.json'))
  const voiceConfigFile = join(dir, 'data', 'voice.json')
  const integrations = createIntegrations({ secretsFile, linearEndpoint: stub.url, voiceConfigFile, elevenLabsApi: voiceStub.url })
  const ctx = { integrations }
  const call = (method, params) => dispatchV2(method, params, ctx)
  return { dir, stub, voiceStub, secretsFile, voiceConfigFile, integrations, call }
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

test('linear.setKey ifAbsent (the hand-over) stores the key unchecked, and keeps a stored one', async (t) => {
  const s = await setup(t)
  assert.deepEqual((await s.call('linear.setKey', { apiKey: 'app-key', ifAbsent: true })).result, { ok: true, user: '' })
  const again = await s.call('linear.setKey', { apiKey: 'other-key', ifAbsent: true })
  assert.deepEqual(again.result, { ok: false, error: 'This server already has a key; it was kept', present: true })
  // Linear was never asked: the app checked the key when it was entered.
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

test('voice.setKey checks the key by listing its voices, picks the first voice, and never sends the key back', async (t) => {
  const s = await setup(t)
  assert.deepEqual((await s.call('voice.settings', {})).result, { voiceId: '', modelId: 'eleven_flash_v2_5', promptSessions: false, hasKey: false })
  assert.deepEqual((await s.call('voice.setKey', { apiKey: 'bad' })).result, { ok: false, error: 'ElevenLabs rejected the API key' })
  const set = await s.call('voice.setKey', { apiKey: 'good-voice' })
  assert.deepEqual(set.result, { ok: true, voices: [{ id: 'v1', name: 'Rachel' }, { id: 'v2', name: 'Adam' }] })
  assert.equal(JSON.stringify(set).includes('good-voice'), false)
  assert.deepEqual((await s.call('voice.settings', {})).result, { voiceId: 'v1', modelId: 'eleven_flash_v2_5', promptSessions: false, hasKey: true })
  assert.equal(statSync(s.secretsFile).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(s.secretsFile, 'utf8')), { elevenlabs: 'good-voice' })
  assert.deepEqual((await s.call('voice.voices', {})).result, [{ id: 'v1', name: 'Rachel' }, { id: 'v2', name: 'Adam' }])
  // A voice already chosen is kept by a later key.
  await s.call('voice.setConfig', { voiceId: 'v2' })
  await s.call('voice.setKey', { apiKey: 'good-voice' })
  assert.equal((await s.call('voice.settings', {})).result.voiceId, 'v2')
  // ifAbsent keeps the stored key without a request, and stores one unchecked on a server without.
  const before = s.voiceStub.requests.length
  assert.deepEqual((await s.call('voice.setKey', { apiKey: 'other', ifAbsent: true })).result, { ok: false, error: 'This server already has a key; it was kept', present: true })
  assert.equal(s.voiceStub.requests.length, before)
  const fresh = await setup(t)
  assert.deepEqual((await fresh.call('voice.setKey', { apiKey: 'app-voice', ifAbsent: true })).result, { ok: true, voices: [] })
  assert.deepEqual([fresh.voiceStub.requests.length, (await fresh.call('voice.settings', {})).result.hasKey], [0, true])
  assert.equal((await s.call('voice.clearKey', {})).ok, true)
  assert.equal((await s.call('voice.settings', {})).result.hasKey, false)
  refused(await s.call('voice.voices', {}), 'TOOL_ERROR')
})

test('voice.setConfig checks each field; voice.synthesize speaks in the chosen voice and model, to this connection', async (t) => {
  const s = await setup(t)
  refused(await s.call('voice.synthesize', { text: 'Hi' }), 'TOOL_ERROR')
  await s.call('voice.setKey', { apiKey: 'good-voice' })
  const config = await s.call('voice.setConfig', { modelId: 'eleven_turbo_v2_5', promptSessions: true })
  assert.deepEqual(config.result, { voiceId: 'v1', modelId: 'eleven_turbo_v2_5', promptSessions: true })
  assert.deepEqual(JSON.parse(readFileSync(s.voiceConfigFile, 'utf8')), config.result)
  assert.equal(s.integrations.voice.promptSessions(), true)
  const spoken = await s.call('voice.synthesize', { text: ' Hello there. ' })
  assert.equal(Buffer.from(spoken.result.audio, 'base64').toString(), 'mp3:v1:eleven_turbo_v2_5:Hello there.')
  for (const params of [{ voiceId: '../x' }, { voiceId: '' }, { modelId: 'a b' }, { promptSessions: 'yes' }, { promptSessions: 1 }, { active: true }, { voiceId: 'v2', extra: 1 }]) {
    refused(await s.call('voice.setConfig', params), 'BAD_REQUEST')
  }
  // Nothing refused reached the file.
  assert.deepEqual(JSON.parse(readFileSync(s.voiceConfigFile, 'utf8')), config.result)
  refused(await s.call('voice.synthesize', { text: 'x'.repeat(401) }), 'BAD_REQUEST')
  refused(await s.call('voice.synthesize', { text: '' }), 'BAD_REQUEST')
  // Without a key, sessions are not told to speak whatever the setting.
  await s.call('voice.clearKey', {})
  assert.equal(s.integrations.voice.promptSessions(), false)
})

test('voice.*: an ElevenLabs that fails is TOOL_ERROR with its message', async (t) => {
  const s = await setup(t, { voice: { status: 429 } })
  assert.deepEqual((await s.call('voice.setKey', { apiKey: 'good-voice' })).result, { ok: false, error: 'ElevenLabs returned 429: quota exceeded' })
  createSecretFile(s.secretsFile).set('elevenlabs', 'good-voice')
  await s.call('voice.setConfig', { voiceId: 'v1' })
  const res = await s.call('voice.synthesize', { text: 'Hi' })
  refused(res, 'TOOL_ERROR')
  assert.match(res.error.message, /429/)
})

test('TopicHub.emit reaches the subscribers that take events and counts the ones it was sent to', () => {
  const hub = new TopicHub()
  hub.publish('project:p', {})
  const got = []
  hub.subscribe('project:p', { send() {}, event: (e, p) => (got.push([e, p]), true) })
  hub.subscribe('project:p', { send() {}, event: () => false })
  hub.subscribe('project:p', { send() {} })
  hub.subscribe('project:p', { send() {}, event: () => { throw new Error('boom') } })
  assert.equal(hub.emit('project:p', 'voice.summary', { x: 1 }), 1)
  assert.deepEqual(got, [['voice.summary', { x: 1 }]])
  assert.equal(hub.emit('project:nope', 'voice.summary', {}), 0)
})

test("skills.list reads the worktree's .claude and the server user's ~/.claude; the project shadows the user", async (t) => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const dir = realpathSync(tempDir(t))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a])
  execFileSync('git', ['-C', a, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init'])
  const write = (path, text) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  write(join(a, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: "Review the branch"\n---\nbody')
  write(join(a, '.claude', 'commands', 'ship.md'), 'no frontmatter')
  const home = join(dir, 'home')
  write(join(home, '.claude', 'skills', 'review', 'SKILL.md'), '---\ndescription: the user one\n---\n')
  write(join(home, '.claude', 'skills', 'notes', 'SKILL.md'), `---\ndescription: ${'x'.repeat(130)}\n---\n`)
  mkdirSync(join(home, '.claude', 'skills', 'empty'), { recursive: true })
  write(join(home, '.claude', 'commands', 'todo.md'), '---\ndescription: List todos\n---\n')
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
  t.after(() => {
    poller.stop()
    store.close()
  })
  const integrations = createIntegrations({ secretsFile: join(dir, 'secrets.json'), voiceConfigFile: join(dir, 'voice.json'), home })
  const ctx = { store, hub, subscriber: { send: () => {} }, projects, poller, integrations }
  const call = (method, params) => dispatchV2(method, params, ctx)
  const projectId = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result.projectId
  await poller.refresh(a)
  const main = projects.require(projectId).repositories[0].worktrees[0]
  const listed = await call('skills.list', { projectId, worktreeId: main.id })
  assert.deepEqual(listed.result, [
    { name: 'review', description: 'Review the branch', source: 'project', kind: 'skill' },
    { name: 'ship', description: undefined, source: 'project', kind: 'command' },
    { name: 'notes', description: `${'x'.repeat(120)}…`, source: 'user', kind: 'skill' },
    { name: 'todo', description: 'List todos', source: 'user', kind: 'command' }
  ])
  // A row the guard does not cover; an unknown worktree.
  const outside = realpathSync(tempDir(t))
  projects.apply(projectId, (d) => {
    d.repositories[0].worktrees.push({ id: 'out', name: 'out', path: outside, branch: 'x', isMain: false, loaded: false, sessions: [] })
  })
  refused(await call('skills.list', { projectId, worktreeId: 'out' }), 'PATH_DENIED')
  refused(await call('skills.list', { projectId, worktreeId: 'nope' }), 'NOT_FOUND')
})

/** The secrets file a directory: every read of it fails (EISDIR), whoever runs the test. */
const unreadableSecrets = (s) => mkdirSync(s.secretsFile, { recursive: true })

test('setKey with an unreadable secrets file is TOOL_ERROR before any request, with or without ifAbsent', async (t) => {
  const s = await setup(t)
  unreadableSecrets(s)
  for (const method of ['linear.setKey', 'voice.setKey']) {
    for (const ifAbsent of [false, true]) {
      const res = await s.call(method, { apiKey: method === 'linear.setKey' ? 'good-key' : 'good-voice', ifAbsent })
      refused(res, 'TOOL_ERROR')
      assert.match(res.error.message, /cannot be read/)
    }
  }
  assert.deepEqual([s.stub.requests.length, s.voiceStub.requests.length], [0, 0])
})

test('voice.setKey: a key stored whose voice choice cannot be saved is TOOL_ERROR saying the key was kept', async (t) => {
  const s = await setup(t)
  // voice.json's directory is a file: the config reads as the defaults and cannot be written.
  writeFileSync(join(s.dir, 'data'), '')
  const res = await s.call('voice.setKey', { apiKey: 'good-voice' })
  refused(res, 'TOOL_ERROR')
  assert.match(res.error.message, /key was stored.*voice could not be saved/)
  assert.deepEqual(JSON.parse(readFileSync(s.secretsFile, 'utf8')), { elevenlabs: 'good-voice' })
})

test('linear.setKey: a 400 whose body is not JSON is a failed check, not a parse error', async (t) => {
  const s = await setup(t, { notJson: true })
  assert.deepEqual((await s.call('linear.setKey', { apiKey: 'good-key' })).result, { ok: false, error: 'Linear API returned 400' })
  assert.deepEqual((await s.call('linear.status', {})).result, { hasKey: false })
})

test('sessions are prompted to speak only with a key, a chosen voice and the setting on', async (t) => {
  const s = await setup(t)
  await s.call('voice.setKey', { apiKey: 'app-voice', ifAbsent: true })
  await s.call('voice.setConfig', { promptSessions: true })
  assert.equal(s.integrations.voice.promptSessions(), false)
  await s.call('voice.setConfig', { voiceId: 'v1' })
  assert.equal(s.integrations.voice.promptSessions(), true)
})

test('voice.synthesize: a clip over 4 MiB is TOOL_ERROR', async (t) => {
  const s = await setup(t, { voice: { audioBytes: 4 * 1024 * 1024 + 64 * 1024 } })
  await s.call('voice.setKey', { apiKey: 'good-voice' })
  const res = await s.call('voice.synthesize', { text: 'Hi' })
  refused(res, 'TOOL_ERROR')
  assert.match(res.error.message, /larger than/)
})

test('readBodyCapped: content-length over the cap, a stream over the cap, and one under it', async () => {
  const stream = (bytes) => new ReadableStream({ start(c) { for (let i = 0; i < bytes; i += 10) c.enqueue(new Uint8Array(10)); c.close() } })
  await assert.rejects(readBodyCapped(new Response('x'.repeat(20), { headers: { 'content-length': '20' } }), 10, 'The reply'), /The reply is larger than 10 bytes/)
  await assert.rejects(readBodyCapped(new Response(stream(30)), 25, 'The reply'), /larger than 25 bytes/)
  assert.equal((await readBodyCapped(new Response(stream(30)), 30, 'The reply')).length, 30)
  assert.equal((await readBodyCapped(new Response(null), 30, 'The reply')).length, 0)
})

/** A worktree for skills.list, as the first skills test makes it. */
async function skillsSetup(t) {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const dir = realpathSync(tempDir(t))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a])
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const integrations = createIntegrations({ secretsFile: join(dir, 'secrets.json'), voiceConfigFile: join(dir, 'voice.json'), home })
  return { dir, a, home, list: () => integrations.skills.list(a) }
}

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

test('skills.list skips FIFOs and links to devices, and reads only a file\'s head', { skip: process.platform === 'win32', timeout: 10_000 }, async (t) => {
  const s = await skillsSetup(t)
  for (const root of [join(s.a, '.claude'), join(s.home, '.claude')]) {
    mkdirSync(join(root, 'skills', 'fifo'), { recursive: true })
    execFileSync('mkfifo', [join(root, 'skills', 'fifo', 'SKILL.md')])
    mkdirSync(join(root, 'skills', 'zero'), { recursive: true })
    symlinkSync('/dev/zero', join(root, 'skills', 'zero', 'SKILL.md'))
    mkdirSync(join(root, 'commands'), { recursive: true })
    execFileSync('mkfifo', [join(root, 'commands', 'pipe.md')])
  }
  // Frontmatter that ends past the first 16 KiB is not read; a big file's head still is.
  write(join(s.a, '.claude', 'skills', 'long', 'SKILL.md'), `---\n${'# pad\n'.repeat(3000)}description: too far\n---\n`)
  write(join(s.a, '.claude', 'skills', 'big', 'SKILL.md'), `---\ndescription: Big one\n---\n${'x'.repeat(2 * 1024 * 1024)}`)
  write(join(s.home, '.claude', 'commands', 'huge.md'), `---\ndescription: Huge\n---\n${'x'.repeat(2 * 1024 * 1024)}`)
  assert.deepEqual(await s.list(), [
    { name: 'big', description: 'Big one', source: 'project', kind: 'skill' },
    { name: 'long', description: undefined, source: 'project', kind: 'skill' },
    { name: 'huge', description: 'Huge', source: 'user', kind: 'command' }
  ])
})

test("skills.list lists nothing from a worktree's .claude (or its skills dir) that leads outside the worktree", async (t) => {
  const s = await skillsSetup(t)
  const outside = join(s.dir, 'outside')
  write(join(outside, 'skills', 'stolen', 'SKILL.md'), '---\ndescription: from outside\n---\n')
  write(join(outside, 'commands', 'leak.md'), '---\ndescription: from outside\n---\n')
  symlinkSync(outside, join(s.a, '.claude'))
  assert.deepEqual(await s.list(), [])
  // A real .claude whose skills dir links out: its commands are still listed.
  rmSync(join(s.a, '.claude'))
  write(join(s.a, '.claude', 'commands', 'ship.md'), '---\ndescription: Ship it\n---\n')
  symlinkSync(join(outside, 'skills'), join(s.a, '.claude', 'skills'))
  // A SKILL.md that links out of the worktree is not read either.
  write(join(s.home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\ndescription: the user one\n---\n')
  assert.deepEqual(await s.list(), [
    { name: 'ship', description: 'Ship it', source: 'project', kind: 'command' },
    { name: 'mine', description: 'the user one', source: 'user', kind: 'skill' }
  ])
  rmSync(join(s.a, '.claude', 'skills'))
  mkdirSync(join(s.a, '.claude', 'skills', 'linked'), { recursive: true })
  symlinkSync(join(outside, 'skills', 'stolen', 'SKILL.md'), join(s.a, '.claude', 'skills', 'linked', 'SKILL.md'))
  assert.deepEqual((await s.list()).map((x) => x.name), ['ship', 'mine'])
})

test('integrations.changed: a stored key, a cleared key and new voice settings say so; a refused or kept key does not', async (t) => {
  const s = await setup(t)
  const changes = []
  const ctx = { integrations: s.integrations, integrationsChanged: (parts) => changes.push(parts) }
  const call = (method, params) => dispatchV2(method, params, ctx)
  await call('linear.setKey', { apiKey: 'bad-key' })
  assert.deepEqual(changes, [])
  await call('linear.setKey', { apiKey: 'good-key' })
  await call('linear.setKey', { apiKey: 'other', ifAbsent: true })
  await call('linear.clearKey', {})
  assert.deepEqual(changes, [{ linear: true }, { linear: true }])
  changes.length = 0
  await call('voice.setKey', { apiKey: 'bad-voice' })
  assert.deepEqual(changes, [])
  await call('voice.setKey', { apiKey: 'good-voice' })
  await call('voice.setConfig', { promptSessions: true })
  refused(await call('voice.setConfig', { voiceId: 'no spaces' }), 'BAD_REQUEST')
  await call('voice.clearKey', {})
  assert.deepEqual(changes, [{ voice: true }, { voice: true }, { voice: true }])
  // Reads say nothing.
  changes.length = 0
  await call('linear.status', {})
  await call('voice.settings', {})
  assert.deepEqual(changes, [])
})


test('the test endpoints (TREK_SERVER_LINEAR_URL, TREK_SERVER_ELEVENLABS_URL) are taken only on loopback', () => {
  const warned = []
  const warn = (m) => warned.push(m)
  assert.equal(testEndpoint('X', undefined, warn), undefined)
  assert.equal(testEndpoint('X', '', warn), undefined)
  assert.equal(testEndpoint('X', 'http://127.0.0.1:4000/graphql', warn), 'http://127.0.0.1:4000/graphql')
  assert.equal(testEndpoint('X', 'https://localhost/v1', warn), 'https://localhost/v1')
  assert.equal(testEndpoint('X', 'http://[::1]:9/v1', warn), 'http://[::1]:9/v1')
  assert.deepEqual(warned, [])
  for (const bad of ['https://evil.example/graphql', 'http://127.0.0.1.evil.example/', 'file:///etc/passwd', 'http://10.0.0.1/', 'not a url', 'http://localhost@evil.example/']) {
    assert.equal(testEndpoint('X', bad, warn), undefined, bad)
  }
  assert.equal(warned.length, 6)
  assert.match(warned[0], /X/)
})
