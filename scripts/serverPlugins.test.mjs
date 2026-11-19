// scripts/serverPlugins.test.mjs — trek-server's plugin registry (plugin system phase 1): setup,
// refused ids and tools, `<id>.*` methods through dispatchV2 with their errors, per-project
// enablement of MCP tools, instructions, session prompts and events, the host's secrets and data
// files, and the welcome's plugins and legacy capabilities.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, statSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { toWireError } from '../server/src/errors.ts'
import { dispatchV2, isCoreMethod } from '../server/src/v2.ts'
import { mcpContext } from '../server/src/plugins/mcp.ts'
import { welcomeCapabilities } from '../server/src/capabilities.ts'
import { MCP_INSTRUCTIONS, MCP_TOOLS } from '../server/src/mcp/tools.ts'
import { pluginError } from '../src/shared/plugins/server.ts'
import { applySettingsPatch, isSettingsKey, PLUGIN_OWNED_SETTINGS, validateSettings } from '../server/src/projects/settings.ts'
import { BUILTIN_SERVER_PLUGINS } from '../plugins/builtin.server.ts'
import { removeDir } from './testPlatform.mjs'
import { createEventSink } from '../server/src/integrations/machineHandlers.ts'

// Windows has no POSIX mode bits to check (owner-only there is the profile's ACL).
const posix = process.platform !== 'win32'

/** Projects by id with their settings and sessions; `require` throws NOT_FOUND like ProjectState's. */
function fakeProjects(projects) {
  return {
    require: (id) => {
      const p = projects[id]
      if (!p) throw Object.assign(new Error(`No project with id "${id}"`), { code: 'NOT_FOUND' })
      return p
    },
    all: () => Object.values(projects)
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

function setup(t, plugins, { projects = { p1: project('p1'), p2: project('p2', { echo: { enabled: false } }) }, hub = fakeHub(), platform } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-plugins-'))
  t.after(() => removeDir(dir))
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
    warn: (m) => warnings.push(m),
    ...(platform ? { platform } : {})
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
  assert.match(warnings.join('\n'), /Bad not loaded: its id is not a usable plugin id/)
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
  if (posix) assert.equal(statSync(join(dir, 'data', 'plugins', 'echo')).mode & 0o777, 0o700)
  assert.equal(existsSync(file), false)
  assert.equal(host.legacyDataFile('voice.json'), join(dir, 'data', 'voice.json'))
  // One path segment only: a plugin keeps to its own directory.
  for (const name of ['', '.', '..', '../secrets.json', 'a/b', 'a\\b', 'x\0y', 'config.json:stream', 'C:config.json']) {
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

test("refused: a ticket provider whose id is not its plugin's (disposed)", (t) => {
  const provider = (id) => ({ id, hint: '', owns: () => false, parse: () => null, label: (x) => x, url: () => null })
  let disposed = 0
  const wrong = { manifest: manifest('wrong'), setup: () => ({ handlers: {}, ticketProvider: provider('other'), dispose: () => disposed++ }) }
  const right = { manifest: manifest('right'), setup: () => ({ handlers: {}, ticketProvider: provider('right') }) }
  const { registry, warnings } = setup(t, [wrong, right])
  assert.deepEqual(registry.presence().map((p) => p.id), ['right'])
  assert.match(warnings.join('\n'), /wrong not loaded: its ticket provider's id "other" is not the plugin's id/)
  assert.equal(disposed, 1)
  assert.deepEqual(registry.ticketProviders('p1').map((p) => p.id), ['right'])
})

test("refused before setup: a project setting of a kind other than 'string', or with an empty key", (t) => {
  let setups = 0
  const spy = () => {
    setups++
    return { handlers: {} }
  }
  const badKind = { manifest: manifest('badkind', { projectSettings: { someFlag: 'boolean' } }), setup: spy }
  const emptyKey = { manifest: manifest('emptykey', { projectSettings: { '': 'string' } }), setup: spy }
  const { registry, warnings } = setup(t, [badKind, emptyKey])
  assert.deepEqual(registry.presence(), [])
  assert.equal(setups, 0, "a refused plugin's setup is never called")
  assert.match(warnings.join('\n'), /badkind not loaded: its project setting someFlag is of a kind other than 'string'/)
  assert.match(warnings.join('\n'), /emptykey not loaded: it declares a project setting with an empty key/)
  assert.equal(registry.settingRules.kind('someFlag'), undefined)
})

test('PLUGIN_OWNED_SETTINGS: exactly the project settings the built-in server plugins declare', () => {
  const declared = BUILTIN_SERVER_PLUGINS.flatMap((p) => Object.keys(p.manifest.projectSettings ?? {}))
  for (const key of PLUGIN_OWNED_SETTINGS) assert.ok(declared.includes(key), `${key} is declared by a built-in plugin`)
  for (const key of declared) assert.ok(PLUGIN_OWNED_SETTINGS.includes(key), `${key} is in PLUGIN_OWNED_SETTINGS`)
})

test("dispatchV2: project.updateSettings with a plugin's key null removes it; an expected naming an unknown key is BAD_REQUEST", async (t) => {
  const { ProjectState } = await import('../server/src/projects/state.ts')
  const { TopicHub } = await import('../server/src/topicHub.ts')
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} }, [{ id: 'p1', name: 'P', settings: { trackerSpace: 'team', audioAlerts: true }, repositories: [], globalSessions: [] }])
  const tracker = { manifest: manifest('tracker', { projectSettings: { trackerSpace: 'string' } }), setup: () => ({ handlers: {} }) }
  const { registry } = setup(t, [tracker], { projects, hub })
  const ctx = { projects, plugins: registry, sessions: { refreshAttention() {} } }
  assert.equal((await dispatchV2('project.updateSettings', { projectId: 'p1', settings: { trackerSpace: null } }, ctx)).ok, true)
  assert.equal(Object.hasOwn(projects.require('p1').settings, 'trackerSpace'), false)
  assert.equal(projects.require('p1').settings.audioAlerts, true)
  const unknown = await dispatchV2('project.updateSettings', { projectId: 'p1', settings: { trackerSpace: 'x' }, expected: { nope: 'old' } }, ctx)
  assert.equal(unknown.error.code, 'BAD_REQUEST')
  assert.equal(Object.hasOwn(projects.require('p1').settings, 'trackerSpace'), false, 'nothing written')
})

test("project.import checks a plugin's setting by kind only (a project saved before its plugin checked it still imports)", async (t) => {
  const { checkImport } = await import('../server/src/projects/importCheck.ts')
  const tracker = { manifest: manifest('tracker', { projectSettings: { trackerSpace: 'string' } }), setup: () => ({ handlers: {}, checkProjectSetting: () => 'never valid' }) }
  const { registry } = setup(t, [tracker])
  const raw = (settings) => ({ name: 'P', settings, repositories: [{ id: 'r', name: 'r', path: '/nowhere', worktrees: [] }], globalSessions: [] })
  const ctx = { registry: [], guard: { check() {} }, existingIds: new Set(), projectId: 'new', settingRules: registry.settingRules }
  // The settings pass (the repository's own check fails after them, as it should here).
  const err = (() => {
    try {
      checkImport(raw({ trackerSpace: 'loose value' }), ctx)
    } catch (e) {
      return e
    }
  })()
  assert.doesNotMatch(err?.message ?? '', /trackerSpace/)
  assert.throws(() => checkImport(raw({ trackerSpace: 5 }), ctx), /project\.settings\.trackerSpace must be a string/)
  // A live edit still gets the plugin's check.
  assert.throws(() => applySettingsPatch({}, { trackerSpace: 'loose value' }, registry.settingRules), /never valid/)
})

test("project.import keeps a built-in plugin's setting when that plugin didn't load on the server", async (t) => {
  const { checkImport } = await import('../server/src/projects/importCheck.ts')
  const { registry } = setup(t, [])
  const raw = { name: 'P', settings: { linearWorkspace: 'acme team', azureDevOpsBaseUrl: 'dev.azure.com/o/p' }, repositories: [{ id: 'r', name: 'r', path: '/nowhere', worktrees: [] }], globalSessions: [] }
  const ctx = { registry: [], guard: { check() {} }, existingIds: new Set(), projectId: 'new', settingRules: registry.settingRules }
  const err = (() => {
    try {
      checkImport(raw, ctx)
    } catch (e) {
      return e
    }
  })()
  // The settings pass; the import goes on to the repository, which fails here as it should.
  assert.doesNotMatch(err?.message ?? '', /linearWorkspace|azureDevOpsBaseUrl/)
  assert.throws(() => checkImport({ ...raw, settings: { notAKey: 'x' } }, ctx), /notAKey is not a project setting/)
})

test("prProviders: the PR providers of plugins on for the project; one whose id is not its plugin's is refused", (t) => {
  const provider = (id) => ({ id, hint: 'h', signInName: 's', parse: () => null, owns: () => false, available: async () => true, read: async () => { throw new Error('x') }, headBranch: async () => null, fetchRef: (n) => `refs/pull/${n}/head`, promptHint: { checks: '', comments: '' } })
  const { registry: reg, warnings } = setup(t, [
    { manifest: manifest('hosta', { name: 'A' }), setup: () => ({ handlers: {}, prProvider: provider('hosta') }) },
    { manifest: manifest('hostb', { name: 'B', defaultEnabled: false }), setup: () => ({ handlers: {}, prProvider: provider('hostb') }) },
    { manifest: manifest('liar', { name: 'L' }), setup: () => ({ handlers: {}, prProvider: provider('other') }) }
  ])
  assert.deepEqual(reg.prProviders('p1').map((p) => p.id), ['hosta'])
  assert.deepEqual(reg.allPrProviders().map((p) => p.id), ['hosta', 'hostb'])
  assert.ok(warnings.some((w) => w.includes('liar') && w.includes('pull request provider')))
})

test("a plugin's NOT_SIGNED_IN passes the registry as it is and reaches the wire as TOOL_ERROR; host.run is aborted by dispose", async (t) => {
  let host
  const { registry: reg } = setup(t, [
    {
      manifest: manifest('hosta', { name: 'A' }),
      setup: (h) => {
        host = h
        return { handlers: { check: () => { throw Object.assign(new Error('sign in'), { code: 'NOT_SIGNED_IN' }) } } }
      }
    }
  ])
  const err = await reg.handler('hosta.check')({ projectId: 'p1' }).catch((e) => e)
  assert.equal(err.code, 'NOT_SIGNED_IN')
  // It is for the server's own watch; on the wire it is a TOOL_ERROR with its message.
  assert.deepEqual(toWireError('hosta.check', err), { code: 'TOOL_ERROR', message: 'sign in' })
  const running = host.run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'])
  reg.dispose()
  await assert.rejects(running)
})

test('host.testCommand: the fallback when unset, an absolute path as it is, null otherwise', (t) => {
  let host
  const plugin = { manifest: manifest('hosta'), setup: (h) => ((host = h), { handlers: {} }) }
  const { warnings } = setup(t, [plugin])
  assert.equal(host.testCommand('TREK_SERVER_NOPE', 'gh'), 'gh')
  assert.equal(host.testCommand('TREK_SERVER_BAD_URL', 'gh'), null)
  assert.ok(warnings.some((w) => w.includes('TREK_SERVER_BAD_URL')))
})

test("host.spawn (plugins E1): only in a project's repository or worktree, or the plugin's data directory; dispose kills its children, not a detached one", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-spawn-cwd-')))
  t.after(() => removeDir(root))
  const repoPath = join(root, 'app')
  const wtPath = join(root, 'app-feat')
  const gonePath = join(root, 'app-gone')
  for (const dir of [repoPath, wtPath, gonePath]) mkdirSync(dir)
  const repo = {
    id: 'r1', name: 'app', path: repoPath, branchData: {},
    worktrees: [
      { id: 'w1', path: repoPath, isMain: true, sessions: [] },
      { id: 'w2', path: wtPath, branch: 'feat', isMain: false, sessions: [] },
      { id: 'w3', path: gonePath, branch: 'gone', isMain: false, missing: true, sessions: [] }
    ]
  }
  let host
  const runner = { manifest: manifest('runner'), setup: (h) => ((host = h), { handlers: {} }) }
  const { registry, dir, warnings } = setup(t, [runner], { projects: { p1: { ...project('p1'), repositories: [repo] } } })
  // The data directory before any dataFile call: made for the spawn, not "not installed".
  const fresh = await host.spawn(process.execPath, ['-e', ''], { cwd: join(dir, 'data', 'plugins', 'runner') })
  assert.equal((await fresh.done).code, 0)
  const dataDir = dirname(host.dataFile('state.json'))
  for (const cwd of [repoPath, wtPath, dataDir]) {
    const child = await host.spawn(process.execPath, ['-e', ''], { cwd })
    assert.equal((await child.done).code, 0, cwd)
  }
  for (const cwd of [root, tmpdir(), gonePath, join(wtPath, 'sub'), '', undefined]) {
    await assert.rejects(host.spawn(process.execPath, ['-e', ''], { cwd }), /not a repository, a worktree|needs a cwd/, String(cwd))
  }
  // A worktree whose directory is gone (not yet marked missing): its own error, not "not installed".
  removeDir(gonePath)
  repo.worktrees[2].missing = false
  await assert.rejects(host.spawn(process.execPath, ['-e', ''], { cwd: gonePath }), (e) => /does not exist/.test(e.message) && e.code !== 'ENOENT')
  // A throwing onOutput: warned with the plugin's name, never an uncaught exception.
  const noisy = await host.spawn(process.execPath, ['-e', 'process.stdout.write("x")'], { cwd: repoPath, onOutput: () => { throw new Error('boom') } })
  await noisy.done
  assert.ok(warnings.some((w) => w.includes('[plugin runner]') && w.includes('boom')), warnings.join('\n'))
  // Each child with its own record of whether it has ended: the after-hook signals only a live one.
  const live = []
  const track = (child) => {
    const entry = { pid: child.pid, ended: false }
    void child.done.then(() => { entry.ended = true })
    live.push(entry)
    return child
  }
  t.after(() => {
    for (const entry of live) {
      if (entry.ended) continue
      try {
        // Still ours: signal 0 first, so a pid already gone is left alone.
        process.kill(entry.pid, 0)
        process.kill(entry.pid, 'SIGKILL')
      } catch {}
    }
  })
  let grandchildText = ''
  const script = 'const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(c.pid + "\\n"); setInterval(() => {}, 1000)'
  const attached = track(await host.spawn(process.execPath, ['-e', script], { cwd: repoPath, onOutput: (_s, chunk) => { grandchildText += chunk } }))
  const detached = track(await host.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: repoPath, detached: true }))
  for (const end = Date.now() + 5000; !grandchildText.includes('\n') && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20))
  const grandchild = Number(grandchildText.trim())
  assert.ok(grandchild > 0)
  // The grandchild is not a ChildProcess here: ended in the hook only while it is still there.
  t.after(() => {
    try {
      process.kill(grandchild, 0)
      process.kill(grandchild, 'SIGKILL')
    } catch {}
  })
  registry.dispose()
  const end = await attached.done
  assert.ok(end.code !== 0 || end.signal !== null, 'killed by dispose')
  if (process.platform !== 'win32') {
    let gone = false
    for (const until = Date.now() + 5000; !gone && Date.now() < until; await new Promise((r) => setTimeout(r, 50))) {
      try {
        process.kill(grandchild, 0)
      } catch {
        gone = true
      }
    }
    assert.ok(gone, "dispose ended the child's grandchild too")
  }
  assert.doesNotThrow(() => process.kill(detached.pid, 0), 'a detached child outlives the dispose')
  // Unref'd, so its done can't hold the test open: wait for the pid to go.
  detached.kill()
  let detachedGone = false
  for (const until = Date.now() + 5000; !detachedGone && Date.now() < until; await new Promise((r) => setTimeout(r, 50))) {
    try {
      process.kill(detached.pid, 0)
    } catch {
      detachedGone = true
    }
  }
  live[1].ended = detachedGone
  assert.ok(detachedGone, 'kill() ends a detached child')
})

test("emitTo (plugins E1): a plugin's event to the connection that sent the request (ctx.caller); an unknown or closed caller is a no-op; only its own events", async (t) => {
  let host
  const teller = {
    manifest: manifest('teller'),
    setup: (h) => {
      host = h
      return {
        handlers: {
          tell: (p, ctx) => {
            host.emitTo(ctx.caller, 'teller.told', { text: p.text })
            return ctx.caller
          }
        }
      }
    }
  }
  const { registry } = setup(t, [teller])
  const a = []
  const b = []
  const offA = registry.connect('ca', (event, payload) => a.push([event, payload]))
  registry.connect('cb', (event, payload) => b.push([event, payload]))
  assert.deepEqual(await dispatchV2('teller.tell', { text: 'hi', projectId: 'p1' }, { plugins: registry, caller: 'ca' }), { ok: true, result: 'ca' })
  assert.deepEqual(a, [['teller.told', { text: 'hi' }]])
  assert.deepEqual(b, [])
  offA()
  await dispatchV2('teller.tell', { text: 'again' }, { plugins: registry, caller: 'ca' })
  host.emitTo('nobody', 'teller.told', {})
  assert.equal(a.length, 1, 'a closed or unknown caller hears nothing')
  assert.throws(() => host.emitTo('cb', 'other.told', {}), /teller\./)
  assert.throws(() => host.emitTo('cb', 'teller.', {}), /teller\./)
  // A call from no connection (an MCP tool, an automation): the caller is '', which reaches no one.
  assert.deepEqual(await dispatchV2('teller.tell', { text: 'x' }, { plugins: registry }), { ok: true, result: '' })
  assert.deepEqual(b, [])
})

test("emitTo goes through the connection's sink: past the high-water mark a chunk is dropped and said so; a done never is", (t) => {
  let host
  const { registry } = setup(t, [{ manifest: manifest('teller'), setup: (h) => ((host = h), { handlers: {} }) }])
  const sent = []
  let buffered = 64 * 1024 * 1024
  const sink = createEventSink((event, payload) => sent.push([event, payload]), () => buffered)
  registry.connect('c1', (event, payload) => sink.send(event, payload))
  host.emitTo('c1', 'teller.log', { data: 'lost' })
  host.emitTo('c1', 'teller.log', { data: '', done: true })
  buffered = 0
  host.emitTo('c1', 'teller.log', { data: 'b' })
  assert.deepEqual(sent, [
    ['teller.log', { data: '[output dropped: the connection fell behind]\n' }],
    ['teller.log', { data: '', done: true }],
    ['teller.log', { data: 'b' }]
  ])
})

test('emitTo takes any payload: null, undefined, a number or a string goes through the sink as a chunk', (t) => {
  let host
  const { registry } = setup(t, [{ manifest: manifest('teller'), setup: (h) => ((host = h), { handlers: {} }) }])
  const sent = []
  let buffered = 0
  const sink = createEventSink((event, payload) => sent.push([event, payload]), () => buffered)
  registry.connect('c1', (event, payload) => sink.send(event, payload))
  for (const payload of [null, undefined, 3, 'text']) host.emitTo('c1', 'teller.log', payload)
  assert.deepEqual(sent, [['teller.log', null], ['teller.log', undefined], ['teller.log', 3], ['teller.log', 'text']])
  buffered = 64 * 1024 * 1024
  host.emitTo('c1', 'teller.log', null)
  buffered = 0
  host.emitTo('c1', 'teller.log', 'after')
  assert.deepEqual(sent.slice(4), [
    ['teller.log', { data: '[output dropped: the connection fell behind]\n' }],
    ['teller.log', 'after']
  ])
})

test('a plugin may not take a core event namespace no method has: state, topic, daemon, integrations', (t) => {
  const ids = ['state', 'topic', 'daemon', 'integrations']
  const { registry, warnings } = setup(t, ids.map((id) => ({ manifest: manifest(id), setup: () => ({ handlers: {} }) })))
  assert.deepEqual(registry.presence(), [])
  for (const id of ids) assert.match(warnings.join('\n'), new RegExp(`${id} not loaded: its id is a core namespace`))
})

test('platforms (plugins E1): on another platform a plugin is not set up, answers nothing, and the welcome lists it available: false', (t) => {
  let ran = false
  const elsewhere = { manifest: manifest('elsewhere', { platforms: ['plan9'], legacyCapability: ['oldcap'] }), setup: () => ((ran = true), { handlers: { hi: () => 'hi' } }) }
  const here = { manifest: manifest('here', { platforms: ['linux'], legacyCapability: ['aa', 'bb'] }), setup: () => ({ handlers: {} }) }
  const { registry } = setup(t, [elsewhere, here], { platform: 'linux' })
  assert.equal(ran, false)
  assert.deepEqual(registry.presence(), [
    { id: 'here', version: '1.0.0', defaultEnabled: true },
    { id: 'elsewhere', version: '1.0.0', defaultEnabled: true, available: false }
  ])
  assert.equal(registry.handler('elsewhere.hi'), undefined)
  assert.equal(registry.enabled('p1', 'elsewhere'), false)
  assert.deepEqual(registry.legacyCapabilities(), ['aa', 'bb'])
  assert.equal(registry.settingFields('elsewhere', 'repo'), undefined)
})

test('platforms (plugins E1): a second plugin with an unavailable one\'s id is refused', (t) => {
  const { registry, warnings } = setup(t, [
    { manifest: manifest('twice', { platforms: ['plan9'] }), setup: () => ({ handlers: {} }) },
    { manifest: manifest('twice'), setup: () => ({ handlers: {} }) }
  ], { platform: 'linux' })
  assert.deepEqual(registry.presence(), [{ id: 'twice', version: '1.0.0', defaultEnabled: true, available: false }])
  assert.match(warnings.join('\n'), /twice not loaded: another plugin has that id/)
})

test('the host reads the project (plugins E1): its worktrees and repositories, and its own repo and branch settings, as copies', (t) => {
  let host
  const look = { manifest: manifest('look', { repoSettings: { enabled: 'boolean' }, branchSettings: { env: 'text' } }), setup: (h) => ((host = h), { handlers: {} }) }
  const repo = {
    id: 'r1', name: 'app', path: '/r/app',
    pluginSettings: { look: { enabled: true }, other: { x: 1 } },
    branchData: { feat: { note: 'n', pluginSettings: { look: { env: 'A=1\n' } } } },
    worktrees: [
      { id: 'w1', path: '/r/app', branch: 'main', isMain: true, sessions: [] },
      { id: 'w2', path: '/r/app-feat', branch: 'feat', isMain: false, missing: true, sessions: [] },
      { id: 'w3', path: '/r/app-detached', isMain: false, sessions: [] }
    ]
  }
  const empty = { id: 'r2', name: 'empty', path: '/r/empty', branchData: {}, worktrees: [] }
  const lib = { id: 'r3', name: 'lib', path: '/r/lib', branchData: {}, worktrees: [{ id: 'w4', path: '/r/lib', branch: 'main', isMain: true, sessions: [] }] }
  const { registry } = setup(t, [look], { projects: { p1: { id: 'p1', settings: {}, globalSessions: [], repositories: [repo, empty, lib] } } })
  assert.deepEqual(host.worktrees('p1'), [
    { id: 'w1', repoId: 'r1', repoPath: '/r/app', path: '/r/app', branch: 'main', present: true },
    { id: 'w2', repoId: 'r1', repoPath: '/r/app', path: '/r/app-feat', branch: 'feat', present: false },
    { id: 'w3', repoId: 'r1', repoPath: '/r/app', path: '/r/app-detached', branch: null, present: true },
    { id: 'w4', repoId: 'r3', repoPath: '/r/lib', path: '/r/lib', branch: 'main', present: true }
  ])
  assert.equal(host.worktree('p1', 'w2').path, '/r/app-feat')
  assert.deepEqual(host.worktree('p1', 'w4'), { id: 'w4', repoId: 'r3', repoPath: '/r/lib', path: '/r/lib', branch: 'main', present: true })
  assert.throws(() => host.worktree('p1', 'nope'), (e) => e.code === 'NOT_FOUND')
  assert.throws(() => host.worktrees('gone'), (e) => e.code === 'NOT_FOUND')
  assert.deepEqual(host.repos('p1'), [
    { id: 'r1', path: '/r/app', name: 'app' },
    { id: 'r2', path: '/r/empty', name: 'empty' },
    { id: 'r3', path: '/r/lib', name: 'lib' }
  ])
  assert.deepEqual(host.repoSettings('p1', 'r2'), {}, 'a repository with no pluginSettings')
  assert.deepEqual(host.repoSettings('p1', 'r1'), { enabled: true })
  assert.deepEqual(host.branchSettings('p1', 'r1', 'feat'), { env: 'A=1\n' })
  assert.deepEqual(host.branchSettings('p1', 'r1', 'other'), {})
  assert.deepEqual(host.branchSettings('p1', 'r1', 'constructor'), {}, 'a prototype name is no branch')
  assert.throws(() => host.repoSettings('p1', 'nope'), (e) => e.code === 'NOT_FOUND')
  assert.throws(() => host.repoSettings('gone', 'r1'), (e) => e.code === 'NOT_FOUND')
  assert.throws(() => host.branchSettings('gone', 'r1', 'feat'), (e) => e.code === 'NOT_FOUND')
  host.repoSettings('p1', 'r1').enabled = false
  assert.equal(repo.pluginSettings.look.enabled, true, 'a copy')
  assert.deepEqual(registry.settingFields('look', 'repo'), { enabled: 'boolean' })
  assert.deepEqual(registry.settingFields('look', 'branch'), { env: 'text' })
  assert.equal(registry.settingFields('nobody', 'repo'), undefined)
  assert.equal(registry.settingFields('constructor', 'repo'), undefined)
})

test('refused before setup (plugins E1): a built-in whose id is an Object.prototype name', (t) => {
  let ran = false
  const { registry, warnings } = setup(t, [{ manifest: manifest('constructor', { repoSettings: { a: 'string' } }), setup: () => ((ran = true), { handlers: {} }) }])
  assert.equal(ran, false)
  assert.deepEqual(registry.presence(), [])
  assert.match(warnings.join('\n'), /constructor not loaded: its id is not a usable plugin id/)
})

test('refused before setup (plugins E1): repo or branch settings of an unknown kind or with a bad name', (t) => {
  const { registry, warnings } = setup(t, [
    { manifest: manifest('badkind', { repoSettings: { cpu: 'integer' } }), setup: () => ({ handlers: {} }) },
    { manifest: manifest('badname', { branchSettings: { 'not ok': 'string' } }), setup: () => ({ handlers: {} }) }
  ])
  assert.deepEqual(registry.presence(), [])
  assert.match(warnings.join('\n'), /badkind not loaded: its repoSettings cpu has the kind "integer"/)
  assert.match(warnings.join('\n'), /badname not loaded: its branchSettings "not ok" is not a field name/)
})

test('repo.setPluginSettings and branch.setPluginSettings (plugins E1): checked against the manifest, kept in the project, read back by the host; {} clears', async (t) => {
  const { ProjectState } = await import('../server/src/projects/state.ts')
  const { TopicHub } = await import('../server/src/topicHub.ts')
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'app', path: '/r/app' }, name: undefined }])
  const repoId = projects.require(projectId).repositories[0].id
  let host
  const envy = { manifest: manifest('envy', { repoSettings: { enabled: 'boolean', cpu: 'number', label: 'string' }, branchSettings: { env: 'text' } }), setup: (h) => ((host = h), { handlers: {} }) }
  // Not for this server's OS: listed available: false, never set up, so no settingFields and no writes.
  const elsewhere = { manifest: manifest('elsewhere', { platforms: [process.platform === 'win32' ? 'darwin' : 'win32'], repoSettings: { on: 'boolean' } }), setup: () => ({ handlers: {} }) }
  const dir = mkdtempSync(join(tmpdir(), 'trek-plugin-settings-'))
  t.after(() => removeDir(dir))
  const registry = createPluginRegistry({ plugins: [envy, elsewhere], secretsFile: join(dir, 'secrets.json'), dataDir: join(dir, 'data'), hub, projects, isCoreMethod, coreToolNames: [], warn: () => {} })
  const call = (method, params) => dispatchV2(method, { projectId, repoId, ...params }, { projects, hub, plugins: registry })
  assert.deepEqual(await call('repo.setPluginSettings', { pluginId: 'envy', values: { enabled: true, cpu: 4 } }), { ok: true, result: null })
  assert.deepEqual(await call('branch.setPluginSettings', { branch: 'feat', pluginId: 'envy', values: { env: 'A=1\n' } }), { ok: true, result: null })
  const repo = () => projects.require(projectId).repositories[0]
  assert.deepEqual(repo().pluginSettings, { envy: { enabled: true, cpu: 4 } })
  assert.deepEqual(repo().branchData.feat, { pluginSettings: { envy: { env: 'A=1\n' } } })
  assert.deepEqual(host.repoSettings(projectId, repoId), { enabled: true, cpu: 4 })
  assert.deepEqual(host.branchSettings(projectId, repoId, 'feat'), { env: 'A=1\n' })
  for (const [method, params, pattern] of [
    ['repo.setPluginSettings', { pluginId: 'envy', values: { memory: 4 } }, /values\.memory is not one of its settings/],
    ['repo.setPluginSettings', { pluginId: 'envy', values: { cpu: 'four' } }, /values\.cpu must be a finite number/],
    ['repo.setPluginSettings', { pluginId: 'nobody', values: {} }, /no plugin "nobody"/],
    ['repo.setPluginSettings', { pluginId: 'elsewhere', values: { on: true } }, /no plugin "elsewhere"/],
    ['repo.setPluginSettings', { pluginId: 'toString', values: {} }, /no plugin "toString"/],
    ['branch.setPluginSettings', { branch: 'feat', pluginId: 'envy', values: { enabled: true } }, /values\.enabled is not one of its settings/],
    ['repo.setPluginSettings', { pluginId: 'envy', values: { label: 'a\nb' } }, /values\.label must be one line/],
    ['branch.setPluginSettings', { branch: 'feat', pluginId: 'envy', values: { env: 'x'.repeat(100_001) } }, /values\.env must be text of at most 100000 characters/],
    ['repo.setPluginSettings', { pluginId: 'envy', values: 'x' }, /values must be an object/],
    ['repo.setPluginSettings', { pluginId: 'envy', values: [true] }, /values must be an object/],
    ['repo.setPluginSettings', { pluginId: 'envy', values: null }, /values must be an object/]
  ]) {
    const res = await call(method, params)
    assert.equal(res.error?.code, 'BAD_REQUEST', JSON.stringify(params))
    assert.match(res.error.message, pattern)
  }
  assert.deepEqual(repo().pluginSettings, { envy: { enabled: true, cpu: 4 } }, 'a refused write changes nothing')
  const unknownRepo = await call('branch.setPluginSettings', { branch: 'feat', pluginId: 'envy', values: { env: 'A' }, repoId: 'nope' })
  assert.equal(unknownRepo.error?.code, 'NOT_FOUND', JSON.stringify(unknownRepo))
  await call('branch.setPluginSettings', { branch: 'feat', pluginId: 'envy', values: {} })
  await call('repo.setPluginSettings', { pluginId: 'envy', values: {} })
  assert.equal(repo().pluginSettings, undefined)
  assert.equal(repo().branchData.feat, undefined, 'an emptied branch entry goes')
})

test('a plugin settings write (plugins E1) that would leave the map unmovable (over 1 MB in all) is refused, and nothing changes', async (t) => {
  const { ProjectState } = await import('../server/src/projects/state.ts')
  const { TopicHub } = await import('../server/src/topicHub.ts')
  const { MAX_PLUGIN_TEXT } = await import('../src/shared/plugins/manifest.ts')
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'app', path: '/r/app' }, name: undefined }])
  const repoId = projects.require(projectId).repositories[0].id
  const fields = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, 'text']))
  const big = { manifest: manifest('big', { repoSettings: fields, branchSettings: fields }), setup: () => ({ handlers: {} }) }
  const dir = mkdtempSync(join(tmpdir(), 'trek-plugin-settings-'))
  t.after(() => removeDir(dir))
  const registry = createPluginRegistry({ plugins: [big], secretsFile: join(dir, 'secrets.json'), dataDir: join(dir, 'data'), hub, projects, isCoreMethod, coreToolNames: [], warn: () => {} })
  const call = (method, params) => dispatchV2(method, { projectId, repoId, ...params }, { projects, hub, plugins: registry })
  const repo = () => projects.require(projectId).repositories[0]
  const full = Object.fromEntries(Object.keys(fields).map((k) => [k, 'x'.repeat(MAX_PLUGIN_TEXT)]))
  assert.deepEqual(await call('repo.setPluginSettings', { pluginId: 'big', values: { f0: 'small' } }), { ok: true, result: null })
  assert.deepEqual(await call('branch.setPluginSettings', { branch: 'feat', pluginId: 'big', values: { f0: 'small' } }), { ok: true, result: null })
  for (const [method, params] of [['repo.setPluginSettings', {}], ['branch.setPluginSettings', { branch: 'feat' }]]) {
    const res = await call(method, { ...params, pluginId: 'big', values: full })
    assert.equal(res.error?.code, 'BAD_REQUEST', method)
    assert.match(res.error.message, /pluginSettings holds more than 1 MB of text in all/)
  }
  assert.deepEqual(repo().pluginSettings, { big: { f0: 'small' } }, 'the earlier values stay')
  assert.deepEqual(repo().branchData.feat, { pluginSettings: { big: { f0: 'small' } } })
})
