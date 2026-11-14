// scripts/voicePlugin.test.mjs — the voice plugin's server half (plugin system phase 1; phase 5b's
// voice.* and speak_summary): its methods through dispatchV2 and the plugin registry, against a
// local stub of ElevenLabs' API (nothing here reaches ElevenLabs), the move of voice.json, the
// speak_summary tool and session prompt in the projects where it is on, and plugins.changed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretFile } from '../server/src/secrets.ts'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { mcpContext } from '../server/src/plugins/mcp.ts'
import { dispatchV2, isCoreMethod } from '../server/src/v2.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { SessionManager } from '../server/src/sessions/manager.ts'
import { MCP_TOOLS, createToolCaller } from '../server/src/mcp/tools.ts'
import { voiceServerPlugin } from '../plugins/voice/server/index.ts'
import { migrateConfigFile } from '../plugins/voice/server/configFile.ts'
import { VOICE_SUMMARY_PROMPT } from '../plugins/voice/server/prompt.ts'

// Windows has no POSIX mode bits to check (owner-only there is the profile's ACL).
const posix = process.platform !== 'win32'

const tempDir = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-voice-plugin-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
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

/** The registry with the voice plugin only, as trek-server builds it; `projects` and `hub` as given. */
function registryFor(dir, stubUrl, { projects = { require: () => { throw Object.assign(new Error('no project'), { code: 'NOT_FOUND' }) } }, hub = new TopicHub() } = {}) {
  const warnings = []
  const registry = createPluginRegistry({
    plugins: [voiceServerPlugin],
    secretsFile: join(dir, 'secrets.json'),
    dataDir: join(dir, 'data'),
    hub,
    projects,
    isCoreMethod,
    coreToolNames: MCP_TOOLS.map((tool) => tool.name),
    env: stubUrl ? { TREK_SERVER_ELEVENLABS_URL: stubUrl } : {},
    warn: (m) => warnings.push(m)
  })
  return { registry, warnings }
}

async function setup(t, options = {}) {
  const dir = tempDir(t)
  const voiceStub = await elevenLabsStub(t, options.voice)
  const { registry, warnings } = registryFor(dir, voiceStub.url)
  const changes = []
  registry.onChanged((m) => changes.push(m.id))
  const call = (method, params) => dispatchV2(method, params, { plugins: registry })
  return { dir, voiceStub, registry, warnings, changes, call, secretsFile: join(dir, 'secrets.json'), configFile: join(dir, 'data', 'plugins', 'voice', 'config.json') }
}

const refused = (res, code) => {
  assert.equal(res.ok, false, JSON.stringify(res))
  assert.equal(res.error.code, code, res.error.message)
}

test('the voice plugin registers as voice, with its legacy capability', async (t) => {
  const s = await setup(t)
  assert.deepEqual(s.registry.presence(), [{ id: 'voice', version: '1.0.0', defaultEnabled: true }])
  assert.deepEqual(s.registry.legacyCapabilities(), ['voice'])
  assert.deepEqual(s.warnings, [])
})

test('voice.setKey checks the key by listing its voices, picks the first voice, and never sends the key back', async (t) => {
  const s = await setup(t)
  assert.deepEqual((await s.call('voice.settings', {})).result, { voiceId: '', modelId: 'eleven_flash_v2_5', promptSessions: false, hasKey: false })
  assert.deepEqual((await s.call('voice.setKey', { apiKey: 'bad' })).result, { ok: false, error: 'ElevenLabs rejected the API key' })
  const set = await s.call('voice.setKey', { apiKey: 'good-voice' })
  assert.deepEqual(set.result, { ok: true, voices: [{ id: 'v1', name: 'Rachel' }, { id: 'v2', name: 'Adam' }] })
  assert.equal(JSON.stringify(set).includes('good-voice'), false)
  assert.deepEqual((await s.call('voice.settings', {})).result, { voiceId: 'v1', modelId: 'eleven_flash_v2_5', promptSessions: false, hasKey: true })
  if (posix) assert.equal(statSync(s.secretsFile).mode & 0o777, 0o600)
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
  refused(await s.call('voice.setKey', { apiKey: 'has space' }), 'BAD_REQUEST')
  refused(await s.call('voice.setKey', { apiKey: 'good-voice', ifAbsent: 'yes' }), 'BAD_REQUEST')
})

test('voice.setConfig checks each field into the plugin config file; voice.synthesize speaks in the chosen voice and model', async (t) => {
  const s = await setup(t)
  refused(await s.call('voice.synthesize', { text: 'Hi' }), 'TOOL_ERROR')
  await s.call('voice.setKey', { apiKey: 'good-voice' })
  const config = await s.call('voice.setConfig', { modelId: 'eleven_turbo_v2_5', promptSessions: true })
  assert.deepEqual(config.result, { voiceId: 'v1', modelId: 'eleven_turbo_v2_5', promptSessions: true })
  assert.deepEqual(JSON.parse(readFileSync(s.configFile, 'utf8')), config.result)
  const spoken = await s.call('voice.synthesize', { text: ' Hello there. ' })
  assert.equal(Buffer.from(spoken.result.audio, 'base64').toString(), 'mp3:v1:eleven_turbo_v2_5:Hello there.')
  for (const params of [{ voiceId: '../x' }, { voiceId: '' }, { modelId: 'a b' }, { promptSessions: 'yes' }, { promptSessions: 1 }, { active: true }, { voiceId: 'v2', extra: 1 }]) {
    refused(await s.call('voice.setConfig', params), 'BAD_REQUEST')
  }
  // Nothing refused reached the file.
  assert.deepEqual(JSON.parse(readFileSync(s.configFile, 'utf8')), config.result)
  refused(await s.call('voice.synthesize', { text: 'x'.repeat(401) }), 'BAD_REQUEST')
  refused(await s.call('voice.synthesize', { text: '' }), 'BAD_REQUEST')
})

test('voice.*: an ElevenLabs that fails is TOOL_ERROR with its message; a clip over 4 MiB too', async (t) => {
  const s = await setup(t, { voice: { status: 429 } })
  assert.deepEqual((await s.call('voice.setKey', { apiKey: 'good-voice' })).result, { ok: false, error: 'ElevenLabs returned 429: quota exceeded' })
  createSecretFile(s.secretsFile).set('elevenlabs', 'good-voice')
  await s.call('voice.setConfig', { voiceId: 'v1' })
  const res = await s.call('voice.synthesize', { text: 'Hi' })
  refused(res, 'TOOL_ERROR')
  assert.match(res.error.message, /429/)
  const big = await setup(t, { voice: { audioBytes: 4 * 1024 * 1024 + 64 * 1024 } })
  await big.call('voice.setKey', { apiKey: 'good-voice' })
  const clip = await big.call('voice.synthesize', { text: 'Hi' })
  refused(clip, 'TOOL_ERROR')
  assert.match(clip.error.message, /larger than/)
})

test('voice.setKey with an unreadable secrets file is TOOL_ERROR before any request, with or without ifAbsent', async (t) => {
  const s = await setup(t)
  mkdirSync(s.secretsFile, { recursive: true })
  for (const ifAbsent of [false, true]) {
    const res = await s.call('voice.setKey', { apiKey: 'good-voice', ifAbsent })
    refused(res, 'TOOL_ERROR')
    assert.match(res.error.message, /cannot be read/)
  }
  assert.equal(s.voiceStub.requests.length, 0)
})

test('voice.setKey: a key stored whose voice choice cannot be saved is TOOL_ERROR saying the key was kept, and says it changed', async (t) => {
  const s = await setup(t)
  // The config file's place is a directory: it reads as the defaults and cannot be written.
  mkdirSync(s.configFile, { recursive: true })
  const res = await s.call('voice.setKey', { apiKey: 'good-voice' })
  refused(res, 'TOOL_ERROR')
  assert.match(res.error.message, /key was stored.*voice could not be saved/)
  assert.deepEqual(JSON.parse(readFileSync(s.secretsFile, 'utf8')), { elevenlabs: 'good-voice' })
  assert.deepEqual(s.changes, ['voice'])
})

test('a config file that cannot be parsed: settings read the defaults, but setConfig and the first-voice pick fail and leave it as it was', async (t) => {
  const s = await setup(t)
  writeFileSync(s.configFile, '{"voiceId": "v2", "promptSessions": tr')
  const original = readFileSync(s.configFile, 'utf8')
  assert.equal((await s.call('voice.settings', {})).result.voiceId, '')
  refused(await s.call('voice.setConfig', { modelId: 'eleven_turbo_v2_5' }), 'TOOL_ERROR')
  assert.equal(readFileSync(s.configFile, 'utf8'), original)
  const key = await s.call('voice.setKey', { apiKey: 'good-voice' })
  refused(key, 'TOOL_ERROR')
  assert.match(key.error.message, /key was stored.*voice could not be saved/)
  assert.equal(readFileSync(s.configFile, 'utf8'), original)
  writeFileSync(s.configFile, '[1]')
  refused(await s.call('voice.setConfig', { promptSessions: true }), 'TOOL_ERROR')
  assert.equal(readFileSync(s.configFile, 'utf8'), '[1]')
})

test('plugins.changed: a stored key, a cleared key and new voice settings say so; a refused or kept key and reads do not', async (t) => {
  const s = await setup(t)
  await s.call('voice.setKey', { apiKey: 'bad-voice' })
  assert.deepEqual(s.changes, [])
  await s.call('voice.setKey', { apiKey: 'good-voice' })
  await s.call('voice.setKey', { apiKey: 'other', ifAbsent: true })
  await s.call('voice.setConfig', { promptSessions: true })
  refused(await s.call('voice.setConfig', { voiceId: 'no spaces' }), 'BAD_REQUEST')
  await s.call('voice.clearKey', {})
  await s.call('voice.settings', {})
  assert.deepEqual(s.changes, ['voice', 'voice', 'voice'])
})

test("the 5b voice.json is copied into plugins/voice/config.json at setup and kept (a rollback reads it); the copy wins after", async (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'data'), { recursive: true })
  const legacy = join(dir, 'data', 'voice.json')
  const original = JSON.stringify({ voiceId: 'v9', modelId: 'eleven_multilingual_v2', promptSessions: true })
  writeFileSync(legacy, original)
  const { registry } = registryFor(dir)
  const call = (method, params) => dispatchV2(method, params, { plugins: registry })
  assert.deepEqual((await call('voice.settings', {})).result, { voiceId: 'v9', modelId: 'eleven_multilingual_v2', promptSessions: true, hasKey: false })
  const next = join(dir, 'data', 'plugins', 'voice', 'config.json')
  assert.equal(JSON.parse(readFileSync(next, 'utf8')).voiceId, 'v9')
  if (posix) assert.equal(statSync(next).mode & 0o777, 0o600)
  assert.equal(readFileSync(legacy, 'utf8'), original, 'kept as it was')
  // A change goes to the copy only; a later start reads the copy, not voice.json.
  await call('voice.setConfig', { voiceId: 'v2' })
  assert.equal(readFileSync(legacy, 'utf8'), original)
  const again = registryFor(dir).registry
  assert.equal((await dispatchV2('voice.settings', {}, { plugins: again })).result.voiceId, 'v2')
})

test("a plugin data dir that can't be made: voice still sets up, on the 5b voice.json in place", async (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'data', 'voice.json'), JSON.stringify({ voiceId: 'v7' }))
  // A file where the plugins directory would be.
  writeFileSync(join(dir, 'data', 'plugins'), '')
  const { registry, warnings } = registryFor(dir)
  assert.deepEqual(registry.presence().map((p) => p.id), ['voice'])
  assert.equal((await dispatchV2('voice.settings', {}, { plugins: registry })).result.voiceId, 'v7')
  assert.match(warnings.join('\n'), /data dir is not usable/)
})

test('migrateConfigFile: atomic (no half-written copy is ever there); a copy that fails reads the old file in place', (t) => {
  const dir = tempDir(t)
  const warnings = []
  const warn = (m) => warnings.push(m)
  const legacy = join(dir, 'voice.json')
  writeFileSync(legacy, '{"voiceId": "v1"}')
  // The new file's directory can't be made (a file is in its place): the copy fails, and nothing is written.
  writeFileSync(join(dir, 'plugins-file'), '')
  assert.equal(migrateConfigFile(legacy, join(dir, 'plugins-file', 'config.json'), warn), legacy)
  assert.match(warnings.pop(), /reading it where it is/)
  assert.deepEqual(readdirSync(dir).sort(), ['plugins-file', 'voice.json'], 'no temp file left')
  // Copied: the whole file, then it wins.
  const next = join(dir, 'plugins', 'config.json')
  assert.equal(migrateConfigFile(legacy, next, warn), next)
  assert.equal(readFileSync(next, 'utf8'), '{"voiceId": "v1"}')
  // Nothing to copy.
  assert.equal(migrateConfigFile(join(dir, 'none.json'), join(dir, 'other.json'), warn), join(dir, 'other.json'))
  assert.deepEqual(warnings, [])
})

// ---- speak_summary and the session prompt, in a project on a real git repo ----

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

function fakeSpawner() {
  const spawned = []
  const spawner = (opts) => {
    const proc = {
      opts, written: [], dataCb: () => {}, exitCb: () => {},
      onData(cb) { this.dataCb = cb }, onExit(cb) { this.exitCb = cb },
      write(d) { this.written.push(d) }, resize() {}, pause() {}, resume() {},
      kill() { setImmediate(() => this.exitCb(129)) }
    }
    spawned.push(proc)
    return proc
  }
  return { spawned, spawner }
}

/** A project with one worktree session, the voice plugin, and its MCP for the project. */
async function projectSetup(t, { key = 'good-voice', voiceId = 'v1', promptSessions = false } = {}) {
  const dir = tempDir(t)
  const voiceStub = await elevenLabsStub(t)
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  execFileSync('git', ['-C', a, 'commit', '--allow-empty', '-q', '-m', 'init'], { env: gitEnv })
  const configPath = join(dir, 'config.json')
  const registered = { id: 'a', name: 'a', path: a }
  saveConfig(configPath, { repos: [registered] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
  if (key) createSecretFile(join(dir, 'secrets.json')).set('elevenlabs', key)
  mkdirSync(join(dir, 'data', 'plugins', 'voice'), { recursive: true })
  writeFileSync(join(dir, 'data', 'plugins', 'voice', 'config.json'), JSON.stringify({ voiceId, promptSessions }))
  const { registry } = registryFor(dir, voiceStub.url, { projects, hub })
  const { spawned, spawner } = fakeSpawner()
  const sessions = new SessionManager({
    projects,
    store,
    hub,
    spawner,
    schedule: () => ({ cancel() {} }),
    discover: async () => undefined,
    mcpAccess: () => ({ configPath: '/c.json', url: 'http://x/mcp', token: 't', geminiSettingsPath: '/g.json' }),
    pluginPrompt: (projectId) => registry.sessionPrompt(projectId),
    // A POSIX server's launches on any OS: a Windows one looks the agent up on PATH before it spawns.
    platform: 'linux'
  })
  t.after(() => {
    sessions.stopAll()
    poller.stop()
    store.close()
  })
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const projectId = projects.create('P', [{ registered, name: undefined }])
  await poller.refresh(a)
  const core = createToolCaller({ store, hub, projects, poller, sessions, pollMs: 5, graceMs: 10, readyTimeouts: { firstOutputMs: 200, settleMs: 200 } })(projectId)
  const mcp = () => mcpContext(projectId, core, registry)
  const { terminalId } = await mcp().call('start_session', { worktree: 'main' })
  const setEnabled = (enabled) => dispatchV2('project.updateSettings', { projectId, settings: { plugins: { voice: { enabled } } } }, { projects, sessions })
  return { mcp, hub, projects, projectId, terminalId, voiceStub, spawned, setEnabled, sessions }
}

test('speak_summary sends the clip to every window that has the project open', async (t) => {
  const s = await projectSetup(t)
  const topic = `project:${s.projectId}`
  const windows = [[], [], []]
  const subscribers = windows.map((got, i) => ({ send() {}, event: (event, payload) => (i === 2 ? false : (got.push([event, payload]), true)) }))
  const speak = (summary, terminalId = s.terminalId) => s.mcp().call('speak_summary', { terminalId, summary })
  // Nobody listening: nothing synthesized.
  assert.deepEqual(await speak('Done.'), { played: false, reason: 'No Trek window has this project open, so nobody would hear it' })
  assert.equal(s.voiceStub.requests.length, 0)
  // A subscriber that takes no events, as an MCP tool call's is, is nobody too.
  s.hub.subscribe(topic, { send() {} })
  assert.deepEqual(await speak('Done.'), { played: false, reason: 'No Trek window has this project open, so nobody would hear it' })
  for (const sub of subscribers) s.hub.subscribe(topic, sub)
  // The third window is congested: it does not count.
  assert.deepEqual(await speak('  The tests pass.  '), { played: true, windows: 2 })
  const audio = Buffer.from('mp3:v1:eleven_flash_v2_5:The tests pass.').toString('base64')
  for (const got of windows.slice(0, 2)) assert.deepEqual(got, [['voice.summary', { projectId: s.projectId, sessionId: s.terminalId, text: 'The tests pass.', audio }]])
  await assert.rejects(speak('x'.repeat(401)), /401 characters/)
  await assert.rejects(speak(' '), /summary is required/)
  await assert.rejects(speak('Hi', 'nope'), /No session/)
  assert.equal(s.voiceStub.requests.length, 1)
})

test('speak_summary without a key or without a chosen voice says it is not set up', async (t) => {
  for (const options of [{ key: null }, { voiceId: '' }]) {
    const s = await projectSetup(t, options)
    s.hub.subscribe(`project:${s.projectId}`, { send() {}, event: () => true })
    const result = await s.mcp().call('speak_summary', { terminalId: s.terminalId, summary: 'Hi' })
    assert.equal(result.played, false)
    assert.match(result.reason, /not set up/)
    assert.equal(s.voiceStub.requests.length, 0)
  }
})

test('off for the project: no speak_summary in its tools or instructions, its calls refused, no summary sent, no session prompt', async (t) => {
  const s = await projectSetup(t, { promptSessions: true })
  assert.ok(s.mcp().tools.some((tool) => tool.name === 'speak_summary'))
  assert.match(s.mcp().instructions, /speak_summary reads a short summary aloud/)
  assert.ok(s.spawned[0].opts.args.join(' ').includes(VOICE_SUMMARY_PROMPT.slice(0, 40)), 'the first session got the prompt')
  assert.equal((await s.setEnabled(false)).ok, true)
  assert.equal(s.mcp().tools.some((tool) => tool.name === 'speak_summary'), false)
  assert.doesNotMatch(s.mcp().instructions, /speak_summary/)
  await assert.rejects(s.mcp().call('speak_summary', { terminalId: s.terminalId, summary: 'Hi' }), /Unknown tool: speak_summary/)
  const { terminalId } = await s.mcp().call('start_session', { worktree: 'main' })
  assert.ok(terminalId)
  assert.equal(s.spawned[1].opts.args.join(' ').includes(VOICE_SUMMARY_PROMPT.slice(0, 40)), false, 'the next session did not')
  await s.setEnabled(true)
  assert.ok(s.mcp().tools.some((tool) => tool.name === 'speak_summary'))
})

test('the session prompt needs a key, a chosen voice and "Summarize automatically" on', async (t) => {
  for (const [options, prompted] of [[{ promptSessions: true }, true], [{ promptSessions: false }, false], [{ promptSessions: true, key: null }, false], [{ promptSessions: true, voiceId: '' }, false]]) {
    const s = await projectSetup(t, options)
    assert.equal(s.spawned[0].opts.args.join(' ').includes(VOICE_SUMMARY_PROMPT.slice(0, 40)), prompted, JSON.stringify(options))
  }
})
