// scripts/serverV2.test.mjs — v2 dispatch: topics, server.addRepo / server.removeRepo, errors.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { ProjectState } from '../server/src/projects/state.ts'
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
  const holder = {}
  const server = publishServerState(store, hub, '0.2.0', {
    projects: () => holder.projects?.list() ?? [],
    health: () => []
  })
  holder.projects = new ProjectState({
    hub,
    store: { save: () => {}, remove: () => {} },
    onSummariesChange: () => server.refresh()
  })
  store.setUsage((repo) => holder.projects.usage(repo.path))
  t.after(() => {
    server.stop()
    store.close()
  })
  const sent = []
  const subscriber = { send: (topic, rev, ops) => sent.push({ topic, rev, ops }) }
  const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber, projects: holder.projects })
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

test('project.create from registered repos; listed, subscribable and in the server topic', async (t) => {
  const { a, call } = setup(t)
  const server = await call('sub.subscribe', { topic: 'server' })
  const created = await call('project.create', { name: 'Proj', repositories: [{ path: a }] })
  assert.equal(created.ok, true)
  const { projectId } = created.result
  assert.deepEqual((await call('project.list', {})).result, [{ id: projectId, name: 'Proj' }])
  const topic = await call('sub.subscribe', { topic: `project:${projectId}` })
  assert.equal(topic.result.snapshot.repositories[0].path, a)
  assert.equal(topic.result.snapshot.repositories[0].worktrees[0].isMain, true)
  assert.ok(server.result.rev >= 0)
})

test('project.create errors', async (t) => {
  const { dir, a, call } = setup(t)
  assert.equal((await call('project.create', { name: ' ', repositories: [{ path: a }] })).error.code, 'BAD_REQUEST')
  assert.equal((await call('project.create', { name: 'P', repositories: [] })).error.code, 'BAD_REQUEST')
  assert.equal((await call('project.create', { name: 'P', repositories: [{ path: a }, { path: a }] })).error.code, 'BAD_REQUEST')
  assert.equal((await call('project.create', { name: 'P', repositories: [{ path: join(dir, 'nope') }] })).error.code, 'PATH_DENIED')
})

test('project.rename with expected; CONFLICT on a stale guard', async (t) => {
  const { a, call } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  assert.equal((await call('project.rename', { projectId, name: 'Q', expected: 'P' })).ok, true)
  assert.equal((await call('project.rename', { projectId, name: 'R', expected: 'P' })).error.code, 'CONFLICT')
  assert.deepEqual((await call('project.list', {})).result.map((p) => p.name), ['Q'])
})

test('project.updateSettings merges, null removes, expected is per key', async (t) => {
  const { a, call } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  await call('project.updateSettings', { projectId, settings: { claudeCommand: 'c', audioAlerts: true } })
  await call('project.updateSettings', { projectId, settings: { audioAlerts: null }, expected: { claudeCommand: 'c' } })
  const conflict = await call('project.updateSettings', { projectId, settings: { claudeCommand: 'x' }, expected: { claudeCommand: 'old' } })
  assert.equal(conflict.error.code, 'CONFLICT')
  const snap = (await call('sub.subscribe', { topic: `project:${projectId}` })).result.snapshot
  assert.deepEqual(snap.settings, { claudeCommand: 'c' })
  assert.equal((await call('project.updateSettings', { projectId, settings: { nope: 1 } })).error.code, 'BAD_REQUEST')
})

test('project.delete removes it everywhere; removeRepo is IN_USE until then', async (t) => {
  const { a, call } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  assert.equal((await call('server.removeRepo', { repoId: 'a' })).error.code, 'IN_USE')
  assert.equal((await call('project.delete', { projectId })).ok, true)
  assert.equal((await call('sub.subscribe', { topic: `project:${projectId}` })).error.code, 'NOT_FOUND')
  assert.equal((await call('project.delete', { projectId })).error.code, 'NOT_FOUND')
  assert.equal((await call('server.removeRepo', { repoId: 'a' })).ok, true)
})

test('project.import accepts a project from importProjectFile', async (t) => {
  const { a, call } = setup(t)
  const { importProjectFile } = await import('../src/shared/model/importProject.ts')
  let n = 0
  const { projects } = importProjectFile({ version: 3, name: 'File', repositories: [{ id: 'x', name: 'a', path: a, worktrees: [{ name: 'main', path: a }] }] }, () => `imp-${++n}`)
  const res = await call('project.import', { project: projects[0].project })
  assert.equal(res.ok, true)
  assert.deepEqual((await call('project.list', {})).result.map((p) => p.name), ['File'])
  const again = await call('project.import', { project: projects[0].project })
  assert.equal(again.error.code, 'BAD_REQUEST')
})
