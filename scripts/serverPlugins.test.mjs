// scripts/serverPlugins.test.mjs — trek-server's plugin registry (plugin system phase 1): setup,
// refused ids and tools, `<id>.*` methods through dispatchV2 with their errors, per-project
// enablement of MCP tools, instructions, session prompts and events, the host's secrets and data
// files, and the welcome's plugins and legacy capabilities.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, statSync, readFileSync, existsSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { pluginPathChecks } from '../server/src/plugins/coreChecks.ts'
import { localSiblingDataDirs } from '../server/src/plugins/siblings.ts'
import { toWireError } from '../server/src/errors.ts'
import { dispatchV2, isCoreMethod } from '../server/src/v2.ts'
import { mcpContext } from '../server/src/plugins/mcp.ts'
import { welcomeCapabilities } from '../server/src/capabilities.ts'
import { MCP_INSTRUCTIONS, MCP_TOOLS } from '../server/src/mcp/tools.ts'
import { pluginError } from '../src/shared/plugins/server.ts'
import { applySettingsPatch, isSettingsKey, PLUGIN_OWNED_SETTINGS, validateSettings } from '../server/src/projects/settings.ts'
import { BUILTIN_SERVER_PLUGINS } from '../plugins/builtin.server.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'
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

function setup(t, plugins, { projects = { p1: project('p1'), p2: project('p2', { echo: { enabled: false } }) }, hub = fakeHub(), platform, paths } = {}) {
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
    ...(platform ? { platform } : {}),
    ...(paths ? { paths } : {})
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
  const on = mcpContext('p1', core, registry, MCP_TOOLS)
  assert.equal(on.tools.length, MCP_TOOLS.length + 1)
  assert.equal(on.tools.at(-1).name, 'echo_tool')
  assert.equal(on.instructions, `${MCP_INSTRUCTIONS} echo_tool echoes.`)
  assert.deepEqual(await on.call('echo_tool', { a: 1 }), { args: { a: 1 }, projectId: 'p1' })
  assert.equal(await on.call('list_worktrees', {}), 'core list_worktrees')
  const off = mcpContext('p2', core, registry, MCP_TOOLS)
  assert.equal(off.tools, MCP_TOOLS)
  assert.equal(off.instructions, MCP_INSTRUCTIONS)
  assert.equal(await off.call('echo_tool', {}), 'core echo_tool', 'not the plugin: the core caller refuses it as unknown')
  assert.equal(mcpContext('p1', core, undefined, MCP_TOOLS).tools, MCP_TOOLS)
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

test('host.spawn outlive (plugins E2): dispose neither signals the child nor waits for it; its output streams; kill() still ends it', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-spawn-outlive-')))
  t.after(() => removeDir(root))
  const repoPath = join(root, 'app')
  mkdirSync(repoPath)
  const repo = { id: 'r1', name: 'app', path: repoPath, branchData: {}, worktrees: [{ id: 'w1', path: repoPath, isMain: true, sessions: [] }] }
  let host
  const runner = { manifest: manifest('runner'), setup: (h) => ((host = h), { handlers: {} }) }
  const { registry } = setup(t, [runner], { projects: { p1: { ...project('p1'), repositories: [repo] } } })
  let text = ''
  // Ignores SIGTERM: a signalled child would still be there, so the pid check alone can't tell; it
  // writes "got SIGTERM" if the dispose signals it.
  const script = 'process.on("SIGTERM", () => process.stdout.write("got SIGTERM\\n")); process.stdout.write("up\\n"); setInterval(() => process.stdout.write("tick\\n"), 100)'
  const child = await host.spawn(process.execPath, ['-e', script], { cwd: repoPath, outlive: true, onOutput: (_s, chunk) => { text += chunk } })
  let ended = false
  void child.done.then(() => { ended = true })
  t.after(() => {
    if (ended) return
    try {
      process.kill(child.pid, 0)
      process.kill(child.pid, 'SIGKILL')
    } catch {}
  })
  for (const until = Date.now() + 5000; !text.includes('up') && Date.now() < until; ) await new Promise((r) => setTimeout(r, 20))
  assert.ok(text.includes('up'), 'its output streams')
  const started = Date.now()
  await registry.dispose()
  assert.ok(Date.now() - started < 1000, `dispose did not wait for it (${Date.now() - started} ms)`)
  await new Promise((r) => setTimeout(r, 400))
  assert.ok(!text.includes('got SIGTERM'), 'dispose sent it no signal')
  assert.doesNotThrow(() => process.kill(child.pid, 0), 'it outlives the dispose')
  const before = text.length
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(text.length > before, 'its output keeps streaming after the dispose')
  if (process.platform !== 'win32') {
    // Its own process group (a Ctrl-C at the server's terminal goes to the server's group only).
    const { execFileSync } = await import('node:child_process')
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' }).trim())
    assert.equal(pgid, child.pid, 'it leads its own process group')
  }
  child.kill()
  const end = await child.done
  assert.ok(end.code !== 0 || end.signal !== null, "the plugin's kill() still ends it")
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

test("repo.setPluginSettings and branch.setPluginSettings (plugins E3): `expected` is a compare-and-set on the plugin's own values", async (t) => {
  const { ProjectState } = await import('../server/src/projects/state.ts')
  const { TopicHub } = await import('../server/src/topicHub.ts')
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'app', path: '/r/app' }, name: undefined }])
  const repoId = projects.require(projectId).repositories[0].id
  const envy = { manifest: manifest('envy', { repoSettings: { enabled: 'boolean', cpu: 'number' }, branchSettings: { env: 'text' } }), setup: () => ({ handlers: {} }) }
  const other = { manifest: manifest('other', { repoSettings: { on: 'boolean' } }), setup: () => ({ handlers: {} }) }
  const dir = mkdtempSync(join(tmpdir(), 'trek-plugin-expected-'))
  t.after(() => removeDir(dir))
  const registry = createPluginRegistry({ plugins: [envy, other], secretsFile: join(dir, 'secrets.json'), dataDir: join(dir, 'data'), hub, projects, isCoreMethod, coreToolNames: [], warn: () => {} })
  const call = (method, params) => dispatchV2(method, { projectId, repoId, ...params }, { projects, hub, plugins: registry })
  const repo = () => projects.require(projectId).repositories[0]
  assert.equal((await call('repo.setPluginSettings', { pluginId: 'envy', values: { enabled: true }, expected: null })).ok, true, 'null: none stored yet')
  assert.equal((await call('repo.setPluginSettings', { pluginId: 'other', values: { on: true }, expected: null })).ok, true, "another plugin's values are not this one's")
  assert.equal((await call('repo.setPluginSettings', { pluginId: 'envy', values: { enabled: true, cpu: 2 }, expected: { enabled: true } })).ok, true)
  const stale = await call('repo.setPluginSettings', { pluginId: 'envy', values: { enabled: false }, expected: { enabled: true } })
  assert.deepEqual([stale.error?.code, stale.error?.message], ['CONFLICT', 'pluginSettings.envy changed since you read it'])
  assert.deepEqual(repo().pluginSettings, { envy: { enabled: true, cpu: 2 }, other: { on: true } }, 'nothing written')
  assert.equal((await call('repo.setPluginSettings', { pluginId: 'envy', values: { cpu: 3 } })).ok, true, 'no expected: no check, as before')
  assert.equal((await call('branch.setPluginSettings', { branch: 'feat', pluginId: 'envy', values: { env: 'A=1' }, expected: null })).ok, true)
  assert.equal((await call('branch.setPluginSettings', { branch: 'feat', pluginId: 'envy', values: { env: 'B=2' }, expected: null })).error?.code, 'CONFLICT')
  assert.equal((await call('branch.setPluginSettings', { branch: 'feat', pluginId: 'envy', values: {}, expected: { env: 'A=1' } })).ok, true)
  assert.equal(repo().branchData.feat, undefined, 'cleared, and the emptied entry goes')
  assert.equal((await call('repo.setPluginSettings', { pluginId: 'envy', values: {}, expected: 'x' })).error?.code, 'BAD_REQUEST')
  await registry.dispose()
})

test("`expected` on the env plugin (plugins E3): its settings and their old names guard each other, whichever method wrote them", async (t) => {
  const { ProjectState } = await import('../server/src/projects/state.ts')
  const { TopicHub } = await import('../server/src/topicHub.ts')
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'app', path: '/r/app' }, name: undefined }])
  const repoId = projects.require(projectId).repositories[0].id
  const env = { manifest: manifest('env', { repoSettings: { enabled: 'boolean', cpu: 'number', later: 'string' }, branchSettings: { env: 'text' } }), setup: () => ({ handlers: {} }) }
  const dir = mkdtempSync(join(tmpdir(), 'trek-plugin-expected-env-'))
  t.after(() => removeDir(dir))
  const registry = createPluginRegistry({ plugins: [env], secretsFile: join(dir, 'secrets.json'), dataDir: join(dir, 'data'), hub, projects, isCoreMethod, coreToolNames: [], warn: () => {} })
  const call = (method, params) => dispatchV2(method, { projectId, repoId, ...params }, { projects, hub, plugins: registry })
  const repo = () => projects.require(projectId).repositories[0]
  assert.equal((await call('repo.update', { environments: { enabled: true, cpu: 2 }, expected: { environments: null } })).ok, true)
  // The old name's write is the plugin's: its values as read are what the plugin's expected names.
  assert.equal((await call('repo.setPluginSettings', { pluginId: 'env', values: { enabled: true, cpu: 4 }, expected: { enabled: true, cpu: 2 } })).ok, true)
  // ... and the plugin's write changed the old name: a client that read it before is stale.
  const staleOld = await call('repo.update', { environments: { enabled: false }, expected: { environments: { enabled: true, cpu: 2 } } })
  assert.deepEqual([staleOld.error?.code, staleOld.error?.message], ['CONFLICT', 'environments changed since you read it'])
  assert.equal((await call('repo.update', { environments: { enabled: false }, expected: { environments: { enabled: true, cpu: 4 } } })).ok, true)
  const stalePlugin = await call('repo.setPluginSettings', { pluginId: 'env', values: { enabled: true }, expected: { enabled: true, cpu: 4 } })
  assert.deepEqual([stalePlugin.error?.code, stalePlugin.error?.message], ['CONFLICT', 'pluginSettings.env changed since you read it'])
  // A plugin-only value the old name can't hold: the old name is unchanged, and repo.update keeps it.
  assert.equal((await call('repo.setPluginSettings', { pluginId: 'env', values: { enabled: false, later: 'x' }, expected: { enabled: false } })).ok, true)
  assert.equal((await call('repo.update', { environments: { enabled: true }, expected: { environments: { enabled: false } } })).ok, true)
  assert.deepEqual([repo().pluginSettings, repo().environments], [{ env: { later: 'x', enabled: true } }, { enabled: true }])

  assert.equal((await call('branch.setEnv', { branch: 'feat', env: 'A=1', expected: null })).ok, true)
  assert.equal((await call('branch.setPluginSettings', { branch: 'feat', pluginId: 'env', values: { env: 'B=2' }, expected: { env: 'A=1' } })).ok, true)
  assert.equal((await call('branch.setEnv', { branch: 'feat', env: 'C=3', expected: 'A=1' })).error?.code, 'CONFLICT')
  assert.equal((await call('branch.setEnv', { branch: 'feat', env: 'C=3', expected: 'B=2' })).ok, true)
  assert.equal((await call('branch.setPluginSettings', { branch: 'feat', pluginId: 'env', values: {}, expected: { env: 'B=2' } })).error?.code, 'CONFLICT')
  assert.deepEqual(repo().branchData.feat, { pluginSettings: { env: { env: 'C=3' } }, env: 'C=3' })
  await registry.dispose()
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

test("lifecycles (plugins E1, E3): every set-up plugin's worktree lifecycle, on in the project or not; through pluginParticipant a plugin gets its context and the worktree, read only", async (t) => {
  const seen = []
  const lifecycle = {
    plan: async (ctx, worktree, op) => (seen.push(['plan', ctx, worktree, op]), [{ id: 'vm', label: 'Stop the VM', checked: true }]),
    teardown: async (ctx, worktree, op, ids) => void seen.push(['teardown', ctx.caller, worktree.id, op, ids]),
    beforeRepoRemove: async (_ctx, repo) => (seen.push(['repo', repo]), null)
  }
  const { registry } = setup(
    t,
    [
      { manifest: manifest('vms'), setup: () => ({ handlers: {}, worktreeLifecycle: lifecycle }) },
      { manifest: manifest('plain'), setup: () => ({ handlers: {} }) }
    ],
    { projects: { p1: project('p1'), p2: project('p2', { vms: { enabled: false } }) } }
  )
  assert.deepEqual(registry.lifecycles('p1').map((l) => l.id), ['vms'])
  // Off in p2 (plugins E3): still listed, so it still tears down what it made there and still vetoes;
  // a plugin with no lifecycle is never listed.
  assert.deepEqual(registry.lifecycles('p2').map((l) => l.id), ['vms'])
  assert.equal('inactiveLifecycles' in registry, false)
  const { pluginParticipant, planTeardown, runTeardown, repoRemoveVeto } = await import('../server/src/teardown/teardown.ts')
  const participant = pluginParticipant(registry.lifecycles('p1')[0], 'conn-1')
  const repo = { id: 'r1', name: 'app', path: '/r/app', branchData: {}, worktrees: [] }
  const where = { project: { id: 'p1' }, repo, worktree: { id: 'w2', path: '/r/app-feat', branch: 'feat', isMain: false, missing: true } }
  assert.deepEqual(await planTeardown([participant], where, 'move'), [{ id: 'vms:vm', label: 'Stop the VM', checked: true }])
  await runTeardown([participant], where, 'move', ['vms:vm'])
  assert.equal(await repoRemoveVeto([participant], where.project, repo), null)
  const worktree = { id: 'w2', repoId: 'r1', repoPath: '/r/app', path: '/r/app-feat', branch: 'feat', present: false }
  assert.deepEqual(seen, [
    ['plan', { projectId: 'p1', caller: 'conn-1' }, worktree, 'move'],
    ['plan', { projectId: 'p1', caller: 'conn-1' }, worktree, 'move'],
    ['teardown', 'conn-1', 'w2', 'move', ['vm']],
    ['repo', { id: 'r1', path: '/r/app', name: 'app' }]
  ])
})

test("host.run (plugins E2) takes a cwd under spawn's rule; a repository or worktree outside the allowed paths is PATH_DENIED for run and spawn", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-run-cwd-')))
  t.after(() => removeDir(root))
  const repoPath = join(root, 'app')
  const wtPath = join(root, 'app-feat')
  for (const dir of [repoPath, wtPath]) mkdirSync(dir)
  const repo = {
    id: 'r1', name: 'app', path: repoPath, branchData: {},
    worktrees: [{ id: 'w1', path: repoPath, isMain: true, sessions: [] }, { id: 'w2', path: wtPath, branch: 'feat', isMain: false, sessions: [] }]
  }
  let host
  const runner = { manifest: manifest('runner'), setup: (h) => ((host = h), { handlers: {} }) }
  const { registry } = setup(t, [runner], { projects: { p1: { ...project('p1'), repositories: [repo] } }, paths: {
    check: (path) => {
      if (path === wtPath) throw Object.assign(new Error(`Path not under a configured root: ${path}`), { code: 'PATH_DENIED' })
    }
  } })
  const cwdOf = (cwd) => host.run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd })
  assert.equal(await cwdOf(repoPath), repoPath)
  const dataDir = dirname(host.dataFile('x.json'))
  // The child's process.cwd() is a real path; setup's temp dir is not one on macOS (/var → /private/var).
  assert.equal(await cwdOf(dataDir), realpathSync(dataDir), "the plugin's data directory is not the allowlist's to refuse")
  assert.equal(await host.run(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok', 'no cwd: as before')
  // The guard's own refusal, as core's machine methods give it.
  await assert.rejects(cwdOf(wtPath), (e) => e.code === 'PATH_DENIED' && e.message === `Path not under a configured root: ${wtPath}`)
  await assert.rejects(host.spawn(process.execPath, ['-e', ''], { cwd: wtPath }), (e) => e.code === 'PATH_DENIED')
  await assert.rejects(cwdOf(root), /not a repository, a worktree/)
  await registry.dispose()
})

test('pluginError (plugins E2) carries details; PATH_DENIED and GIT_ERROR reach the client as they are', async (t) => {
  const thrower = {
    manifest: manifest('thrower'),
    setup: () => ({
      handlers: {
        missing: () => {
          throw pluginError('TOOL_ERROR', 'colima is not installed', { reason: 'missing' })
        },
        denied: () => {
          throw pluginError('PATH_DENIED', '/x is outside')
        },
        git: () => {
          throw pluginError('GIT_ERROR', 'git broke')
        },
        // Only core's orchestrator says what was torn down: a plugin's tornDown never reaches the wire.
        forged: () => {
          throw Object.assign(new Error('half done'), { code: 'CONFLICT', details: { reason: 'busy', tornDown: ['dev stack', 'Colima VM'] } })
        },
        forgedOnly: () => {
          throw Object.assign(new Error('half done'), { code: 'TOOL_ERROR', details: { tornDown: ['dev stack'] } })
        }
      }
    })
  }
  const { registry } = setup(t, [thrower])
  assert.deepEqual((await dispatchV2('thrower.forged', {}, { plugins: registry })).error, { code: 'CONFLICT', message: 'half done', details: { reason: 'busy' } })
  assert.deepEqual((await dispatchV2('thrower.forgedOnly', {}, { plugins: registry })).error, { code: 'TOOL_ERROR', message: 'half done' })
  const call = (method) => dispatchV2(method, {}, { plugins: registry })
  assert.deepEqual((await call('thrower.missing')).error, { code: 'TOOL_ERROR', message: 'colima is not installed', details: { reason: 'missing' } })
  assert.deepEqual((await call('thrower.denied')).error, { code: 'PATH_DENIED', message: '/x is outside' })
  assert.deepEqual((await call('thrower.git')).error, { code: 'GIT_ERROR', message: 'git broke' })
})

test('dispose (plugins E2) waits for a child that ignores SIGTERM until the SIGKILL ends it', { skip: posixOnly('POSIX process groups') }, async (t) => {
  let host
  const runner = { manifest: manifest('runner'), setup: (h) => ((host = h), { handlers: {} }) }
  const { registry } = setup(t, [runner])
  const dir = dirname(host.dataFile('x.json'))
  let ready
  const up = new Promise((resolve) => (ready = resolve))
  const stubborn = await host.spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("up"); setInterval(() => {}, 1000)'], { cwd: dir, onOutput: () => ready() })
  endAfter(t, [stubborn.pid])
  await up
  const began = Date.now()
  await registry.dispose()
  // Timed before awaiting done: the SIGKILL lands 3 s on whether or not dispose waited for it.
  const waited = Date.now() - began
  assert.equal((await stubborn.done).signal, 'SIGKILL')
  assert.ok(waited >= 2900, `it waited for the SIGKILL (${waited} ms)`)
  assert.equal(await registry.dispose(), undefined, 'a second dispose has nothing to wait for')
})

/** Alive by pid (signal 0). */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits up to `ms` for `pid` to be gone; true when it is. */
async function gone(pid, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (!alive(pid)) return true
  return !alive(pid)
}

/** SIGKILLs each recorded pid still alive after the test (only pids it started). */
function endAfter(t, pids) {
  t.after(() => {
    for (const pid of pids) {
      if (alive(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
  })
}

test("dispose (plugins E2) waits until a program's whole group is gone: a grandchild ignoring SIGTERM is SIGKILLed first", { skip: posixOnly('POSIX process groups') }, async (t) => {
  let host
  const runner = { manifest: manifest('runner'), setup: (h) => ((host = h), { handlers: {} }) }
  const { registry } = setup(t, [runner])
  const dir = dirname(host.dataFile('x.json'))
  const pids = []
  endAfter(t, pids)
  let text = ''
  // The child ends on SIGTERM; its grandchild (same group, sharing its stdout) ignores it.
  const script =
    'require("node:child_process").spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); process.stdout.write(process.pid + \\"\\\\n\\"); setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] }); setInterval(() => {}, 1000)'
  const program = await host.spawn(process.execPath, ['-e', script], { cwd: dir, onOutput: (_s, chunk) => (text += chunk) })
  pids.push(program.pid)
  for (const end = Date.now() + 5000; !text.includes('\n') && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20))
  const grandchild = Number(text.trim())
  assert.ok(grandchild > 0)
  pids.push(grandchild)
  await new Promise((r) => setTimeout(r, 500))
  const began = Date.now()
  await registry.dispose()
  const waited = Date.now() - began
  assert.ok(waited >= 2900, `dispose waited for the SIGKILL (${waited} ms)`)
  // Its SIGKILL is sent when dispose resolves; its new parent (init) reaps it a moment later.
  assert.ok(await gone(grandchild, 1000), 'the grandchild is gone after dispose')
  assert.equal('stopped' in program, false, "stopped is the host's own, not the plugin's")
})

test('dispose (plugins E2) waits for a host.run program that ignores SIGTERM until the SIGKILL ends it', { skip: posixOnly('POSIX signals') }, async (t) => {
  let host
  const runner = { manifest: manifest('runner'), setup: (h) => ((host = h), { handlers: {} }) }
  const { registry } = setup(t, [runner])
  const dir = dirname(host.dataFile('x.json'))
  const marker = join(dir, 'pid')
  const pids = []
  endAfter(t, pids)
  const script = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`
  const running = host.run(process.execPath, ['-e', script], { timeoutMs: 60_000 })
  running.catch(() => {})
  let pid = 0
  for (const end = Date.now() + 5000; !pid && Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    try {
      pid = Number(readFileSync(marker, 'utf8'))
    } catch {}
  }
  assert.ok(pid > 0)
  pids.push(pid)
  const began = Date.now()
  await registry.dispose()
  const waited = Date.now() - began
  await assert.rejects(running, (e) => e.code === 'ABORT_ERR')
  assert.ok(waited >= 2900, `dispose waited for the SIGKILL (${waited} ms)`)
  assert.equal(alive(pid), false, 'the program is gone once dispose resolves')
})

test("pluginPathChecks (plugins E2): check rethrows the guard's own refusal", () => {
  const refusal = Object.assign(new Error('UNC paths are not allowed: \\\\host\\share'), { code: 'PATH_DENIED' })
  const checked = []
  const ok = pluginPathChecks({ store: { guard: { check: (path) => (checked.push(path), path) } } })
  assert.equal(ok.check('/r/app'), undefined)
  assert.deepEqual(checked, ['/r/app'])
  const denied = pluginPathChecks({ store: { guard: { check: () => { throw refusal } } } })
  assert.throws(() => denied.check('/r/app'), (e) => e === refusal)
})

test("host.checkedRepo and host.checkedWorktree (plugins E2): core's checks, answered as the plugin's repo and worktree; their errors keep their codes", async (t) => {
  const repo = { id: 'r1', name: 'app', path: '/r/app', branchData: {}, worktrees: [{ id: 'w2', path: '/r/app-feat', branch: 'feat', isMain: false, sessions: [] }] }
  const asked = []
  const paths = {
    check: () => {},
    repo: (projectId, repoId) => {
      asked.push(['repo', projectId, repoId])
      if (repoId !== 'r1') throw Object.assign(new Error('/r/other is outside the allowed paths'), { code: 'PATH_DENIED' })
      return repo
    },
    worktree: async (projectId, worktreeId, refresh) => {
      asked.push(['worktree', projectId, worktreeId, refresh])
      if (worktreeId !== 'w2') throw Object.assign(new Error('could not re-read the worktrees'), { code: 'GIT_ERROR' })
      return { repo, worktree: repo.worktrees[0] }
    }
  }
  let host
  const runner = {
    manifest: manifest('runner'),
    setup: (h) => ((host = h), { handlers: { list: (p) => host.checkedRepo(p.projectId, p.repoId), up: (p) => host.checkedWorktree(p.projectId, p.worktreeId, { refresh: true }) } })
  }
  const { registry } = setup(t, [runner], { paths })
  assert.deepEqual(host.checkedRepo('p1', 'r1'), { id: 'r1', path: '/r/app', name: 'app' })
  assert.deepEqual(await host.checkedWorktree('p1', 'w2'), { id: 'w2', repoId: 'r1', repoPath: '/r/app', path: '/r/app-feat', branch: 'feat', present: true })
  assert.deepEqual(asked, [['repo', 'p1', 'r1'], ['worktree', 'p1', 'w2', false]])
  const call = (method, params) => dispatchV2(method, { projectId: 'p1', ...params }, { plugins: registry })
  assert.equal((await call('runner.list', { repoId: 'r9' })).error.code, 'PATH_DENIED')
  assert.equal((await call('runner.up', { worktreeId: 'w9' })).error.code, 'GIT_ERROR')
  assert.deepEqual(asked.at(-1), ['worktree', 'p1', 'w9', true])
})

test('host.busyWorktrees (plugins E2): the worktrees held for a teardown or an operation, with their CONFLICT message', async (t) => {
  const { holdWorktree } = await import('../server/src/teardown/teardown.ts')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-busy-')))
  t.after(() => removeDir(root))
  const wtPath = join(root, 'app-feat')
  mkdirSync(wtPath)
  const repo = { id: 'r1', name: 'app', path: join(root, 'app'), branchData: {}, worktrees: [{ id: 'w2', path: wtPath, branch: 'feat', isMain: false, sessions: [] }] }
  let host
  const runner = { manifest: manifest('runner'), setup: (h) => ((host = h), { handlers: {} }) }
  setup(t, [runner], { projects: { p1: { ...project('p1'), repositories: [repo] } } })
  assert.deepEqual(host.busyWorktrees(), [])
  await holdWorktree(wtPath, 'removing it', async () => {
    assert.deepEqual(host.busyWorktrees(), [
      { projectId: 'p1', worktree: { id: 'w2', repoId: 'r1', repoPath: join(root, 'app'), path: wtPath, branch: 'feat', present: true }, reason: 'this worktree is busy: removing it; try again once it is done' }
    ])
  })
  assert.deepEqual(host.busyWorktrees(), [])
})

test("localSiblingDataDirs (plugins E2): local and local-* beside a Local server's data dir, never itself or another dir", (t) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'trek-datadirs-')))
  t.after(() => removeDir(parent))
  for (const name of ['local', 'local-dev', 'local-wt2', 'other', 'local-', 'local-Bad', 'localx']) mkdirSync(join(parent, name))
  writeFileSync(join(parent, 'local-file'), '')
  assert.deepEqual(localSiblingDataDirs(join(parent, 'local')).sort(), [join(parent, 'local-dev'), join(parent, 'local-wt2')].sort())
  assert.deepEqual(localSiblingDataDirs(join(parent, 'local-dev')).sort(), [join(parent, 'local'), join(parent, 'local-wt2')].sort())
  assert.deepEqual(localSiblingDataDirs(join(parent, 'gone', 'local')), [])
})

test("host.legacySiblingDataFiles and host.legacyImportFile (plugins E2): each sibling's plugin file where it has one, else its old one; the app's file only with --import-env-from", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-siblings-')))
  t.after(() => removeDir(root))
  const own = join(root, 'local')
  for (const name of ['local', 'local-dev', 'local-old']) mkdirSync(join(root, name))
  mkdirSync(join(root, 'local-dev', 'plugins', 'runner'), { recursive: true })
  writeFileSync(join(root, 'local-dev', 'plugins', 'runner', 'reg.json'), '{}')
  writeFileSync(join(root, 'local-dev', 'reg.json'), '{"stale":{}}')
  let host
  const runner = { manifest: manifest('runner'), setup: (h) => ((host = h), { handlers: {} }) }
  const make = (more) =>
    createPluginRegistry({ plugins: [runner], secretsFile: join(root, 'secrets.json'), dataDir: own, hub: fakeHub(), projects: fakeProjects({}), isCoreMethod, coreToolNames: [], warn: () => {}, ...more })
  const local = make({ siblingDataDirs: () => localSiblingDataDirs(own), importFrom: join(root, 'Trek Dev') })
  t.after(() => local.dispose())
  assert.deepEqual(host.legacySiblingDataFiles('reg.json').sort(), [join(root, 'local-dev', 'plugins', 'runner', 'reg.json'), join(root, 'local-old', 'reg.json')].sort())
  assert.equal(host.legacyImportFile('reg.json'), join(root, 'Trek Dev', 'reg.json'))
  assert.throws(() => host.legacySiblingDataFiles('../x'), /not a data file name/)
  assert.throws(() => host.legacyImportFile('a/b'), /not a data file name/)
  const plain = make({})
  t.after(() => plain.dispose())
  assert.deepEqual(host.legacySiblingDataFiles('reg.json'), [])
  assert.equal(host.legacyImportFile('reg.json'), undefined)
})

test("host.legacySiblingDataFiles: a sibling's plugin file that is a dangling symlink is still its file (lstat), never its stale old one", { skip: posixOnly('symlinks') }, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-siblings-link-')))
  t.after(() => removeDir(root))
  const own = join(root, 'local')
  for (const name of ['local', 'local-dev']) mkdirSync(join(root, name))
  mkdirSync(join(root, 'local-dev', 'plugins', 'runner'), { recursive: true })
  symlinkSync(join(root, 'local-dev', 'nowhere.json'), join(root, 'local-dev', 'plugins', 'runner', 'reg.json'))
  writeFileSync(join(root, 'local-dev', 'reg.json'), '{"stale":{}}')
  let host
  const runner = { manifest: manifest('runner'), setup: (h) => ((host = h), { handlers: {} }) }
  const registry = createPluginRegistry({ plugins: [runner], secretsFile: join(root, 'secrets.json'), dataDir: own, hub: fakeHub(), projects: fakeProjects({}), isCoreMethod, coreToolNames: [], warn: () => {}, siblingDataDirs: () => localSiblingDataDirs(own) })
  t.after(() => registry.dispose())
  assert.deepEqual(host.legacySiblingDataFiles('reg.json'), [join(root, 'local-dev', 'plugins', 'runner', 'reg.json')])
})

test("pluginPathChecks' repo and worktree (plugins E2): core's own checks and codes", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-core-checks-')))
  t.after(() => removeDir(root))
  const dirs = ['app', 'app-feat', 'app-detached', 'other'].map((name) => join(root, name))
  for (const dir of dirs) mkdirSync(dir)
  const [app, feat, detached, other] = dirs
  const repo = {
    id: 'r1', name: 'app', path: app, branchData: {},
    worktrees: [
      { id: 'w1', path: app, branch: 'main', isMain: true, sessions: [] },
      { id: 'w2', path: feat, branch: 'feat', isMain: false, missing: true, sessions: [] },
      { id: 'w3', path: detached, isMain: false, sessions: [] },
      { id: 'w4', path: feat, branch: 'feat', isMain: false, sessions: [] }
    ]
  }
  const unregistered = { id: 'r2', name: 'other', path: other, branchData: {}, worktrees: [{ id: 'w5', path: other, branch: 'main', isMain: true, sessions: [] }] }
  let refreshes = true
  const checks = pluginPathChecks({
    projects: fakeProjects({ p1: { ...project('p1'), repositories: [repo, unregistered] } }),
    store: { config: { repos: [{ id: 'a', name: 'app', path: app }] }, guard: { check: () => {} } },
    poller: { refresh: async () => refreshes, warning: () => ({ message: 'git broke' }) }
  })
  const code = async (fn, expected) => {
    await assert.rejects(Promise.resolve().then(fn), (e) => {
      assert.equal(e.code, expected, e.message)
      return true
    })
  }
  assert.equal(checks.repo('p1', 'r1'), repo)
  await code(() => checks.repo('p1', 'r9'), 'NOT_FOUND')
  await code(() => checks.repo('p1', 'r2'), 'PATH_DENIED')
  assert.deepEqual(await checks.worktree('p1', 'w4', false), { repo, worktree: repo.worktrees[3] })
  await code(() => checks.worktree('p1', 'w9', false), 'NOT_FOUND')
  await code(() => checks.worktree('p1', 'w2', false), 'BAD_REQUEST')
  await code(() => checks.worktree('p1', 'w3', true), 'BAD_REQUEST')
  refreshes = false
  await code(() => checks.worktree('p1', 'w4', true), 'GIT_ERROR')
})

/** A well-formed agent (plugins A1); `more` overrides any field. */
const agent = (id, more = {}) => ({
  id,
  label: id,
  glyph: 'XX',
  defaultCommand: id,
  capabilities: { presetSessionId: true, resume: true, mcp: false, appendSystemPrompt: false, effort: false, addDirs: false, sessionMigration: false },
  models: [],
  efforts: [],
  approvalModes: [],
  statusMarkers: [],
  command: () => id,
  buildLaunch: () => ({ command: id, head: id, args: [] }),
  ...more
})
const agentPlugin = (id, agents, more = {}) => ({ manifest: manifest(id, more), setup: () => ({ handlers: {}, agentProviders: agents }) })

test("agentProviders (plugins A1): each set-up plugin's agents, with its plugin and its project settings' keys, in registration order", (t) => {
  const { registry, warnings } = setup(t, [
    agentPlugin('one', [agent('alpha'), agent('beta')], { projectSettings: { oneCommand: 'string' } }),
    agentPlugin('two', [agent('gamma')]),
    echoPlugin().plugin
  ])
  assert.deepEqual(
    registry.agentProviders().map((a) => [a.pluginId, a.agent.id, a.projectKeys]),
    [['one', 'alpha', ['oneCommand']], ['one', 'beta', ['oneCommand']], ['two', 'gamma', []]]
  )
  assert.deepEqual(warnings, [])
})

test("agentProviders (plugins A1): a plugin with a malformed agent, a taken id or another agent's MCP file is not loaded", (t) => {
  const file = (suffix) => ({ mcpFile: { suffix, content: () => '{}' } })
  const { registry, warnings } = setup(t, [
    agentPlugin('one', [agent('alpha', file('.json'))]),
    agentPlugin('dupe', [agent('alpha')]),
    agentPlugin('twice', [agent('delta'), agent('delta')]),
    agentPlugin('badid', [agent('Bad Id')]),
    agentPlugin('nocaps', [agent('epsilon', { capabilities: { resume: true } })]),
    agentPlugin('nolaunch', [agent('theta', { buildLaunch: undefined })]),
    agentPlugin('samefile', [agent('zeta', file('.json'))]),
    agentPlugin('badfile', [agent('eta', file('../x.json'))]),
    agentPlugin('notalist', 'alpha'),
    agentPlugin('badprompt', [agent('iota', { globalPrompt: 'be global' })]),
    agentPlugin('baddiscover', [agent('kappa', { discoverSessionId: true })]),
    agentPlugin('nomigrate', [agent('lambda', { history: { file: () => '/h' } })]),
    agentPlugin('badhistoryfile', [agent('mu', { history: { migrate: async () => ({ moved: true }), file: '/h' } })]),
    agentPlugin('badhistory', [agent('nu', { history: 'yes' })]),
    agentPlugin('badmodel', [agent('xi', { models: ['opus'] })]),
    agentPlugin('badmodelefforts', [agent('omicron', { models: [{ id: 'm', label: 'M', efforts: [1] }] })]),
    agentPlugin('badefforts', [agent('pi', { efforts: [null] })]),
    agentPlugin('badmarkers', [agent('rho', { statusMarkers: ['esc', 3] })]),
    agentPlugin('badmodes', [agent('sigma', { approvalModes: ['auto'] })]),
    agentPlugin('okhooks', [
      agent('tau', { globalPrompt: () => 'g', discoverSessionId: async () => undefined, history: { migrate: async () => ({ moved: false }) }, models: [{ id: 'm', label: 'M', efforts: ['low'] }], statusMarkers: ['esc'] })
    ])
  ])
  assert.deepEqual(registry.agentProviders().map((a) => a.agent.id), ['alpha', 'tau'])
  assert.deepEqual(registry.presence().map((p) => p.id), ['one', 'okhooks'])
  const expected = [
    ['dupe', /its agent "alpha" has the id of another agent/],
    ['twice', /its agent "delta" has the id of another agent/],
    ['badid', /has no usable id/],
    ['nocaps', /must say each capability/],
    ['nolaunch', /has no command or buildLaunch/],
    ['samefile', /its agent "zeta"'s MCP file "\.json" is the agent "alpha"'s/],
    ['badfile', /suffix is not like \.json/],
    ['notalist', /agentProviders must be a list/],
    ['badprompt', /its agent "iota" has a globalPrompt that is not a function/],
    ['baddiscover', /its agent "kappa" has a discoverSessionId that is not a function/],
    ['nomigrate', /its agent "lambda" has a history without a migrate function/],
    ['badhistoryfile', /its agent "mu" has a history whose file is not a function/],
    ['badhistory', /its agent "nu" has a history without a migrate function/],
    ['badmodel', /its agent "xi" has a model without a string id and label/],
    ['badmodelefforts', /its agent "omicron" has a model whose efforts are not strings/],
    ['badefforts', /its agent "pi" has efforts that are not all strings/],
    ['badmarkers', /its agent "rho" has status markers that are not all strings/],
    ['badmodes', /its agent "sigma" has an approval mode without a string value and label/]
  ]
  assert.equal(warnings.some((w) => w.includes('] okhooks not loaded')), false, 'well-formed hooks are taken')
  for (const [id, why] of expected) {
    assert.ok(warnings.some((w) => w.includes(`] ${id} not loaded: `) && why.test(w)), `${id}: ${warnings.join(' | ')}`)
  }
})

test('agentProviders (plugins A1): an installable plugin (a theme manifest) offering agents is not loaded', (t) => {
  const { registry, warnings } = setup(t, [agentPlugin('skin', [agent('alpha')], { type: 'theme', contract: 1 })])
  assert.deepEqual(registry.agentProviders(), [])
  assert.match(warnings.join('\n'), /skin not loaded: a theme plugin \(type\/contract\) cannot offer agents/)
})

test("settingRules.knownAgent (plugins A1): the set-up plugins' agents", (t) => {
  const { registry } = setup(t, [agentPlugin('one', [agent('alpha')])])
  assert.equal(registry.settingRules.knownAgent('alpha'), true)
  assert.equal(registry.settingRules.knownAgent('beta'), false)
})
