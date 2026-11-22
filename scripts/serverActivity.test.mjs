// scripts/serverActivity.test.mjs — core's activity feed (campsite part 2) and the plugin host's onActivity/emitAll.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActivityFeed } from '../server/src/activity.ts'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { projectTopic } from '../src/shared/model/topics.ts'
import { removeDir } from './testPlatform.mjs'

const ev = (n) => ({ kind: 'session.closed', projectId: 'p', at: n, terminalId: 't', worktreeId: null })

test('the feed calls every listener in order, and unsubscribe stops one', () => {
  const feed = createActivityFeed()
  const a = []
  const b = []
  feed.subscribe((e) => a.push(e.at))
  const off = feed.subscribe((e) => b.push(e.at))
  feed.emit(ev(1))
  off()
  feed.emit(ev(2))
  assert.deepEqual(a, [1, 2])
  assert.deepEqual(b, [1])
})

test('a throwing listener is logged and skipped; the others still run', () => {
  const warnings = []
  const feed = createActivityFeed({ warn: (m) => warnings.push(m), now: () => 0 })
  const seen = []
  feed.subscribe(() => { throw new Error('boom') })
  feed.subscribe((e) => seen.push(e.at))
  feed.emit(ev(1))
  feed.emit(ev(2))
  assert.deepEqual(seen, [1, 2])
  // Logged once a minute per listener, not on every event
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /boom/)
})

/** A registry with one plugin, `test`, on in p1 and off in p2, as serverPlugins.test.mjs builds one */
function registryWith(t, feed, more = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-activity-'))
  t.after(() => removeDir(dir))
  const projects = {
    p1: { id: 'p1', settings: {}, globalSessions: [], repositories: [] },
    p2: { id: 'p2', settings: { plugins: { test: { enabled: false } } }, globalSessions: [], repositories: [] }
  }
  const emitted = []
  const hub = { emitted, emit: (topic, event, data) => (emitted.push([topic, event, data]), 2), eventSubscriberCount: () => 0 }
  const seen = {}
  const warnings = []
  const plugin = {
    manifest: { id: 'test', version: '1.0.0', name: 'test', description: '', defaultEnabled: true },
    setup(host) {
      seen.host = host
      more.onSetup?.(host)
      return more.instance ?? {}
    }
  }
  const registry = createPluginRegistry({
    plugins: [plugin],
    secretsFile: join(dir, 'secrets.json'),
    dataDir: join(dir, 'data'),
    hub,
    projects: { require: (id) => projects[id] ?? (() => { throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' }) })(), all: () => Object.values(projects) },
    isCoreMethod: () => false,
    coreToolNames: [],
    activity: feed,
    warn: (m) => warnings.push(m)
  })
  return { registry, hub, host: seen.host, warnings }
}

test('host.onActivity delivers only events from projects where the plugin is on; emitAll reaches those projects', async (t) => {
  const feed = createActivityFeed()
  const { registry, hub, host } = registryWith(t, feed)
  const got = []
  host.onActivity((e) => got.push(e))
  feed.emit({ kind: 'session.closed', projectId: 'p1', at: 1, terminalId: 't', worktreeId: null })
  feed.emit({ kind: 'session.closed', projectId: 'p2', at: 2, terminalId: 't', worktreeId: null })
  assert.deepEqual(got.map((e) => e.projectId), ['p1'])
  assert.equal(host.emitAll('state', { wood: 1 }), 2)
  assert.deepEqual(hub.emitted, [[projectTopic('p1'), 'test.state', { wood: 1 }]])
  await registry.dispose()
  feed.emit({ kind: 'session.closed', projectId: 'p1', at: 3, terminalId: 't', worktreeId: null })
  assert.equal(got.length, 1, 'disposed: unsubscribed')
})

test("host.onActivity's unsubscribe stops it; a plugin refused after its setup, or disposed, is unsubscribed", async (t) => {
  const feed = createActivityFeed()
  const { host } = registryWith(t, feed)
  const got = []
  const off = host.onActivity((e) => got.push(e))
  off()
  feed.emit({ kind: 'session.closed', projectId: 'p1', at: 1, terminalId: 't', worktreeId: null })
  assert.deepEqual(got, [])

  // A ticket provider whose id is not the plugin's: refused after its setup, and disposed; what it
  // subscribed in setup is dropped from the feed
  const listeners = new Set()
  const counting = { subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) }
  registryWith(t, counting, { instance: { ticketProvider: { id: 'other' } }, onSetup: (h) => h.onActivity(() => {}) })
  assert.equal(listeners.size, 0)
  // Kept, it stays subscribed until the registry's dispose
  const kept = registryWith(t, counting, { onSetup: (h) => h.onActivity(() => {}) })
  assert.equal(listeners.size, 1)
  await kept.registry.dispose()
  assert.equal(listeners.size, 0)
})

test("a plugin's throwing onActivity listener is logged once a minute, naming the plugin; the others still hear", (t) => {
  const feed = createActivityFeed({ warn: () => assert.fail('the plugin host catches it first') })
  const { host, warnings } = registryWith(t, feed)
  const got = []
  host.onActivity(() => { throw new Error('boom') })
  host.onActivity((e) => got.push(e.at))
  feed.emit({ kind: 'session.closed', projectId: 'p1', at: 1, terminalId: 't', worktreeId: null })
  feed.emit({ kind: 'session.closed', projectId: 'p1', at: 2, terminalId: 't', worktreeId: null })
  assert.deepEqual(got, [1, 2])
  assert.deepEqual(warnings, ['[plugin test] onActivity failed on session.closed: boom'])
})

test('host.onActivity after the plugin was disposed subscribes nothing', async (t) => {
  const listeners = new Set()
  const counting = { subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) }
  const { registry, host } = registryWith(t, counting)
  await registry.dispose()
  const off = host.onActivity(() => {})
  assert.equal(listeners.size, 0)
  assert.equal(typeof off, 'function')
  off()
})

test('events are frozen: a listener cannot change what the next one hears', () => {
  const feed = createActivityFeed({ warn: () => {} })
  const seen = []
  feed.subscribe((e) => { e.projectId = 'changed' })
  feed.subscribe((e) => seen.push(e.projectId))
  feed.emit({ kind: 'session.closed', projectId: 'p', at: 1, terminalId: 't', worktreeId: null })
  assert.deepEqual(seen, ['p'])
})
