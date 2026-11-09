// scripts/serverV2.test.mjs — v2 dispatch: topics, server.addRepo / server.removeRepo, errors.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { welcomeCapabilities } from '../server/src/capabilities.ts'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { publishServerState } from '../server/src/serverState.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2, responseRev } from '../server/src/v2.ts'
import { applyStatePatch } from '../src/shared/sync/topicState.ts'

/** `guardOptions` go to the ConfigStore: `{ permissive: true }` is the local server. */
function setup(t, guardOptions = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-v2-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', a])
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid-1', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath, guardOptions)
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
  const subscriber = {
    send: (topic, rev, ops) => sent.push({ topic, rev, ops }),
    ended: (topic, reason) => sent.push({ topic, ended: reason })
  }
  /** Records what the handlers ask of the session manager */
  const forgotten = []
  /** project.rename and project.updateSettings ask for the attention topic again */
  const refreshed = []
  const sessions = {
    forgetProject: (projectId) => forgotten.push(['project', projectId, holder.projects.list().some((x) => x.id === projectId)]),
    forgetRepo: (projectId, repoId) => forgotten.push(['repo', projectId, repoId]),
    forgetGlobal: (projectId) => forgotten.push(['global', projectId]),
    refreshAttention: () => refreshed.push('attention')
  }
  const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber, projects: holder.projects, sessions })
  return { dir, a, store, hub, sent, call, forgotten, refreshed, projects: holder.projects }
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

test('on the local server (a permissive store) server.addRepo takes a repo anywhere; a remote one still refuses', async (t) => {
  const remote = setup(t)
  const local = setup(t, { permissive: true })
  for (const { dir } of [remote, local]) execFileSync('git', ['init', '-q', join(dir, 'outside', 'c')])
  assert.equal((await remote.call('server.addRepo', { path: join(remote.dir, 'outside', 'c') })).error.code, 'PATH_DENIED')
  assert.deepEqual(await local.call('server.addRepo', { path: join(local.dir, 'outside', 'c') }), { ok: true, result: { repoId: 'c' } })
  mkdirSync(join(local.dir, 'outside', 'plain'))
  assert.equal((await local.call('server.addRepo', { path: join(local.dir, 'outside', 'plain') })).error.code, 'NOT_A_REPO')
  assert.equal((await local.call('server.addRepo', { path: 'outside/c' })).error.code, 'BAD_REQUEST')
  assert.deepEqual(remote.store.config.repos.map((r) => r.id), ['a'])
})

test("project.import of a worktree outside its repo's parent: allowed on the local server, PATH_DENIED on a remote one", async (t) => {
  const { importProjectFile } = await import('../src/shared/model/importProject.ts')
  for (const [guardOptions, allowed] of [[{}, false], [{ permissive: true }, true]]) {
    const { dir, a, call } = setup(t, guardOptions)
    const elsewhere = join(dir, 'elsewhere', 'a-feature')
    mkdirSync(elsewhere, { recursive: true })
    let n = 0
    const { projects } = importProjectFile({ version: 3, name: 'File', repositories: [{ id: 'x', name: 'a', path: a, worktrees: [
      { name: 'main', path: a },
      { name: 'feature', path: elsewhere, branch: 'feature' }
    ] }] }, () => `imp-${++n}`)
    const res = await call('project.import', { project: projects[0].project })
    if (allowed) {
      assert.equal(res.ok, true, JSON.stringify(res))
      assert.deepEqual((await call('project.list', {})).result.map((p) => p.name), ['File'])
    } else {
      assert.equal(res.error.code, 'PATH_DENIED')
    }
  }
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

async function snapshotOf(call, projectId) {
  return (await call('sub.subscribe', { topic: `project:${projectId}` })).result.snapshot
}

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
  const { a, call, refreshed } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  assert.equal((await call('project.rename', { projectId, name: 'Q', expected: 'P' })).ok, true)
  assert.equal((await call('project.rename', { projectId, name: 'R', expected: 'P' })).error.code, 'CONFLICT')
  assert.deepEqual((await call('project.list', {})).result.map((p) => p.name), ['Q'])
  assert.deepEqual(refreshed, ['attention'], 'the rename republished attention; the refused one did not')
})

test('project.updateSettings republishes attention, a refused one does not', async (t) => {
  const { a, call, refreshed } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  await call('project.updateSettings', { projectId, settings: { audioAlerts: true } })
  await call('project.updateSettings', { projectId, settings: { audioAlerts: null }, expected: { audioAlerts: false } })
  assert.deepEqual(refreshed, ['attention'])
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
  const inherited = await call('project.updateSettings', { projectId, settings: { claudeCommand: 'y' }, expected: { toString: null } })
  assert.equal(inherited.error.code, 'BAD_REQUEST')
  assert.equal((await snapshotOf(call, projectId)).settings.claudeCommand, 'c')
})

test('project.updateSettings expected guards the settings a settings screen edits: absent is null, values compare deeply', async (t) => {
  const { a, call } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  const update = (settings, expected) => call('project.updateSettings', { projectId, settings, expected })
  const review = [{ id: 'rev', name: 'Review', systemPrompt: 'Review it', llm: { provider: 'codex' } }]
  const buttons = [{ id: 'b', label: 'Test', text: 'npm test' }]
  // Keys never set match null.
  const first = await update(
    { sessionTypes: review, terminalButtons: buttons, worktreeTags: [{ id: 't', name: 'Todo', color: '#fff' }], llmDefault: { provider: 'gemini' }, bot: { enabled: false }, audioAlerts: true },
    { sessionTypes: null, terminalButtons: null, worktreeTags: null, llmDefault: null, bot: null, audioAlerts: null, customTags: null, globalLlm: null, claudeCommand: null }
  )
  assert.equal(first.ok, true, JSON.stringify(first))
  // A structurally equal copy of each current value passes.
  const second = await update(
    { sessionTypes: [...review, { id: 'fix', name: 'Fix', systemPrompt: '' }] },
    { sessionTypes: structuredClone(review), llmDefault: { provider: 'gemini' }, bot: { enabled: false } }
  )
  assert.equal(second.ok, true, JSON.stringify(second))
  // A stale value of one guarded key fails the whole patch.
  const stale = await update({ terminalButtons: [], audioAlerts: false }, { terminalButtons: [], audioAlerts: true })
  assert.deepEqual([stale.error.code, stale.error.message], ['CONFLICT', 'settings.terminalButtons changed since you read it'])
  const settings = (await snapshotOf(call, projectId)).settings
  assert.deepEqual(settings.terminalButtons, buttons)
  assert.equal(settings.audioAlerts, true)
  assert.equal(settings.sessionTypes.length, 2)
  // Order matters inside an array; a removed key reads as null again.
  assert.equal((await update({ audioAlerts: null }, { sessionTypes: [...settings.sessionTypes].reverse() })).error.code, 'CONFLICT')
  assert.equal((await update({ audioAlerts: null }, { audioAlerts: true })).ok, true)
  assert.equal((await update({ audioAlerts: false }, { audioAlerts: null })).ok, true)
})

test('project.updateSettings deleting a tag clears it from every branch in the same patch; a CONFLICT changes nothing', async (t) => {
  const { a, call, sent } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  const tags = [{ id: 'todo', name: 'Todo', color: '#fff' }, { id: 'done', name: 'Done', color: '#000' }]
  const custom = [{ id: 'x', name: 'X', color: '#fff' }, { id: 'y', name: 'Y', color: '#000' }]
  await call('project.updateSettings', { projectId, settings: { worktreeTags: tags, customTags: custom } })
  const repoId = (await snapshotOf(call, projectId)).repositories[0].id
  const ref = (branch) => ({ projectId, repoId, branch })
  await call('branch.setTag', { ...ref('f1'), tag: 'todo' })
  await call('branch.setCustomTags', { ...ref('f1'), customTags: ['x', 'y'] })
  await call('branch.setTag', { ...ref('f2'), tag: 'done' })
  await call('branch.setCustomTags', { ...ref('f3'), customTags: ['y'] })
  const sub = await call('sub.subscribe', { topic: `project:${projectId}` })
  sent.length = 0

  // A stale guard: CONFLICT, and neither the settings nor the branches change.
  const stale = await call('project.updateSettings', { projectId, settings: { worktreeTags: [tags[1]] }, expected: { worktreeTags: [] } })
  assert.equal(stale.error.code, 'CONFLICT')
  assert.equal(sent.length, 0)

  // Renaming a tag (same id) clears nothing.
  const renamed = [{ ...tags[0], name: 'To do' }, tags[1]]
  assert.equal((await call('project.updateSettings', { projectId, settings: { worktreeTags: renamed }, expected: { worktreeTags: tags } })).ok, true)
  assert.equal(sent.length, 1)
  let state = applyStatePatch(sub.result, sent[0]).state
  assert.deepEqual(state.snapshot.repositories[0].branchData, { f1: { tag: 'todo', customTags: ['x', 'y'] }, f2: { tag: 'done' }, f3: { customTags: ['y'] } })

  // Deleting "todo" and "y": one patch, one rev, settings and branches together.
  sent.length = 0
  const res = await call('project.updateSettings', { projectId, settings: { worktreeTags: [tags[1]], customTags: [custom[0]] }, expected: { worktreeTags: renamed } })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].rev, state.rev + 1)
  state = applyStatePatch(state, sent[0]).state
  assert.deepEqual(state.snapshot.settings.worktreeTags, [tags[1]])
  assert.deepEqual(state.snapshot.repositories[0].branchData, { f1: { customTags: ['x'] }, f2: { tag: 'done' } })
  assert.deepEqual(state.snapshot, await snapshotOf(call, projectId))
})

test('wrong id types are BAD_REQUEST, not NOT_FOUND', async (t) => {
  const { a, call } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  assert.equal((await call('project.rename', { projectId: 5, name: 'Q' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('project.delete', {})).error.code, 'BAD_REQUEST')
  assert.equal((await call('repo.update', { projectId, repoId: 5, name: 'X' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('repo.listBranches', { projectId, repoId: null })).error.code, 'BAD_REQUEST')
  const repoId = (await snapshotOf(call, projectId)).repositories[0].id
  assert.equal((await call('branch.setNote', { projectId, repoId, branch: 7, note: 'n' })).error.code, 'BAD_REQUEST')
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

test('responseRev: a project command reports its project topic, a registry or project-list command the server topic', async (t) => {
  const { a, hub, call } = setup(t)
  const params = { name: 'P', repositories: [{ path: a }] }
  const { projectId } = (await call('project.create', params)).result
  const serverRev = hub.rev('server')
  assert.deepEqual(responseRev('project.create', params, hub), { topic: 'server', rev: serverRev })
  const topic = `project:${projectId}`
  assert.deepEqual(responseRev('project.rename', { projectId }, hub), { topic, rev: 0 })
  await call('project.rename', { projectId, name: 'Q' })
  await call('project.rename', { projectId, name: 'R' })
  assert.deepEqual(responseRev('project.rename', { projectId }, hub), { topic, rev: 2 })
  // A read that names a project reports the rev it read at.
  assert.deepEqual(responseRev('repo.listBranches', { projectId, repoId: 'x' }, hub), { topic, rev: 2 })
  // Renames and the delete each change the server topic's project list.
  await call('project.delete', { projectId })
  assert.equal(hub.rev('server'), serverRev + 3)
  assert.deepEqual(responseRev('project.delete', { projectId }, hub), { topic: 'server', rev: serverRev + 3 })
  assert.equal(responseRev('project.rename', { projectId }, hub), undefined, 'the topic is gone')
  assert.equal(responseRev('sys.ping', { t: 1 }, hub), undefined)
  assert.equal(responseRev('pty.write', { ptyId: 'x', data: 'y' }, hub), undefined)
  assert.equal(responseRev('project.rename', { projectId: 5 }, hub), undefined)
  assert.equal(responseRev('project.rename', undefined, hub), undefined)
})

test('project.delete ends the project topic for its subscribers, before the server topic drops it', async (t) => {
  const { a, call, sent } = setup(t)
  await call('sub.subscribe', { topic: 'server' })
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  await call('sub.subscribe', { topic: `project:${projectId}` })
  sent.length = 0
  await call('project.delete', { projectId })
  assert.deepEqual(sent.map((m) => m.ended ? [m.topic, m.ended] : [m.topic, 'patch']), [[`project:${projectId}`, 'deleted'], ['server', 'patch']])
})

test('welcome capabilities: mcp while the listener is up, then what the server always has, then local on the local server', () => {
  const all = ['topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills']
  assert.deepEqual(welcomeCapabilities(true), ['mcp', ...all])
  assert.deepEqual(welcomeCapabilities(false), all)
  assert.deepEqual(welcomeCapabilities(true, false), ['mcp', ...all])
  assert.deepEqual(welcomeCapabilities(true, true), ['mcp', ...all, 'local'])
  assert.deepEqual(welcomeCapabilities(false, true), [...all, 'local'])
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

async function withProject(t) {
  const env = setup(t)
  const { projectId } = (await env.call('project.create', { name: 'P', repositories: [{ path: env.a }] })).result
  const snap = () => snapshotOf(env.call, projectId)
  return { ...env, projectId, snap }
}

test('repo.add adds a registered repo once; repo.remove refuses the last one', async (t) => {
  const { dir, call, projectId, snap } = await withProject(t)
  const b = join(dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', b])
  await call('server.addRepo', { path: b })
  const added = await call('repo.add', { projectId, path: b, name: 'Bee' })
  assert.equal(added.ok, true)
  assert.equal((await call('repo.add', { projectId, path: b })).error.code, 'BAD_REQUEST')
  const s = await snap()
  assert.deepEqual(s.repositories.map((r) => r.name), ['a', 'Bee'])
  assert.equal((await call('repo.remove', { projectId, repoId: added.result.repoId })).ok, true)
  assert.equal((await call('repo.remove', { projectId, repoId: s.repositories[0].id })).error.code, 'BAD_REQUEST')
  assert.equal((await call('repo.remove', { projectId, repoId: 'nope' })).error.code, 'NOT_FOUND')
})

test('repo.remove prunes worktreeOrder entries for that repo', async (t) => {
  const { dir, call, projectId, snap } = await withProject(t)
  const b = join(dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', b])
  await call('server.addRepo', { path: b })
  const { repoId } = (await call('repo.add', { projectId, path: b })).result
  const keep = `${(await snap()).repositories[0].id} /x`
  await call('project.updateSettings', { projectId, settings: { worktreeOrder: [keep, `${repoId} /y`] } })
  await call('repo.remove', { projectId, repoId })
  assert.deepEqual((await snap()).settings.worktreeOrder, [keep])
})

test('repo.update: name, linkedDirs, environments, null removes, expected guards', async (t) => {
  const { call, projectId, snap } = await withProject(t)
  const repoId = (await snap()).repositories[0].id
  assert.equal((await call('repo.update', { projectId, repoId, name: 'Main', linkedDirs: ['node_modules'] })).ok, true)
  let r = (await snap()).repositories[0]
  assert.equal(r.name, 'Main')
  assert.deepEqual(r.linkedDirs, ['node_modules'])
  assert.equal((await call('repo.update', { projectId, repoId, linkedDirs: null, expected: { linkedDirs: ['node_modules'] } })).ok, true)
  r = (await snap()).repositories[0]
  assert.equal(r.linkedDirs, undefined)
  assert.equal((await call('repo.update', { projectId, repoId, name: 'X', expected: { name: 'old' } })).error.code, 'CONFLICT')
  assert.equal((await call('repo.update', { projectId, repoId, name: ' ' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('repo.update', { projectId, repoId, environments: [] })).error.code, 'BAD_REQUEST')
  assert.equal((await call('repo.update', { projectId, repoId, name: 'Y', expected: { linkedDir: [] } })).error.code, 'BAD_REQUEST')
  assert.equal((await snap()).repositories[0].name, 'Main')
})

test('repo.add compares paths by realpath', async (t) => {
  const { a, dir, store, call, projectId } = await withProject(t)
  const link = join(dir, 'link-a')
  symlinkSync(a, link)
  // The registry now spells the project's repo through a symlink.
  store.update((c) => { c.repos[0].path = link })
  assert.equal((await call('repo.add', { projectId, path: link })).error.code, 'BAD_REQUEST')
})

test('repo.listBranches lists git branches', async (t) => {
  const { a, call, projectId, snap } = await withProject(t)
  execFileSync('git', ['-C', a, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init'])
  execFileSync('git', ['-C', a, 'branch', 'feature'])
  const repoId = (await snap()).repositories[0].id
  const res = await call('repo.listBranches', { projectId, repoId })
  assert.equal(res.ok, true)
  assert.ok(res.result.includes('feature'))
})

test('branch.* set and clear branch data; an empty entry disappears', async (t) => {
  const { call, projectId, snap } = await withProject(t)
  const repoId = (await snap()).repositories[0].id
  const ref = { projectId, repoId, branch: 'feature/x' }
  await call('branch.setTag', { ...ref, tag: 'review' })
  await call('branch.setCustomTags', { ...ref, customTags: ['ui'] })
  await call('branch.setNote', { ...ref, note: 'hello' })
  await call('branch.setTicket', { ...ref, ticket: 'TOW-1' })
  await call('branch.setPr', { ...ref, pr: 'https://github.com/o/r/pull/1' })
  await call('branch.setEnv', { ...ref, env: 'A=1' })
  assert.deepEqual((await snap()).repositories[0].branchData['feature/x'], {
    tag: 'review', customTags: ['ui'], note: 'hello', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/1', env: 'A=1'
  })
  assert.equal((await call('branch.setNote', { ...ref, note: 'x', expected: 'stale' })).error.code, 'CONFLICT')
  // branch.setEnv is a compare-and-set too: a stale guard changes nothing, a current one writes.
  assert.equal((await call('branch.setEnv', { ...ref, env: 'B=2', expected: 'stale' })).error.code, 'CONFLICT')
  assert.equal((await call('branch.setEnv', { ...ref, env: 'B=2', expected: null })).error.code, 'CONFLICT')
  assert.equal((await snap()).repositories[0].branchData['feature/x'].env, 'A=1')
  assert.equal((await call('branch.setEnv', { ...ref, env: 'B=2', expected: 'A=1' })).ok, true)
  assert.equal((await snap()).repositories[0].branchData['feature/x'].env, 'B=2')
  for (const [method, field] of [['branch.setTag', 'tag'], ['branch.setNote', 'note'], ['branch.setTicket', 'ticket'], ['branch.setPr', 'pr'], ['branch.setEnv', 'env']]) {
    await call(method, { ...ref, [field]: null })
  }
  await call('branch.setCustomTags', { ...ref, customTags: [] })
  assert.equal((await snap()).repositories[0].branchData['feature/x'], undefined)
})

test('branch.*: empty strings and null customTags clear; missing customTags is BAD_REQUEST', async (t) => {
  const { call, projectId, snap } = await withProject(t)
  const repoId = (await snap()).repositories[0].id
  const ref = { projectId, repoId, branch: 'b' }
  await call('branch.setTag', { ...ref, tag: 'review' })
  await call('branch.setCustomTags', { ...ref, customTags: ['ui'] })
  await call('branch.setNote', { ...ref, note: 'n' })
  assert.equal((await call('branch.setTag', { ...ref, tag: '' })).ok, true)
  assert.equal((await call('branch.setCustomTags', { ...ref, customTags: null })).ok, true)
  assert.deepEqual((await snap()).repositories[0].branchData.b, { note: 'n' })
  for (const [method, field] of [['branch.setNote', 'note'], ['branch.setTicket', 'ticket'], ['branch.setPr', 'pr'], ['branch.setEnv', 'env']]) {
    await call(method, { ...ref, [field]: 'v' })
    assert.equal((await call(method, { ...ref, [field]: '' })).ok, true)
  }
  assert.equal((await snap()).repositories[0].branchData.b, undefined)
  assert.equal((await call('branch.setCustomTags', ref)).error.code, 'BAD_REQUEST')
})

test('branch names: constructor works, __proto__ is refused', async (t) => {
  const { call, projectId, snap } = await withProject(t)
  const repoId = (await snap()).repositories[0].id
  assert.equal((await call('branch.setNote', { projectId, repoId, branch: 'constructor', note: 'n' })).ok, true)
  assert.equal((await snap()).repositories[0].branchData.constructor.note, 'n')
  assert.equal((await call('branch.setNote', { projectId, repoId, branch: '__proto__', note: 'n' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('branch.setTag', { projectId, repoId, branch: 'b', tag: 5 })).error.code, 'BAD_REQUEST')
})

test('repo.update rejects an own __proto__ key in environments', async (t) => {
  const { call, projectId, snap } = await withProject(t)
  const repoId = (await snap()).repositories[0].id
  const r = await call('repo.update', { projectId, repoId, environments: JSON.parse('{"__proto__":{"x":1}}') })
  assert.equal(r.error.code, 'BAD_REQUEST')
  assert.equal((await call('repo.update', { projectId, repoId, name: 'Still works' })).ok, true)
})

test('project.delete and repo.remove end their sessions, and only once the removal is done', async (t) => {
  const { dir, call, projectId, snap, forgotten, projects } = await withProject(t)
  const b = join(dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', b])
  await call('server.addRepo', { path: b })
  const { repoId } = (await call('repo.add', { projectId, path: b })).result
  const first = (await snap()).repositories[0].id
  await call('repo.remove', { projectId, repoId: 'nope' })
  assert.deepEqual(forgotten, [], 'a refused remove ends nothing')
  await call('repo.remove', { projectId, repoId })
  assert.deepEqual(forgotten, [['repo', projectId, repoId], ['global', projectId]])
  assert.equal((await call('repo.remove', { projectId, repoId: first })).error.code, 'BAD_REQUEST')
  assert.equal(forgotten.length, 2, 'the last repository is not removed, so its sessions keep running')
  assert.equal((await call('project.delete', { projectId })).ok, true)
  assert.deepEqual(forgotten[2], ['project', projectId, false])
  assert.throws(() => projects.require(projectId))
  await call('project.delete', { projectId })
  assert.equal(forgotten.length, 3, 'an unknown project ends nothing')
})
