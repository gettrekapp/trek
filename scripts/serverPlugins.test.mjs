// scripts/serverPlugins.test.mjs — trek-server's plugin registry (plugin system phase 1): setup,
// refused ids and tools, `<id>.*` methods through dispatchV2 with their errors, per-project
// enablement of MCP tools, instructions, session prompts and events, the host's secrets and data
// files, and the welcome's plugins and legacy capabilities.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { dispatchV2, isCoreMethod } from '../server/src/v2.ts'
import { mcpContext } from '../server/src/plugins/mcp.ts'
import { welcomeCapabilities } from '../server/src/capabilities.ts'
import { MCP_INSTRUCTIONS, MCP_TOOLS } from '../server/src/mcp/tools.ts'
import { pluginError } from '../src/shared/plugins/server.ts'
import { applySettingsPatch, isSettingsKey, validateSettings } from '../server/src/projects/settings.ts'

/** Projects by id with their settings and sessions; `require` throws NOT_FOUND like ProjectState's. */
function fakeProjects(projects) {
  return {
    require: (id) => {
      const p = projects[id]
      if (!p) throw Object.assign(new Error(`No project with id "${id}"`), { code: 'NOT_FOUND' })
      return p
    }
  }
}
const project = (id, plugins) => ({
  id,
  settings: plugins ? { plugins } : {},
  globalSessions: [{ id: 'g1' }],
  repositories: [{ worktrees: [{ id: 'w1', sessions: [{ id: 's1' }] }] }]
})

function fakeHub(subscribers = {}) {
  const emitted = []
  return {
    emitted,
    emit: (topic, event, payload) => {
      emitted.push([topic, event, payload])
      return subscribers[topic] ?? 0
    },
    eventSubscriberCount: (topic) => subscribers[topic] ?? 0
  }
}

const manifest = (id, more = {}) => ({ id, version: '1.0.0', name: id, description: '', defaultEnabled: true, ...more })

function setup(t, plugins, { projects = { p1: project('p1'), p2: project('p2', { echo: { enabled: false } }) }, hub = fakeHub() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-plugins-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const warnings = []
  const registry = createPluginRegistry({
    plugins,
    secretsFile: join(dir, 'secrets.json'),
    dataDir: join(dir, 'data'),
    hub,
    projects: fakeProjects(projects),
    isCoreMethod,
    coreToolNames: MCP_TOOLS.map((tool) => tool.name),
    env: { TREK_SERVER_ECHO_URL: 'http://127.0.0.1:9/x', TREK_SERVER_BAD_URL: 'https://example.com' },
    warn: (m) => warnings.push(m)
  })
  return { dir, registry, warnings, hub }
}

/** A plugin that records its host and answers echo.* methods. */
function echoPlugin(more = {}) {
  const seen = {}
  const plugin = {
    manifest: manifest('echo', { legacyCapability: 'echo', secrets: ['echo-key'], ...more.manifest }),
    setup(host) {
      seen.host = host
      return {
        handlers: {
          say: (p, ctx) => ({ said: p.text, ...(ctx.projectId ? { projectId: ctx.projectId } : {}) }),
          bad: () => {
            throw pluginError('BAD_REQUEST', 'no good')
          },
          boom: () => {
            throw new Error('exploded')
          },
          internal: () => {
            throw Object.assign(new Error('raw'), { code: 'INTERNAL' })
          },
          later: async () => 'done'
        },
        mcpTools: [
          {
            definition: { name: 'echo_tool', description: 'Echoes', inputSchema: { type: 'object' } },
            call: (args, ctx) => ({ args, projectId: ctx.projectId })
          }
        ],
        mcpInstructions: 'echo_tool echoes.',
        sessionPrompt: (projectId) => `ECHO for ${projectId}`,
        ...more.instance
      }
    }
  }
  return { plugin, seen }
}

test('a plugin is set up once; the welcome lists it and its legacy capability', (t) => {
  const { plugin } = echoPlugin()
  const { registry } = setup(t, [plugin])
  assert.deepEqual(registry.presence(), [{ id: 'echo', version: '1.0.0', defaultEnabled: true }])
  assert.deepEqual(registry.legacyCapabilities(), ['echo'])
  const caps = welcomeCapabilities(false, false, false, registry.legacyCapabilities())
  assert.ok(caps.includes('echo'))
  // A legacy capability the server lists anyway is not listed twice.
  assert.equal(welcomeCapabilities(false, false, false, ['linear']).filter((c) => c === 'linear').length, 1)
})

test('refused: a bad id, a duplicate, a core or reserved namespace, a setup that throws, a tool named like another', (t) => {
  const ok = echoPlugin().plugin
  const plugins = [
    { manifest: manifest('Bad'), setup: () => ({ handlers: {} }) },
    ok,
    { manifest: manifest('echo'), setup: () => ({ handlers: {} }) },
    { manifest: manifest('session'), setup: () => ({ handlers: {} }) },
    { manifest: manifest('plugins'), setup: () => ({ handlers: {} }) },
    {
      manifest: manifest('throws'),
      setup: () => {
        throw new Error('no key file')
      }
    },
    { manifest: manifest('shadow'), setup: () => ({ handlers: {}, mcpTools: [{ definition: { name: 'list_worktrees', description: '', inputSchema: {} }, call: () => 1 }] }) },
    { manifest: manifest('twice'), setup: () => ({ handlers: {}, mcpTools: [{ definition: { name: 'echo_tool', description: '', inputSchema: {} }, call: () => 1 }] }) }
  ]
  const { registry, warnings } = setup(t, plugins)
  assert.deepEqual(registry.presence().map((p) => p.id), ['echo'])
  assert.equal(warnings.length, 7)
  assert.match(warnings.join('\n'), /Bad not loaded: its id is not a plugin id/)
  assert.match(warnings.join('\n'), /echo not loaded: another plugin has that id/)
  assert.match(warnings.join('\n'), /session not loaded: its id is a core namespace/)
  assert.match(warnings.join('\n'), /plugins not loaded: its id is a core namespace/)
  assert.match(warnings.join('\n'), /throws not loaded: its setup failed: no key file/)
  assert.match(warnings.join('\n'), /shadow not loaded: its MCP tool list_worktrees/)
  assert.match(warnings.join('\n'), /twice not loaded: its MCP tool echo_tool/)
})

test("dispatchV2: <id>.<method> reaches the plugin, with the request's projectId; its errors as the wire sees them", async (t) => {
  const { registry } = setup(t, [echoPlugin().plugin])
  const ctx = { plugins: registry }
  assert.deepEqual(await dispatchV2('echo.say', { text: 'hi', projectId: 'p1' }, ctx), { ok: true, result: { said: 'hi', projectId: 'p1' } })
  assert.deepEqual(await dispatchV2('echo.say', { text: 'hi' }, ctx), { ok: true, result: { said: 'hi' } })
  assert.deepEqual(await dispatchV2('echo.later', {}, ctx), { ok: true, result: 'done' })
  assert.deepEqual(await dispatchV2('echo.bad', {}, ctx), { ok: false, error: { code: 'BAD_REQUEST', message: 'no good' } })
  assert.deepEqual(await dispatchV2('echo.boom', {}, ctx), { ok: false, error: { code: 'TOOL_ERROR', message: 'exploded' } })
  assert.deepEqual(await dispatchV2('echo.internal', {}, ctx), { ok: false, error: { code: 'TOOL_ERROR', message: 'raw' } })
  for (const method of ['echo.nope', 'echo.', 'nobody.say', 'echo', 'echo.hasOwnProperty', 'echo.__proto__']) {
    assert.deepEqual(await dispatchV2(method, {}, ctx), { ok: false, error: { code: 'NOT_FOUND', message: `Unknown method: ${method}` } }, method)
  }
  // Without plugins, as before.
  assert.equal((await dispatchV2('echo.say', {}, {})).error.code, 'NOT_FOUND')
})

test('enablement: the project setting, else the default; a project that is not there is off', (t) => {
  const { plugin } = echoPlugin()
  const off = { manifest: manifest('quiet', { defaultEnabled: false }), setup: () => ({ handlers: {} }) }
  const { registry } = setup(t, [plugin, off], {
    projects: { p1: project('p1'), p2: project('p2', { echo: { enabled: false }, quiet: { enabled: true } }) }
  })
  assert.equal(registry.enabled('p1', 'echo'), true)
  assert.equal(registry.enabled('p2', 'echo'), false)
  assert.equal(registry.enabled('p1', 'quiet'), false)
  assert.equal(registry.enabled('p2', 'quiet'), true)
  assert.equal(registry.enabled('gone', 'echo'), false)
  assert.equal(registry.enabled('p1', 'nobody'), false)
})

test("MCP: a plugin's tools and instructions only in projects where it is on; its calls; core tools unchanged", async (t) => {
  const { registry } = setup(t, [echoPlugin().plugin])
  const core = async (name) => `core ${name}`
  const on = mcpContext('p1', core, registry)
  assert.equal(on.tools.length, MCP_TOOLS.length + 1)
  assert.equal(on.tools.at(-1).name, 'echo_tool')
  assert.equal(on.instructions, `${MCP_INSTRUCTIONS} echo_tool echoes.`)
  assert.deepEqual(await on.call('echo_tool', { a: 1 }), { args: { a: 1 }, projectId: 'p1' })
  assert.equal(await on.call('list_worktrees', {}), 'core list_worktrees')
  const off = mcpContext('p2', core, registry)
  assert.equal(off.tools, MCP_TOOLS)
  assert.equal(off.instructions, MCP_INSTRUCTIONS)
  assert.equal(await off.call('echo_tool', {}), 'core echo_tool', 'not the plugin: the core caller refuses it as unknown')
  assert.equal(mcpContext('p1', core, undefined).tools, MCP_TOOLS)
})

test("session prompts: those of the plugins on in the project, joined; one that throws is left out", (t) => {
  const quiet = { manifest: manifest('second'), setup: () => ({ handlers: {}, sessionPrompt: () => '  SECOND  ' }) }
  const broken = {
    manifest: manifest('broken'),
    setup: () => ({
      handlers: {},
      sessionPrompt: () => {
        throw new Error('unreadable')
      }
    })
  }
  const { registry, warnings } = setup(t, [echoPlugin().plugin, quiet, broken])
  assert.equal(registry.sessionPrompt('p1'), 'ECHO for p1\n\nSECOND')
  assert.equal(registry.sessionPrompt('p2'), 'SECOND')
  assert.match(warnings.join('\n'), /broken.*session prompt failed: unreadable/)
  assert.equal(setup(t, [quiet]).registry.sessionPrompt('gone'), undefined)
})

test("the host: emit only where on, as <id>.<event>; subscribers; the session lookup", (t) => {
  const { plugin, seen } = echoPlugin()
  const hub = fakeHub({ 'project:p1': 2, 'project:p2': 1 })
  setup(t, [plugin], { hub })
  const { host } = seen
  assert.equal(host.emit('p1', 'said', { x: 1 }), 2)
  assert.equal(host.emit('p2', 'said', { x: 2 }), 0)
  assert.equal(host.emit('gone', 'said', {}), 0)
  assert.deepEqual(hub.emitted, [['project:p1', 'echo.said', { x: 1 }]])
  assert.equal(host.subscriberCount('p1'), 2)
  assert.equal(host.isEnabled('p1'), true)
  assert.equal(host.isEnabled('p2'), false)
  assert.deepEqual(host.session('p1', 's1'), { sessionId: 's1', global: false })
  assert.deepEqual(host.session('p1', 'g1'), { sessionId: 'g1', global: true })
  assert.throws(() => host.session('p1', ''), (err) => err.code === 'BAD_REQUEST')
  assert.throws(() => host.session('p1', 'nope'), (err) => err.code === 'NOT_FOUND')
  assert.throws(() => host.session('gone', 's1'), (err) => err.code === 'NOT_FOUND')
})

test("the host: only the manifest's secrets, in the server's secrets file; data files in plugins/<id> (0700); test endpoints on loopback", (t) => {
  const { plugin, seen } = echoPlugin()
  const { dir } = setup(t, [plugin])
  const { host } = seen
  const slot = host.secret('echo-key')
  assert.equal(slot.get(), null)
  slot.set('k1')
  assert.equal(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))['echo-key'], 'k1')
  assert.throws(() => host.secret('elevenlabs'), /no secret named elevenlabs/)
  const file = host.dataFile('config.json')
  assert.equal(file, join(dir, 'data', 'plugins', 'echo', 'config.json'))
  assert.equal(statSync(join(dir, 'data', 'plugins', 'echo')).mode & 0o777, 0o700)
  assert.equal(existsSync(file), false)
  assert.equal(host.legacyDataFile('voice.json'), join(dir, 'data', 'voice.json'))
  // One path segment only: a plugin keeps to its own directory.
  for (const name of ['', '.', '..', '../secrets.json', 'a/b', 'a\\b', 'x\0y']) {
    assert.throws(() => host.dataFile(name), /not a data file name/, name)
    assert.throws(() => host.legacyDataFile(name), /not a data file name/, name)
  }
  assert.equal(host.testEndpoint('TREK_SERVER_ECHO_URL'), 'http://127.0.0.1:9/x')
  assert.equal(host.testEndpoint('TREK_SERVER_BAD_URL'), undefined)
  assert.equal(host.testEndpoint('TREK_SERVER_UNSET_URL'), undefined)
})

test('changed() reaches the listeners with the manifest; dispose() disposes each plugin once', (t) => {
  let disposed = 0
  const { plugin, seen } = echoPlugin({ instance: { dispose: () => disposed++ } })
  const { registry } = setup(t, [plugin])
  const heard = []
  registry.onChanged((m) => heard.push(m.id))
  seen.host.changed()
  assert.deepEqual(heard, ['echo'])
  assert.ok(registry.handler('echo.say'))
  registry.dispose()
  assert.equal(disposed, 1)
  // Idempotent: a second dispose disposes nothing; after it the registry has no plugin and no listener.
  registry.dispose()
  assert.equal(disposed, 1)
  assert.equal(registry.handler('echo.say'), undefined)
  assert.deepEqual(registry.presence(), [])
  seen.host.changed()
  assert.deepEqual(heard, ['echo'])
})

// ---- Plugin project settings and ticket providers (plugin system phase 2) ----

test("project settings: a plugin's declared keys, accepted with their kind and the plugin's check; a clash refused", (t) => {
  const tracker = {
    manifest: manifest('tracker', { projectSettings: { trackerSpace: 'string' } }),
    setup: () => ({ handlers: {}, checkProjectSetting: (key, value) => (/^[a-z]+$/.test(value) ? null : `${key} must be lowercase letters`) })
  }
  const clashCore = { manifest: manifest('clashcore', { projectSettings: { audioAlerts: 'string' } }), setup: () => ({ handlers: {} }) }
  const clashOther = { manifest: manifest('clashother', { projectSettings: { trackerSpace: 'string' } }), setup: () => ({ handlers: {} }) }
  const { registry, warnings } = setup(t, [tracker, clashCore, clashOther])
  assert.deepEqual(registry.presence().map((p) => p.id), ['tracker'])
  assert.match(warnings.join('\n'), /clashcore not loaded: its project setting audioAlerts/)
  assert.match(warnings.join('\n'), /clashother not loaded: its project setting trackerSpace/)
  const rules = registry.settingRules
  assert.equal(rules.kind('trackerSpace'), 'string')
  assert.equal(rules.kind('audioAlerts'), undefined, 'a core key is not a plugin one')
  assert.equal(rules.kind('nope'), undefined)
  assert.deepEqual(applySettingsPatch({}, { trackerSpace: 'team' }, rules), { trackerSpace: 'team' })
  assert.deepEqual(applySettingsPatch({ trackerSpace: 'team' }, { trackerSpace: null }, rules), {})
  assert.throws(() => applySettingsPatch({}, { trackerSpace: 'Team!' }, rules), (err) => err.code === 'BAD_REQUEST' && /settings\.trackerSpace: trackerSpace must be lowercase/.test(err.message))
  assert.throws(() => applySettingsPatch({}, { trackerSpace: 1 }, rules), (err) => err.code === 'BAD_REQUEST' && /must be a string/.test(err.message))
  assert.throws(() => applySettingsPatch({}, { trackerSpace: 'team' }), (err) => err.code === 'BAD_REQUEST', 'without the rules it is no setting')
  assert.deepEqual(validateSettings({ trackerSpace: 'team', audioAlerts: true }, 'project.settings', rules), { trackerSpace: 'team', audioAlerts: true })
  assert.equal(isSettingsKey('trackerSpace', rules), true)
  assert.equal(isSettingsKey('trackerSpace'), false)
})

test("project settings: a plugin's key is accepted in a project where it is off; its check throwing is the setting's problem", (t) => {
  const tracker = {
    manifest: manifest('tracker', { projectSettings: { trackerSpace: 'string' } }),
    setup: () => ({
      handlers: {},
      checkProjectSetting: () => {
        throw new Error('no idea')
      }
    })
  }
  const { registry } = setup(t, [tracker], { projects: { p1: project('p1', { tracker: { enabled: false } }) } })
  assert.equal(registry.enabled('p1', 'tracker'), false)
  assert.throws(() => applySettingsPatch({}, { trackerSpace: 'x' }, registry.settingRules), /settings\.trackerSpace: its check failed: no idea/)
  const quiet = { manifest: manifest('quiet', { projectSettings: { quietKey: 'string' } }), setup: () => ({ handlers: {} }) }
  const plain = setup(t, [quiet], { projects: { p1: project('p1', { quiet: { enabled: false } }) } })
  assert.deepEqual(applySettingsPatch({}, { quietKey: 'anything' }, plain.registry.settingRules), { quietKey: 'anything' }, 'no check: the kind only')
})

test('ticketProviders: those of the plugins on in the project, in registration order', (t) => {
  const provider = (id) => ({ id, owns: () => false, parse: () => null, label: (x) => x, url: () => null })
  const a = { manifest: manifest('a'), setup: () => ({ handlers: {}, ticketProvider: provider('a') }) }
  const b = { manifest: manifest('b'), setup: () => ({ handlers: {}, ticketProvider: provider('b') }) }
  const none = { manifest: manifest('none'), setup: () => ({ handlers: {} }) }
  const { registry } = setup(t, [a, none, b], { projects: { p1: project('p1'), p2: project('p2', { a: { enabled: false } }) } })
  assert.deepEqual(registry.ticketProviders('p1').map((p) => p.id), ['a', 'b'])
  assert.deepEqual(registry.ticketProviders('p2').map((p) => p.id), ['b'])
  assert.deepEqual(registry.ticketProviders('gone'), [])
})

test("dispatchV2: project.updateSettings and its expected take a plugin's keys", async (t) => {
  const { ProjectState } = await import('../server/src/projects/state.ts')
  const { TopicHub } = await import('../server/src/topicHub.ts')
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} }, [{ id: 'p1', name: 'P', settings: {}, repositories: [], globalSessions: [] }])
  const tracker = { manifest: manifest('tracker', { projectSettings: { trackerSpace: 'string' } }), setup: () => ({ handlers: {} }) }
  const { registry } = setup(t, [tracker], { projects, hub })
  const ctx = { projects, plugins: registry, sessions: { refreshAttention() {} } }
  assert.equal((await dispatchV2('project.updateSettings', { projectId: 'p1', settings: { trackerSpace: 'team' } }, ctx)).ok, true)
  assert.equal(projects.require('p1').settings.trackerSpace, 'team')
  const stale = await dispatchV2('project.updateSettings', { projectId: 'p1', settings: { trackerSpace: 'x' }, expected: { trackerSpace: 'old' } }, ctx)
  assert.equal(stale.error.code, 'CONFLICT')
  assert.equal((await dispatchV2('project.updateSettings', { projectId: 'p1', settings: { trackerSpace: 'x' } }, { ...ctx, plugins: undefined })).error.code, 'BAD_REQUEST')
})
