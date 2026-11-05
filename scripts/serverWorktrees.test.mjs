// scripts/serverWorktrees.test.mjs — worktree.* against real git in a temp dir.
// Keep a user's global git config and hooks out of the real git these tests run.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })

async function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-wt-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  git(a, 'commit', '--allow-empty', '-q', '-m', 'init')
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
  t.after(() => { poller.stop(); store.close() })
  const subscriber = { send: () => {} }
  const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber, projects, poller })
  const created = await call('project.create', { name: 'P', repositories: [{ path: a }] })
  const projectId = created.result.projectId
  await poller.refresh(a)
  const project = () => projects.require(projectId)
  const repoId = project().repositories[0].id
  const worktree = (id) => project().repositories[0].worktrees.find((w) => w.id === id)
  return { dir, a, store, projects, poller, call, projectId, repoId, project, worktree }
}

test('worktree.create cuts a new branch at <repo>-<branch> and lists it', async (t) => {
  const s = await setup(t)
  const res = await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch: 'feat/x', createBranch: true })
  assert.equal(res.ok, true, JSON.stringify(res))
  const wt = s.worktree(res.result.worktreeId)
  assert.equal(wt.path, join(s.dir, 'repos', 'a-feat-x'))
  assert.equal(wt.branch, 'feat/x')
  assert.equal(wt.isMain, false)
  assert.ok(existsSync(wt.path))
})

test('worktree.create checks out an existing branch at a given path', async (t) => {
  const s = await setup(t)
  git(s.a, 'branch', 'old')
  const path = join(s.dir, 'repos', 'elsewhere')
  const res = await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch: 'old', createBranch: false, path })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(s.worktree(res.result.worktreeId).path, path)
  assert.equal(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'old')
})

test('worktree.create links linkedDirs and sets the first workflow tag', async (t) => {
  const s = await setup(t)
  mkdirSync(join(s.a, '.trek'))
  await s.call('repo.update', { projectId: s.projectId, repoId: s.repoId, linkedDirs: ['.trek'] })
  await s.call('project.updateSettings', { projectId: s.projectId, settings: { worktreeTags: [{ id: 'todo', name: 'Todo', color: '#ffffff' }] } })
  const res = await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch: 'tagged', createBranch: true })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.ok(lstatSync(join(s.worktree(res.result.worktreeId).path, '.trek')).isSymbolicLink())
  assert.equal(s.project().repositories[0].branchData.tagged.tag, 'todo')
})

test('worktree.create keeps a tag the branch already has', async (t) => {
  const s = await setup(t)
  await s.call('project.updateSettings', { projectId: s.projectId, settings: { worktreeTags: [{ id: 'todo', name: 'Todo', color: '#ffffff' }] } })
  await s.call('branch.setTag', { projectId: s.projectId, repoId: s.repoId, branch: 'kept', tag: 'review' })
  await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch: 'kept', createBranch: true })
  assert.equal(s.project().repositories[0].branchData.kept.tag, 'review')
})

test('worktree.create refusals', async (t) => {
  const s = await setup(t)
  const base = { projectId: s.projectId, repoId: s.repoId, createBranch: true }
  const code = async (params) => (await s.call('worktree.create', params)).error?.code
  assert.equal(await code({ ...base, branch: '-x' }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'a..b' }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'ok', createBranch: 'yes' }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'ok', fromPr: 3 }), 'BAD_REQUEST', 'fromPr needs createBranch false')
  assert.equal(await code({ ...base, createBranch: false, branch: 'ok', fromPr: 0 }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'ok', path: 'relative/path' }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'ok', path: join(s.dir, 'outside', 'x') }), 'PATH_DENIED')
  assert.equal(await code({ ...base, branch: 'ok', path: s.a }), 'BAD_REQUEST', 'the repo itself')
  mkdirSync(join(s.dir, 'repos', 'taken'))
  assert.equal(await code({ ...base, branch: 'ok', path: join(s.dir, 'repos', 'taken') }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'ok', repoId: 'nope' }), 'NOT_FOUND')
  assert.equal(await code({ ...base, createBranch: false, branch: 'no-such-branch' }), 'GIT_ERROR')
  assert.equal(git(s.a, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1)
  assert.equal(git(s.a, 'branch', '--list', 'ok').trim(), '')
})

test('worktree.create accepts only real branch names', async (t) => {
  const s = await setup(t)
  git(s.a, 'tag', 'v1')
  git(s.a, 'checkout', '-q', '-b', 'other')
  git(s.a, 'checkout', '-q', 'main')
  const code = async (branch) => (await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch, createBranch: false })).error
  assert.equal((await code('v1'))?.code, 'GIT_ERROR')
  assert.match((await code('v1')).message, /no branch named "v1"/)
  for (const b of ['@{-1}', '@', 'HEAD']) assert.equal((await code(b))?.code, 'BAD_REQUEST', b)
})

test('worktree.create checks out a branch that exists only on a remote', async (t) => {
  const s = await setup(t)
  const origin = join(s.dir, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin], { env: gitEnv })
  git(s.a, 'remote', 'add', 'origin', origin)
  git(s.a, 'branch', 'remote-only')
  git(s.a, 'push', '-q', 'origin', 'remote-only')
  git(s.a, 'branch', '-D', 'remote-only')
  git(s.a, 'fetch', '-q', 'origin')
  const res = await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch: 'remote-only', createBranch: false })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(s.worktree(res.result.worktreeId).branch, 'remote-only')
})

test('worktree.create refuses a path inside another checkout', async (t) => {
  const s = await setup(t)
  const base = { projectId: s.projectId, repoId: s.repoId, createBranch: true }
  const code = async (branch, path) => (await s.call('worktree.create', { ...base, branch, path })).error?.code
  assert.equal(await code('in-main', join(s.a, 'sub')), 'BAD_REQUEST')
  const made = await s.call('worktree.create', { ...base, branch: 'linked' })
  assert.equal(made.ok, true, JSON.stringify(made))
  const linked = s.worktree(made.result.worktreeId).path
  assert.equal(await code('in-linked', join(linked, 'sub')), 'BAD_REQUEST')
})

test('worktree.create fromPr checks out the PR head', async (t) => {
  const s = await setup(t)
  const origin = join(s.dir, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin], { env: gitEnv })
  git(s.a, 'remote', 'add', 'origin', origin)
  git(s.a, 'checkout', '-q', '-b', 'pr-src')
  git(s.a, 'commit', '--allow-empty', '-q', '-m', 'pr work')
  const sha = git(s.a, 'rev-parse', 'HEAD').trim()
  git(s.a, 'push', '-q', 'origin', `${sha}:refs/pull/1/head`)
  git(s.a, 'checkout', '-q', 'main')
  git(s.a, 'branch', '-D', 'pr-src')
  const res = await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch: 'pr-1', createBranch: false, fromPr: 1 })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(git(s.worktree(res.result.worktreeId).path, 'rev-parse', 'HEAD').trim(), sha)
})

test('worktree.create reports a refresh that could not list the repo', async (t) => {
  const s = await setup(t)
  const stub = { refresh: async () => false, warning: () => ({ code: 'REPO_UNAVAILABLE', message: 'boom', since: 0 }) }
  const res = await dispatchV2('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch: 'stubbed', createBranch: true },
    { store: s.store, hub: new TopicHub(), subscriber: { send: () => {} }, projects: s.projects, poller: stub })
  assert.equal(res.error?.code, 'GIT_ERROR')
  assert.match(res.error.message, /boom/)
})

async function withWorktree(s, branch) {
  const res = await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch, createBranch: true })
  assert.equal(res.ok, true, JSON.stringify(res))
  return s.worktree(res.result.worktreeId)
}

test('worktree.remove deletes a clean worktree and its worktreeOrder entry', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'gone')
  const key = `${s.repoId} ${wt.path}`
  await s.call('project.updateSettings', { projectId: s.projectId, settings: { worktreeOrder: [key] } })
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.deepEqual(res, { ok: true, result: null })
  assert.equal(existsSync(wt.path), false)
  assert.equal(s.worktree(wt.id), undefined)
  assert.equal(s.project().settings.worktreeOrder, undefined)
})

test('worktree.remove refuses a dirty worktree unless forced', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'dirty')
  writeFileSync(join(wt.path, 'scratch.txt'), 'x')
  const refused = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(refused.error.code, 'GIT_ERROR')
  assert.ok(existsSync(wt.path))
  const forced = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id, force: true })
  assert.equal(forced.ok, true, JSON.stringify(forced))
  assert.equal(existsSync(wt.path), false)
})

test('worktree.remove: the main worktree, bad force, unknown ids', async (t) => {
  const s = await setup(t)
  const mainId = s.project().repositories[0].worktrees[0].id
  assert.equal((await s.call('worktree.remove', { projectId: s.projectId, worktreeId: mainId })).error.code, 'BAD_REQUEST')
  const wt = await withWorktree(s, 'x')
  assert.equal((await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id, force: 'yes' })).error.code, 'BAD_REQUEST')
  assert.equal((await s.call('worktree.remove', { projectId: s.projectId, worktreeId: 'nope' })).error.code, 'NOT_FOUND')
})

test('worktree.remove is IN_USE while any project has the path loaded', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'busy')
  s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === wt.id).loaded = true })
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.error.code, 'IN_USE')
  assert.match(res.error.message, /P/)
  assert.ok(existsSync(wt.path))
})

test('a vanished worktree with sessions is kept as missing; remove just drops the row', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'vanish')
  const session = { id: 'sess-1', title: 'S', llm: { provider: 'claude' }, queue: [], status: 'idle' }
  s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === wt.id).sessions.push(session) })
  rmSync(wt.path, { recursive: true, force: true })
  git(s.a, 'worktree', 'prune')
  await s.poller.refresh(s.a)
  assert.equal(s.worktree(wt.id).missing, true)
  assert.equal((await s.call('worktree.changes', { projectId: s.projectId, worktreeId: wt.id })).error.code, 'BAD_REQUEST')
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(s.worktree(wt.id), undefined)
})

test('worktree.remove prunes a worktree whose directory is gone but git still lists', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'stale')
  rmSync(wt.path, { recursive: true, force: true })
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(s.worktree(wt.id), undefined)
  assert.doesNotMatch(git(s.a, 'worktree', 'list'), /stale/)
})
