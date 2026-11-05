// scripts/serverV2.test.mjs — v2 dispatch: topics, server.addRepo / server.removeRepo, errors.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { publishServerState } from '../server/src/serverState.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { applyStatePatch } from '../src/shared/sync/topicState.ts'

function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-v2-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', a])
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid-1', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const stop = publishServerState(store, hub, '0.2.0')
  t.after(() => {
    stop()
    store.close()
  })
  const sent = []
  const subscriber = { send: (topic, rev, ops) => sent.push({ topic, rev, ops }) }
  const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber })
  return { dir, a, store, sent, call }
}

test('subscribing to server returns identity, repos and no projects', async (t) => {
  const { a, call } = setup(t)
  const res = await call('sub.subscribe', { topic: 'server' })
  assert.deepEqual(res, {
    ok: true,
    result: {
      rev: 0,
      snapshot: {
        server: { serverId: 'sid-1', name: 'box', version: '0.2.0', health: [] },
        projects: [],
        repos: [{ id: 'a', name: 'a', path: a }]
      }
    }
  })
})

test('attention starts empty', async (t) => {
  const { call } = setup(t)
  const res = await call('sub.subscribe', { topic: 'attention' })
  assert.deepEqual(res.result, { snapshot: { entries: [] }, rev: 0 })
})

test('bad and unknown topics', async (t) => {
  const { call } = setup(t)
  assert.equal((await call('sub.subscribe', { topic: 'bogus' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('sub.subscribe', { topic: 'project:nope' })).error.code, 'NOT_FOUND')
})

test('server.addRepo registers the repo and patches the server topic', async (t) => {
  const { dir, call, sent } = setup(t)
  const sub = await call('sub.subscribe', { topic: 'server' })
  const b = join(dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', b])
  assert.deepEqual(await call('server.addRepo', { path: b, name: 'Bee' }), { ok: true, result: { repoId: 'b' } })
  assert.equal(sent.length, 1)
  const outcome = applyStatePatch(sub.result, sent[0])
  assert.equal(outcome.kind, 'applied')
  assert.deepEqual(outcome.state.snapshot.repos.map((r) => r.name), ['a', 'Bee'])
})

test('server.addRepo errors: missing path, outside roots, not a repo', async (t) => {
  const { dir, call, store } = setup(t)
  assert.equal((await call('server.addRepo', {})).error.code, 'BAD_REQUEST')
  const outside = join(dir, 'outside', 'c')
  execFileSync('git', ['init', '-q', outside])
  assert.equal((await call('server.addRepo', { path: outside })).error.code, 'PATH_DENIED')
  mkdirSync(join(dir, 'repos', 'plain'))
  assert.equal((await call('server.addRepo', { path: join(dir, 'repos', 'plain') })).error.code, 'NOT_A_REPO')
  assert.equal(store.config.repos.length, 1)
})

test('server.addRepo rejects an empty or whitespace-only name', async (t) => {
  const { dir, call, store } = setup(t)
  const b = join(dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', b])
  assert.equal((await call('server.addRepo', { path: b, name: '' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('server.addRepo', { path: b, name: '   ' })).error.code, 'BAD_REQUEST')
  assert.equal(store.config.repos.length, 1)
})

test('server.removeRepo does not fall back to paths', async (t) => {
  const { a, call, store } = setup(t)
  assert.equal((await call('server.removeRepo', { repoId: a })).error.code, 'NOT_FOUND')
  assert.equal(store.config.repos.length, 1)
})

test('synchronous handlers return a plain outcome, not a promise', (t) => {
  const { call } = setup(t)
  const res = call('sub.subscribe', { topic: 'server' })
  assert.ok(!(res instanceof Promise))
  assert.equal(res.ok, true)
  assert.ok(!(call('nope.nope', {}) instanceof Promise))
})

test('server.removeRepo: unknown id, in use, then removed', async (t) => {
  const { call, store, sent } = setup(t)
  await call('sub.subscribe', { topic: 'server' })
  assert.equal((await call('server.removeRepo', { repoId: 'nope' })).error.code, 'NOT_FOUND')
  store.setUsage(() => ['Proj'])
  assert.equal((await call('server.removeRepo', { repoId: 'a' })).error.code, 'IN_USE')
  store.setUsage(() => [])
  assert.deepEqual(await call('server.removeRepo', { repoId: 'a' }), { ok: true, result: null })
  assert.equal(sent.length, 1)
  assert.deepEqual(store.config.repos, [])
})

test('unsubscribe stops patches', async (t) => {
  const { dir, call, sent } = setup(t)
  await call('sub.subscribe', { topic: 'server' })
  await call('sub.unsubscribe', { topic: 'server' })
  const b = join(dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', b])
  await call('server.addRepo', { path: b })
  assert.deepEqual(sent, [])
})

test('project.list is empty, ping echoes, unknown methods are NOT_FOUND', async (t) => {
  const { call } = setup(t)
  assert.deepEqual(await call('project.list', {}), { ok: true, result: [] })
  assert.deepEqual(await call('sys.ping', { t: 5 }), { ok: true, result: { t: 5 } })
  assert.equal((await call('git.listWorktrees', {})).error.code, 'NOT_FOUND')
})

test('server.addRepo needs an absolute path', async (t) => {
  const { call } = setup(t)
  assert.equal((await call('server.addRepo', { path: 'repos/a' })).error.code, 'BAD_REQUEST')
})
