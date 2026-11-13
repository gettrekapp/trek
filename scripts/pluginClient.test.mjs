// scripts/pluginClient.test.mjs — a project window's plugins (plugin system phase 1): each
// plugin's status from the server's welcome and the project's setting, and its host: `<id>.*`
// requests and events (another project's dropped), plugins.changed (integrations.changed from an
// older server), per-app prefs and whether it still serves the window.
import test from 'node:test'
import assert from 'node:assert/strict'
import { changedFor, forProject, pluginActive, pluginStatus, withPluginEnabled } from '../src/renderer/src/plugins/presence.ts'
import { createClientHost } from '../src/renderer/src/plugins/host.ts'
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
