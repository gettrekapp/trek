// scripts/pluginClient.test.mjs — a project window's plugins (plugin system phase 1): each
// plugin's status from the server's welcome and the project's setting, and its host: `<id>.*`
// requests and events (another project's dropped), plugins.changed (integrations.changed from an
// older server), per-app prefs and whether it still serves the window.
import test from 'node:test'
import assert from 'node:assert/strict'
import { changedFor, forProject, pluginActive, pluginRequired, pluginStatus, withPluginEnabled } from '../src/renderer/src/plugins/presence.ts'
import { COLIMA_MANIFEST } from '../plugins/colima/manifest.ts'
import { GITHUB_MANIFEST } from '../plugins/github/manifest.ts'
import { createClientHost } from '../src/renderer/src/plugins/host.ts'
import { cachedProjectSettings } from '../src/renderer/src/plugins/projectView.ts'
import { parseAppSettings, DEFAULT_APP_SETTINGS } from '../src/shared/appSettings.ts'

const voice = { id: 'voice', version: '1.0.0', name: 'Voice', description: '', defaultEnabled: true, legacyCapability: 'voice' }
const quiet = { id: 'quiet', version: '1.0.0', name: 'Quiet', description: '', defaultEnabled: false }

test('pluginStatus: unknown before the welcome; on/off by the setting and default; missing; legacy on an older server', () => {
  const welcome = { plugins: [{ id: 'voice', version: '1.0.0', defaultEnabled: true }, { id: 'quiet', version: '1.0.0', defaultEnabled: false }], capabilities: [] }
  assert.equal(pluginStatus(voice, undefined, undefined), 'unknown')
  assert.equal(pluginStatus(voice, welcome, undefined), 'on')
  assert.equal(pluginStatus(voice, welcome, { voice: { enabled: false } }), 'off')
  assert.equal(pluginStatus(quiet, welcome, undefined), 'off')
  assert.equal(pluginStatus(quiet, welcome, { quiet: { enabled: true } }), 'on')
  assert.equal(pluginStatus(voice, { plugins: [], capabilities: ['voice'] }, undefined), 'missing', 'a server with plugins but not this one')
  // The server's default decides, not this app's manifest (a server with another default for it).
  assert.equal(pluginStatus(voice, { plugins: [{ id: 'voice', version: '2.0.0', defaultEnabled: false }], capabilities: [] }, undefined), 'off')
  assert.equal(pluginStatus(quiet, { plugins: [{ id: 'quiet', version: '2.0.0', defaultEnabled: true }], capabilities: [] }, undefined), 'on')
  // A 0.2.x server: no plugins in its welcome, its legacy capability or nothing; the setting is not read there.
  assert.equal(pluginStatus(voice, { capabilities: ['voice'] }, { voice: { enabled: false } }), 'legacy')
  assert.equal(pluginStatus(voice, { capabilities: [] }, undefined), 'missing')
  assert.equal(pluginStatus(quiet, { capabilities: ['quiet'] }, undefined), 'missing', 'no legacy capability of its own')
  assert.deepEqual(['on', 'off', 'legacy', 'missing', 'unknown'].map(pluginActive), [true, false, true, false, false])
})

test('pluginStatus (plugins E1): one the server lists as not available on its platform is missing; a legacy capability in a list counts', () => {
  const env = { id: 'env', version: '1.0.0', name: 'Colima', description: '', defaultEnabled: true, legacyCapability: ['env'] }
  assert.equal(pluginStatus(env, { plugins: [{ id: 'env', version: '1.0.0', defaultEnabled: true, available: false }], capabilities: [] }, undefined), 'missing')
  assert.equal(pluginStatus(env, { capabilities: ['env'] }, undefined), 'legacy')
  assert.equal(changedFor(env, 'integrations.changed', { env: true }, false), true)
})

test('pluginStatus (plugins E1): a built-in a released server lacks needs its legacy capability there; one with none is unchanged', () => {
  const env = { id: 'env', version: '1.0.0', name: 'Colima', description: '', defaultEnabled: true, legacyBuiltIn: true, legacyCapability: ['env'] }
  const github = { id: 'github', version: '1.0.0', name: 'GitHub', description: '', defaultEnabled: true, legacyBuiltIn: true }
  assert.equal(pluginStatus(env, { plugins: [], capabilities: [] }, undefined), 'missing')
  assert.equal(pluginStatus(env, { plugins: [], capabilities: ['env'] }, undefined), 'legacy')
  assert.equal(pluginStatus(github, { plugins: [], capabilities: [] }, undefined), 'legacy')
})

test('pluginStatus (plugins E3): a built-in with a legacy capability is legacy wherever the server says it without listing the plugin, P3 or not', () => {
  const env = { id: 'env', version: '1.0.0', name: 'Colima', description: '', defaultEnabled: true, legacyBuiltIn: true, legacyCapability: ['env'] }
  const github = { id: 'github', version: '1.0.0', name: 'GitHub', description: '', defaultEnabled: true, legacyBuiltIn: true }
  // An E1-era server (after P3, before E2): it lists plugins and says prResolve, and serves env.* in core.
  const e1 = { plugins: [{ id: 'github', version: '1.0.0', defaultEnabled: true }], capabilities: ['prResolve', 'env', 'worktreeTeardown'] }
  assert.equal(pluginStatus(env, e1, undefined), 'legacy')
  assert.equal(pluginStatus(env, e1, { env: { enabled: false } }), 'legacy', 'the project setting is not read there')
  // An E2+ server whose env plugin failed to set up: neither the plugin nor its capability.
  assert.equal(pluginStatus(env, { plugins: e1.plugins, capabilities: ['prResolve', 'worktreeTeardown'] }, undefined), 'missing')
  // A server before P3 that lists plugins: the same rule (its env capability decides).
  assert.equal(pluginStatus(env, { plugins: [], capabilities: ['env'] }, undefined), 'legacy')
  assert.equal(pluginStatus(env, { plugins: [], capabilities: [] }, undefined), 'missing')
  // An installed plugin's entry with the built-in's id is not the built-in: the capability still decides.
  assert.equal(pluginStatus(env, { plugins: [{ id: 'env', version: '9.0.0', defaultEnabled: true, sha256: 'ab' }], capabilities: ['prResolve', 'env'] }, undefined), 'legacy')
  // Listed (E2+): the project's setting decides; listed as unavailable: missing, whatever it says.
  assert.equal(pluginStatus(env, { plugins: [{ id: 'env', version: '1.0.0', defaultEnabled: true }], capabilities: ['prResolve', 'env'] }, { env: { enabled: false } }), 'off')
  assert.equal(pluginStatus(env, { plugins: [{ id: 'env', version: '1.0.0', defaultEnabled: true, available: false }], capabilities: ['prResolve', 'env'] }, undefined), 'missing')
  // GitHub (no legacy capability) keeps P3's rule, whatever else the server says.
  assert.equal(pluginStatus(github, { plugins: [], capabilities: ['prResolve', 'env'] }, undefined), 'missing')
  assert.equal(pluginStatus(github, { plugins: [], capabilities: ['env'] }, undefined), 'legacy')
  // A P3+ server where GitHub failed to set up (another PR provider still says prResolve): missing.
  assert.equal(pluginStatus(github, { plugins: [{ id: 'env', version: '1.0.0', defaultEnabled: true }], capabilities: ['prResolve', 'env'] }, undefined), 'missing')
  // A server older than plugins: GitHub was built in there.
  assert.equal(pluginStatus(github, { capabilities: [] }, undefined), 'legacy')
  // The real manifests on the E1-era welcome: env is legacy, GitHub listed per P3 (its setting decides).
  assert.equal(pluginStatus(COLIMA_MANIFEST, e1, undefined), 'legacy')
  assert.equal(pluginStatus(GITHUB_MANIFEST, e1, undefined), 'on')
  assert.equal(pluginStatus(GITHUB_MANIFEST, e1, { github: { enabled: false } }), 'off')
})

test('withPluginEnabled keeps the other plugins', () => {
  assert.deepEqual(withPluginEnabled(undefined, 'voice', false), { voice: { enabled: false } })
  assert.deepEqual(withPluginEnabled({ other: { enabled: true }, voice: { enabled: false } }, 'voice', true), { other: { enabled: true }, voice: { enabled: true } })
})

test('changedFor: plugins.changed by id; integrations.changed only from a server older than plugins', () => {
  assert.equal(changedFor(voice, 'plugins.changed', { id: 'voice' }, true), true)
  assert.equal(changedFor(voice, 'plugins.changed', { id: 'other' }, true), false)
  assert.equal(changedFor(voice, 'integrations.changed', { voice: true }, true), false, 'a new server sends both: plugins.changed is heard')
  assert.equal(changedFor(voice, 'integrations.changed', { voice: true }, false), true)
  assert.equal(changedFor(voice, 'integrations.changed', { linear: true }, false), false)
  assert.equal(changedFor(quiet, 'integrations.changed', { quiet: true }, false), false)
  assert.equal(changedFor(voice, 'plugins.changed', null, true), false)
})

test("forProject: a payload naming another project is not this window's; one naming none is", () => {
  assert.equal(forProject({ projectId: 'p1' }, 'p1'), true)
  assert.equal(forProject({ projectId: 'p2' }, 'p1'), false)
  assert.equal(forProject({ x: 1 }, 'p1'), true)
  assert.equal(forProject(null, 'p1'), true)
})

/** A window backend's plugin channel: records requests, lets the test fire events. */
function fakeBackend(welcome = { plugins: [{ id: 'voice', version: '1.0.0', defaultEnabled: true }], capabilities: ['voice'] }) {
  const requests = []
  const listeners = []
  const backend = {
    plugins: {
      projectId: 'p1',
      welcome: () => welcome,
      request: async (method, params) => {
        requests.push([method, params])
        return { ok: method }
      },
      onEvent: (event, listener) => {
        const entry = { event, listener }
        listeners.push(entry)
        return () => listeners.splice(listeners.indexOf(entry), 1)
      },
      onConnected: () => () => {}
    }
  }
  const fire = (event, payload) => listeners.filter((l) => l.event === event).forEach((l) => l.listener(payload))
  return { backend, requests, listeners, fire }
}

/** The app settings API as main serves it: patches parsed over the current settings, changes heard by every listener. */
function fakeAppSettings(initial = DEFAULT_APP_SETTINGS) {
  let current = parseAppSettings(initial)
  const listeners = new Set()
  return {
    get: async () => current,
    update: async (patch) => {
      current = parseAppSettings(patch, current)
      for (const l of listeners) l(current)
      return current
    },
    onChanged: (l) => (listeners.add(l), () => listeners.delete(l))
  }
}

test("the host's requests and events are the plugin's <id>.*; another project's events are dropped", async () => {
  const fake = fakeBackend()
  const host = createClientHost(voice, fake.backend, { appSettings: fakeAppSettings(), terminalLabel: (id) => `label ${id}`, currentBackend: () => fake.backend })
  assert.equal(host.id, 'voice')
  assert.equal(host.projectId, 'p1')
  assert.deepEqual(await host.request('setKey', { apiKey: 'k' }), { ok: 'voice.setKey' })
  await host.request('settings')
  assert.deepEqual(fake.requests, [['voice.setKey', { apiKey: 'k' }], ['voice.settings', {}]])
  const heard = []
  const off = host.onEvent('summary', (data) => heard.push(data.text))
  fake.fire('voice.summary', { projectId: 'p1', text: 'mine' })
  fake.fire('voice.summary', { projectId: 'p2', text: 'theirs' })
  fake.fire('other.summary', { projectId: 'p1', text: 'not voice' })
  off()
  fake.fire('voice.summary', { projectId: 'p1', text: 'after' })
  assert.deepEqual(heard, ['mine'])
  assert.equal(host.terminalLabel('t1'), 'label t1')
})

test("the host's onChanged: plugins.changed for it; integrations.changed only from a server older than plugins", () => {
  // A server with plugins sends both for one change: heard once.
  const fake = fakeBackend()
  const host = createClientHost(voice, fake.backend, { appSettings: fakeAppSettings(), terminalLabel: String, currentBackend: () => fake.backend })
  let changes = 0
  const off = host.onChanged(() => changes++)
  fake.fire('plugins.changed', { id: 'voice' })
  fake.fire('integrations.changed', { voice: true })
  fake.fire('plugins.changed', { id: 'other' })
  assert.equal(changes, 1)
  off()
  assert.equal(fake.listeners.length, 0)
  // A 0.2.x server sends integrations.changed only.
  const older = fakeBackend({ capabilities: ['voice'] })
  const olderHost = createClientHost(voice, older.backend, { appSettings: fakeAppSettings(), terminalLabel: String, currentBackend: () => older.backend })
  let olderChanges = 0
  olderHost.onChanged(() => olderChanges++)
  older.fire('integrations.changed', { voice: true })
  older.fire('integrations.changed', { linear: true })
  assert.equal(olderChanges, 1)
})

test("the host's prefs: this plugin's part of the app settings, loaded, set (null removes) and followed", async () => {
  const appSettings = fakeAppSettings({ plugins: { voice: { active: false }, other: { x: 1 } } })
  const fake = fakeBackend()
  const host = createClientHost(voice, fake.backend, { appSettings, terminalLabel: String, currentBackend: () => fake.backend })
  assert.deepEqual(await host.prefs.load(), { active: false })
  const heard = []
  const off = host.prefs.onChange((prefs) => heard.push(prefs))
  assert.deepEqual(await host.prefs.set('active', true), { active: true })
  assert.deepEqual(await host.prefs.set('active', null), {})
  off()
  assert.deepEqual(heard, [{ active: true }, {}])
  assert.deepEqual((await appSettings.get()).plugins, { other: { x: 1 } })
})

test("the host's prefs.onChange: called only when this plugin's prefs change, not on other app settings", async () => {
  const appSettings = fakeAppSettings({ plugins: { voice: { active: true, b: 1 } } })
  const fake = fakeBackend()
  const host = createClientHost(voice, fake.backend, { appSettings, terminalLabel: String, currentBackend: () => fake.backend })
  const heard = []
  const off = host.prefs.onChange((prefs) => heard.push(prefs))
  await host.prefs.set('active', false)
  await appSettings.update({ showNotifications: false })
  await appSettings.update({ plugins: { other: { x: 1 } } })
  await host.prefs.set('active', false)
  assert.deepEqual(heard, [{ active: false, b: 1 }], 'an unrelated change, or the same value again, is not heard')
  off()
  // The same prefs in another key order are the same prefs.
  const listeners = new Set()
  const emit = (plugins) => listeners.forEach((l) => l({ ...DEFAULT_APP_SETTINGS, plugins }))
  const stub = { get: async () => DEFAULT_APP_SETTINGS, update: async () => DEFAULT_APP_SETTINGS, onChanged: (l) => (listeners.add(l), () => listeners.delete(l)) }
  const other = createClientHost(voice, fake.backend, { appSettings: stub, terminalLabel: String, currentBackend: () => fake.backend })
  const seen = []
  other.prefs.onChange((prefs) => seen.push(prefs))
  emit({ voice: { a: 1, b: 2 } })
  emit({ voice: { b: 2, a: 1 } })
  emit({ voice: { b: 2, a: 1 }, other: { x: 1 } })
  emit({ voice: { a: 1 } })
  assert.deepEqual(seen, [{ a: 1, b: 2 }, { a: 1 }])
})

test("the host's prefs.onChange is seeded from the prefs now: the first unrelated change is not heard", async () => {
  const appSettings = fakeAppSettings({ plugins: { voice: { active: false } } })
  const fake = fakeBackend()
  const host = createClientHost(voice, fake.backend, { appSettings, terminalLabel: String, currentBackend: () => fake.backend })
  const heard = []
  host.prefs.onChange((prefs) => heard.push(prefs))
  await new Promise((r) => setImmediate(r))
  await appSettings.update({ showNotifications: false })
  assert.deepEqual(heard, [])
  await host.prefs.set('active', true)
  assert.deepEqual(heard, [{ active: true }])
})

test('isCurrent: false once the window has another backend', () => {
  const fake = fakeBackend()
  let current = fake.backend
  const host = createClientHost(voice, fake.backend, { appSettings: fakeAppSettings(), terminalLabel: String, currentBackend: () => current })
  assert.equal(host.isCurrent(), true)
  current = fakeBackend().backend
  assert.equal(host.isCurrent(), false)
})

test('pluginStatus: a built-in a released server (0.3–0.10) had in core counts on there; not on a P3+ server that leaves it out', () => {
  const github = { id: 'github', version: '1.0.0', name: 'GitHub', description: '', defaultEnabled: true, legacyBuiltIn: true }
  const released = { capabilities: [], plugins: [{ id: 'linear', version: '1.0.0', defaultEnabled: true }] }
  assert.equal(pluginStatus(github, released, undefined), 'legacy')
  // The project's setting is not read there, as on a server older than plugins.
  assert.equal(pluginStatus(github, released, { github: { enabled: false } }), 'legacy')
  assert.equal(pluginStatus(github, { ...released, capabilities: ['prResolve'] }, undefined), 'missing')
  // A plugin that was never built in stays missing.
  const quiet = { id: 'quiet', version: '1.0.0', name: 'Quiet', description: '', defaultEnabled: true }
  assert.equal(pluginStatus(quiet, released, undefined), 'missing')
})

test("pluginStatus: an installed plugin's entry with a built-in's id is not the built-in", () => {
  // An older server may hold a theme whose id a newer client has built in.
  const asTheme = { plugins: [{ id: 'voice', version: '9.0.0', defaultEnabled: true, type: 'theme', sha256: 'a'.repeat(64) }], capabilities: [] }
  assert.equal(pluginStatus(voice, asTheme, { voice: { enabled: true } }), 'missing')
  const hashOnly = { plugins: [{ id: 'voice', version: '9.0.0', defaultEnabled: true, sha256: 'a'.repeat(64) }], capabilities: [] }
  assert.equal(pluginStatus(voice, hashOnly, undefined), 'missing')
})

test('host (campsite): the session view and focusSession go through the deps; without them it is empty', () => {
  const fake = fakeBackend()
  const list = [{ terminalId: 't1' }]
  const focused = []
  const host = createClientHost(voice, fake.backend, {
    appSettings: fakeAppSettings(),
    terminalLabel: String,
    currentBackend: () => fake.backend,
    sessions: () => list,
    onSessionsChanged: (l) => (l(), () => {}),
    selectedTerminalId: () => 't1',
    focusSession: (id) => focused.push(id)
  })
  assert.equal(host.sessions(), list)
  let heard = 0
  host.onSessionsChanged(() => heard++)
  assert.equal(heard, 1)
  assert.equal(host.selectedTerminalId(), 't1')
  host.focusSession('t1')
  assert.deepEqual(focused, ['t1'])
  const bare = createClientHost(voice, fake.backend, { appSettings: fakeAppSettings(), terminalLabel: String, currentBackend: () => fake.backend })
  assert.deepEqual(bare.sessions(), [])
  assert.equal(bare.selectedTerminalId(), null)
  assert.equal(typeof bare.onSessionsChanged(() => {}), 'function')
  bare.focusSession('x')
})

test("the host (plugins E3): a request's timeout; the repos, their changes and the settings writes through the window; core's dialogs and fields", async () => {
  const sent = []
  const backend = {
    plugins: {
      projectId: 'p1',
      welcome: () => undefined,
      request: async (method, params, options) => (sent.push([method, params, options]), null),
      onEvent: () => () => {},
      onConnected: () => () => {}
    }
  }
  const env = { id: 'env', version: '1.0.0', name: 'Colima environments', description: '', defaultEnabled: true }
  const repos = [{ id: 'r1', name: 'app', path: '/r', settings: {}, branchSettings: {}, worktrees: [] }]
  const writes = []
  const listeners = []
  const host = createClientHost(env, backend, {
    appSettings: fakeAppSettings(),
    terminalLabel: String,
    currentBackend: () => backend,
    repos: (id) => (id === 'env' ? repos : []),
    onReposChanged: (l) => (listeners.push(l), () => listeners.splice(listeners.indexOf(l), 1)),
    setRepoSettings: (...args) => void writes.push(['repo', ...args]),
    setBranchSettings: (...args) => void writes.push(['branch', ...args]),
    confirm: async (prompt) => (writes.push(['confirm', prompt]), prompt.confirmLabel === 'Reset'),
    showError: async (title) => void writes.push(['error', title])
  })
  await host.request('up', { worktreeId: 'w2' }, { timeoutMs: 1_800_000 })
  assert.deepEqual(sent, [['env.up', { worktreeId: 'w2' }, { timeoutMs: 1_800_000 }]])
  // A timeout is used only when finite and positive, capped at an hour.
  sent.length = 0
  for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '9000', 2 * 3_600_000]) await host.request('up', {}, { timeoutMs })
  await host.request('up', {})
  assert.deepEqual(sent.map(([, , options]) => options), [undefined, undefined, undefined, undefined, undefined, { timeoutMs: 3_600_000 }, undefined])
  sent.length = 0
  await host.request('up', { worktreeId: 'w2' }, { timeoutMs: 1_800_000 })
  assert.deepEqual(sent, [['env.up', { worktreeId: 'w2' }, { timeoutMs: 1_800_000 }]])
  assert.equal(host.repos(), repos)
  const off = host.onReposChanged(() => {})
  assert.equal(listeners.length, 1)
  off()
  assert.equal(listeners.length, 0)
  host.setRepoSettings('r1', { enabled: true })
  host.setBranchSettings('r1', 'feat', { env: 'A=1' })
  await host.showError('Could not remove environment', 'x')
  assert.deepEqual(writes, [
    ['repo', 'env', 'r1', { enabled: true }, 'Colima environments'],
    ['branch', 'env', 'r1', 'feat', { env: 'A=1' }, 'Colima environments'],
    ['error', 'Could not remove environment']
  ])
  writes.length = 0
  assert.equal(await host.confirm({ title: 'T', message: 'M', confirmLabel: 'Reset', dialogId: 'x', defaultCancel: true }), true)
  // Only the four fields, as strings: a plugin can't reach the dialog's other options.
  await host.confirm({ title: 1, message: 'M', detail: 2, confirmLabel: 'OK', cancelLabel: 'Nope' })
  assert.deepEqual(writes, [
    ['confirm', { title: 'T', message: 'M', confirmLabel: 'Reset' }],
    ['confirm', { title: '1', message: 'M', detail: '2', confirmLabel: 'OK' }]
  ])
  // Without the window's deps (a test's host): no repos (one stable array), a confirm declined, fields that render nothing.
  const bare = createClientHost(env, backend, { appSettings: fakeAppSettings(), terminalLabel: String, currentBackend: () => backend })
  assert.deepEqual([bare.repos(), bare.repos() === bare.repos(), await bare.confirm({ title: 'T', message: 'M', confirmLabel: 'OK' })], [[], true, false])
  assert.equal(bare.components.SettingText({ value: '', onCommit: () => {} }), null)
})

test('pluginStatus (plugins A1b): a plugin the server lists as required is on whatever the project says', () => {
  const welcome = { plugins: [{ id: 'quiet', version: '1.0.0', defaultEnabled: false, required: true }], capabilities: [] }
  assert.equal(pluginStatus(quiet, welcome, { quiet: { enabled: false } }), 'on')
  assert.equal(pluginStatus(quiet, { plugins: [{ id: 'quiet', version: '1.0.0', defaultEnabled: false }], capabilities: [] }, { quiet: { enabled: false } }), 'off', 'not listed so: the setting holds')
})

const agentPlugin = { id: 'codex', version: '1.0.0', name: 'Codex', description: '', defaultEnabled: true, coreBefore: 'agentInfo' }

test('pluginStatus (plugins A2): a plugin core used to be is legacy on a server that says neither it nor the capability that came with it', () => {
  // 0.12.0: it lists plugins, and runs the agents in core.
  assert.equal(pluginStatus(agentPlugin, { plugins: [{ id: 'voice', version: '1.0.0', defaultEnabled: true }], capabilities: ['agents'] }, {}), 'legacy')
  // A server older than plugins.
  assert.equal(pluginStatus(agentPlugin, { capabilities: ['agents'] }, {}), 'legacy')
  // From A1b: listed, so on or off by the project.
  assert.equal(pluginStatus(agentPlugin, { plugins: [{ id: 'codex', version: '1.0.0', defaultEnabled: true }], capabilities: ['agents', 'agentInfo'] }, { codex: { enabled: false } }), 'off')
  // From A1b, where its setup failed: the server says the capability without the plugin.
  assert.equal(pluginStatus(agentPlugin, { plugins: [], capabilities: ['agents', 'agentInfo'] }, {}), 'missing')
})

test('pluginRequired (plugins A2): only from the built-in entry the server lists as required', () => {
  const welcome = { plugins: [{ id: 'quiet', version: '1.0.0', defaultEnabled: true, required: true }, { id: 'voice', version: '1.0.0', defaultEnabled: true }], capabilities: [] }
  assert.equal(pluginRequired(quiet, welcome), true)
  assert.equal(pluginRequired(voice, welcome), false)
  assert.equal(pluginRequired(quiet, { plugins: [{ id: 'quiet', version: '1.0.0', defaultEnabled: true, required: true, type: 'theme' }], capabilities: [] }), false, "an installed plugin's entry is not the built-in's")
  assert.equal(pluginRequired(quiet, undefined), false)
})

test("the host (plugins A2): its plugin's project settings, read and written through the window; an agent's models from the server", async () => {
  const projectFile = { name: 'p', claudePermissionMode: 'plan', claudeArgs: '', titleBarColor: '#111' }
  const writes = []
  const listeners = []
  const asked = []
  const backend = {
    plugins: { projectId: 'p1', welcome: () => ({ plugins: [], capabilities: ['agents', 'agentInfo'] }), request: async () => null, onEvent: () => () => {}, onConnected: () => () => {} },
    agents: { models: async (provider) => (asked.push(provider), [{ id: 'qwen', label: 'qwen' }]) }
  }
  const manifest = { id: 'claude', version: '1.0.0', name: 'Claude Code', description: '', defaultEnabled: true, projectSettings: { claudePermissionMode: 'string', claudeArgs: 'string' } }
  const host = createClientHost(manifest, backend, {
    appSettings: fakeAppSettings(),
    terminalLabel: String,
    currentBackend: () => backend,
    projectSettings: cachedProjectSettings(() => projectFile),
    onProjectSettingsChanged: (l) => (listeners.push(l), () => listeners.splice(listeners.indexOf(l), 1)),
    setProjectSetting: (...args) => void writes.push(args)
  })
  // Its own keys that have a value: never another plugin's or core's.
  assert.deepEqual(host.projectSettings(), { claudePermissionMode: 'plan' })
  assert.equal(host.projectSettings(), host.projectSettings(), 'the same object while the project is the same')
  const off = host.onProjectSettingsChanged(() => {})
  assert.equal(listeners.length, 1)
  off()
  assert.equal(listeners.length, 0)
  host.setProjectSetting('claudePermissionMode', 'acceptEdits')
  host.setProjectSetting('titleBarColor', '#000')
  assert.deepEqual(writes, [['claudePermissionMode', 'acceptEdits', 'Claude Code']], "a key its manifest doesn't declare is not written")
  assert.deepEqual(await host.agentModels('local'), [{ id: 'qwen', label: 'qwen' }])
  assert.deepEqual(asked, ['local'])
  // A server without agentInfo can't list an agent's models.
  const old = { ...backend, plugins: { ...backend.plugins, welcome: () => ({ plugins: [], capabilities: ['agents'] }) } }
  await assert.rejects(createClientHost(manifest, old, { appSettings: fakeAppSettings(), terminalLabel: String, currentBackend: () => old }).agentModels('local'), /update it/)
  // Without the window's deps (a test's host): no values (one stable object), nothing written.
  const bare = createClientHost(manifest, backend, { appSettings: fakeAppSettings(), terminalLabel: String, currentBackend: () => backend })
  assert.deepEqual([bare.projectSettings(), bare.projectSettings() === bare.projectSettings()], [{}, true])
  bare.setProjectSetting('claudePermissionMode', 'plan')
})

test('cachedProjectSettings (plugins A2): a plugin\'s string values, made again only when the project changes', () => {
  let project = { claudePermissionMode: 'plan', claudeArgs: 7 }
  const read = cachedProjectSettings(() => project)
  const first = read('claude', ['claudePermissionMode', 'claudeArgs'])
  assert.deepEqual(first, { claudePermissionMode: 'plan' })
  assert.equal(read('claude', ['claudePermissionMode', 'claudeArgs']), first)
  project = { claudePermissionMode: 'auto' }
  assert.deepEqual(read('claude', ['claudePermissionMode', 'claudeArgs']), { claudePermissionMode: 'auto' })
  assert.deepEqual(cachedProjectSettings(() => null)('claude', ['claudePermissionMode']), {})
})
