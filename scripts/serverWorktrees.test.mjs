// scripts/serverWorktrees.test.mjs — worktree.* against real git in a temp dir.
// Keep a user's global git config and hooks out of the real git these tests run.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { attentionEntries } from '../server/src/sessions/status.ts'
// realPath: on Windows the OS's real path (long names, as git and the server resolve them, not RUNNER~1).
import { realPath } from '../src/host/pathContainment.ts'

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })

async function setup(t) {
  const dir = realPath(mkdtempSync(join(tmpdir(), 'trek-server-wt-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  git(a, 'commit', '--allow-empty', '-q', '-m', 'init')
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  // What the SessionManager's refreshAttention publishes, kept here for the tests to read.
  const attention = { entries: [] }
  const refreshAttention = () => { attention.entries = attentionEntries(projects.all(), new Map(), () => 0) }
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {}, onAttentionChange: refreshAttention })
  t.after(() => { poller.stop(); store.close() })
  const subscriber = { send: () => {} }
  const blocked = []
  const sessions = { blockPath: (path) => { blocked.push(path); return () => { blocked.push(`unblock ${path}`) } }, refreshAttention }
  const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber, projects, poller, sessions })
  const created = await call('project.create', { name: 'P', repositories: [{ path: a }] })
  const projectId = created.result.projectId
  await poller.refresh(a)
  const project = () => projects.require(projectId)
  const repoId = project().repositories[0].id
  const worktree = (id) => project().repositories[0].worktrees.find((w) => w.id === id)
  return { dir, a, store, projects, poller, call, blocked, projectId, repoId, project, worktree, attention, refreshAttention }
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

test('worktree.remove blocks the worktree path while git removes it, then unblocks', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'blk')
  const refresh = s.poller.refresh.bind(s.poller)
  s.poller.refresh = (...args) => { s.blocked.push('refresh'); return refresh(...args) }
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(s.blocked, [wt.path, 'refresh', `unblock ${wt.path}`], 'still blocked while the repo is re-read')
})

test('worktree.remove unblocks when git refuses the removal', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'blkdirty')
  writeFileSync(join(wt.path, 'scratch.txt'), 'x')
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.error.code, 'GIT_ERROR')
  assert.deepEqual(s.blocked, [wt.path, `unblock ${wt.path}`])
})

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

/** Gives a worktree a PR notice (5c-1) and republishes attention, as the PR watch does. */
function withNotice(s, wt) {
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees.find((w) => w.id === wt.id).prNotice = { title: 'PR #12', text: 'changed', url: 'https://github.com/acme/app/pull/12', at: 1 }
  }, { persist: false })
  s.refreshAttention()
  assert.deepEqual(s.attention.entries.map((e) => e.worktreeId), [wt.id])
}

test("worktree.remove: a removed worktree's PR notice leaves the attention topic", async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'noticed')
  withNotice(s, wt)
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.deepEqual(res, { ok: true, result: null })
  assert.deepEqual(s.attention.entries, [])
})

test("the poller dropping a sessionless row takes its PR notice out of the attention topic", async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'dropped')
  withNotice(s, wt)
  git(s.a, 'worktree', 'remove', wt.path)
  await s.poller.refresh(s.a)
  assert.equal(s.worktree(wt.id), undefined)
  assert.deepEqual(s.attention.entries, [])
})

test('worktree.remove refuses a dirty worktree unless forced', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'dirty')
  writeFileSync(join(wt.path, 'scratch.txt'), 'x')
  const refused = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(refused.error.code, 'GIT_ERROR')
  assert.deepEqual(refused.error.details, { reason: 'dirty' })
  assert.ok(existsSync(wt.path))
  const forced = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id, force: true })
  assert.equal(forced.ok, true, JSON.stringify(forced))
  assert.equal(existsSync(wt.path), false)
})

test('worktree.remove reads a modified tracked file as dirty', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'tracked')
  writeFileSync(join(wt.path, 'kept.txt'), 'one')
  git(wt.path, 'add', 'kept.txt')
  git(wt.path, 'commit', '-q', '-m', 'add kept')
  writeFileSync(join(wt.path, 'kept.txt'), 'two')
  const refused = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(refused.error.code, 'GIT_ERROR')
  assert.deepEqual(refused.error.details, { reason: 'dirty' })
  assert.ok(existsSync(wt.path))
})

test('worktree.remove: a refusal that is not about changes carries no reason', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'locked')
  git(s.a, 'worktree', 'lock', wt.path)
  const refused = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(refused.error.code, 'GIT_ERROR')
  assert.equal(refused.error.details, undefined)
  assert.ok(existsSync(wt.path))
})

test('worktree.remove: the main worktree, bad force, unknown ids', async (t) => {
  const s = await setup(t)
  const mainId = s.project().repositories[0].worktrees[0].id
  assert.equal((await s.call('worktree.remove', { projectId: s.projectId, worktreeId: mainId })).error.code, 'BAD_REQUEST')
  const wt = await withWorktree(s, 'x')
  assert.equal((await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id, force: 'yes' })).error.code, 'BAD_REQUEST')
  assert.equal((await s.call('worktree.remove', { projectId: s.projectId, worktreeId: 'nope' })).error.code, 'NOT_FOUND')
})

/** A second project on the same repository, polled so it lists the same worktrees. */
async function secondProject(s, name) {
  const created = await s.call('project.create', { name, repositories: [{ path: s.a }] })
  assert.equal(created.ok, true, JSON.stringify(created))
  await s.poller.refresh(s.a)
  const id = created.result.projectId
  const row = (path) => s.projects.require(id).repositories[0].worktrees.find((w) => w.path === path)
  return { id, row }
}

test('worktree.remove is IN_USE while another project has the path loaded, and names it', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'busy')
  const other = await secondProject(s, 'Elsewhere')
  s.projects.apply(other.id, (d) => { d.repositories[0].worktrees.find((w) => w.path === wt.path).loaded = true })
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.error.code, 'IN_USE')
  assert.match(res.error.message, /in Elsewhere;/)
  assert.ok(existsSync(wt.path))
})

test('worktree.remove in one project leaves another project\'s rows for that path to the poller', async (t) => {
  const s = await setup(t)
  const withSessions = await withWorktree(s, 'kept-by-other')
  const plain = await withWorktree(s, 'dropped-by-other')
  const other = await secondProject(s, 'Other')
  const session = { id: 'other-sess', title: 'S', llm: { provider: 'claude' }, queue: [], status: 'idle' }
  s.projects.apply(other.id, (d) => { d.repositories[0].worktrees.find((w) => w.path === withSessions.path).sessions.push(session) })
  for (const wt of [withSessions, plain]) {
    const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
    assert.equal(res.ok, true, JSON.stringify(res))
  }
  assert.equal(other.row(plain.path), undefined)
  assert.equal(other.row(withSessions.path).missing, true)
  assert.equal(other.row(withSessions.path).sessions[0].id, 'other-sess')
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

test('worktree.remove removes a worktree whose directory is gone but git still lists', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'stale')
  rmSync(wt.path, { recursive: true, force: true })
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(s.worktree(wt.id), undefined)
  assert.doesNotMatch(git(s.a, 'worktree', 'list'), /stale/)
})

test('worktree.changes and worktree.diff report uncommitted work', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'work')
  writeFileSync(join(wt.path, 'new.txt'), 'hello\n')
  const changes = await s.call('worktree.changes', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(changes.ok, true, JSON.stringify(changes))
  assert.deepEqual(changes.result.files.map((f) => [f.path, f.status]), [['new.txt', 'added']])
  const diff = await s.call('worktree.diff', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(diff.ok, true, JSON.stringify(diff))
  assert.match(diff.result['new.txt'], /\+hello/)
})

test('worktree.push sets the upstream; worktree.pull fast-forwards', async (t) => {
  const s = await setup(t)
  const origin = join(s.dir, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin], { env: gitEnv })
  git(s.a, 'remote', 'add', 'origin', origin)
  git(s.a, 'push', '-q', 'origin', 'main')
  const wt = await withWorktree(s, 'shared')
  git(wt.path, 'commit', '--allow-empty', '-q', '-m', 'one')

  const pushed = await s.call('worktree.push', { projectId: s.projectId, worktreeId: wt.id, setUpstream: true })
  assert.equal(pushed.ok, true, JSON.stringify(pushed))
  assert.match(git(s.a, 'ls-remote', 'origin', 'shared'), /refs\/heads\/shared/)
  assert.equal(s.worktree(wt.id).ahead, 0, 'statuses were refreshed after the push')

  const other = join(s.dir, 'other')
  execFileSync('git', ['clone', '-q', '-b', 'shared', origin, other], { env: gitEnv })
  git(other, 'commit', '--allow-empty', '-q', '-m', 'two')
  git(other, 'push', '-q', 'origin', 'shared')
  const pulled = await s.call('worktree.pull', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(pulled.ok, true, JSON.stringify(pulled))
  assert.equal(git(wt.path, 'log', '-1', '--format=%s').trim(), 'two')
  assert.equal(s.worktree(wt.id).head, git(wt.path, 'rev-parse', 'HEAD').trim())
})

test('worktree.pull/push refusals: detached HEAD, bad setUpstream, no remote', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'lonely')
  assert.equal((await s.call('worktree.push', { projectId: s.projectId, worktreeId: wt.id })).error.code, 'BAD_REQUEST')
  assert.equal((await s.call('worktree.push', { projectId: s.projectId, worktreeId: wt.id, setUpstream: false })).error.code, 'GIT_ERROR')
  git(wt.path, 'checkout', '-q', '--detach')
  await s.poller.refresh(s.a)
  assert.equal((await s.call('worktree.pull', { projectId: s.projectId, worktreeId: wt.id })).error.code, 'BAD_REQUEST')
})

test('worktree.remove of a stale worktree leaves the repo\'s other stale worktrees alone', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'stale-one')
  const unmounted = await withWorktree(s, 'stale-two')
  rmSync(wt.path, { recursive: true, force: true })
  rmSync(unmounted.path, { recursive: true, force: true })
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.ok, true, JSON.stringify(res))
  const listed = git(s.a, 'worktree', 'list')
  assert.doesNotMatch(listed, /stale-one/)
  assert.match(listed, /stale-two/, 'not pruned along with it')
})

test("the main checkout's changes, diff and pull: its own repository's path is not a clash", async (t) => {
  const s = await setup(t)
  const main = s.project().repositories[0].worktrees.find((w) => w.isMain)
  const ids = { projectId: s.projectId, worktreeId: main.id }
  writeFileSync(join(s.a, 'new.txt'), 'hello\n')
  const changes = await s.call('worktree.changes', ids)
  assert.deepEqual([changes.ok, changes.result?.files.map((f) => f.path)], [true, ['new.txt']])
  assert.equal((await s.call('worktree.diff', ids)).ok, true)
  // No upstream here: git's own refusal, not the server's.
  assert.equal((await s.call('worktree.pull', ids)).error?.code, 'GIT_ERROR')
  // A main row that names another path than its repository's is still refused.
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees.find((w) => w.isMain).path = join(s.dir, 'repos')
  })
  const other = (await s.call('worktree.changes', ids)).error
  assert.equal(other?.code, 'BAD_REQUEST')
  assert.match(other?.message ?? '', /is not the checkout of/)
  // Nor one that names a second registered repository's checkout.
  const b = join(s.dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', '-b', 'main', b], { env: gitEnv })
  git(b, 'commit', '--allow-empty', '-q', '-m', 'init')
  s.store.addRepo(b, {})
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees.find((w) => w.isMain).path = b
  })
  const registered = (await s.call('worktree.changes', ids)).error
  assert.equal(registered?.code, 'BAD_REQUEST')
  assert.match(registered?.message ?? '', /is not the checkout of/)
})

test('worktree.pull, push and diff refuse a missing worktree', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'gone-soon')
  const session = { id: 'sess-m', title: 'S', llm: { provider: 'claude' }, queue: [], status: 'idle' }
  s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === wt.id).sessions.push(session) })
  rmSync(wt.path, { recursive: true, force: true })
  git(s.a, 'worktree', 'prune')
  await s.poller.refresh(s.a)
  assert.equal(s.worktree(wt.id).missing, true)
  const ids = { projectId: s.projectId, worktreeId: wt.id }
  assert.equal((await s.call('worktree.pull', ids)).error?.code, 'BAD_REQUEST')
  assert.equal((await s.call('worktree.push', { ...ids, setUpstream: false })).error?.code, 'BAD_REQUEST')
  assert.equal((await s.call('worktree.diff', ids)).error?.code, 'BAD_REQUEST')
})

/** dispatchV2 with a poller whose refresh changes nothing, so a row keeps what was written into it. */
const callWithInertPoller = (s, method, params) => dispatchV2(method, params,
  { store: s.store, hub: new TopicHub(), subscriber: { send: () => {} }, projects: s.projects, poller: { refresh: async () => true, warning: () => undefined }, sessions: { blockPath: () => () => {} } })

test('worktree.pull and push refuse a branch name that git would read as an option', async (t) => {
  const s = await setup(t)
  const origin = join(s.dir, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin], { env: gitEnv })
  git(s.a, 'remote', 'add', 'origin', origin)
  git(s.a, 'push', '-q', 'origin', 'main')
  const wt = await withWorktree(s, 'victim')
  const pwned = join(s.dir, 'PWNED')
  for (const branch of ['--mirror', `--upload-pack=touch ${pwned}; git-upload-pack`]) {
    s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === wt.id).branch = branch })
    const ids = { projectId: s.projectId, worktreeId: wt.id }
    assert.equal((await callWithInertPoller(s, 'worktree.pull', ids)).error?.code, 'BAD_REQUEST', `pull ${branch}`)
    assert.equal((await callWithInertPoller(s, 'worktree.push', { ...ids, setUpstream: true })).error?.code, 'BAD_REQUEST', `push ${branch}`)
    assert.equal((await callWithInertPoller(s, 'worktree.push', { ...ids, setUpstream: false })).error?.code, 'BAD_REQUEST', `push ${branch}`)
  }
  assert.equal(existsSync(pwned), false)
  assert.doesNotMatch(git(s.a, 'ls-remote', 'origin'), /victim/, 'nothing was pushed')
})

test('worktree.push refuses a checked-out branch whose name starts with "-"', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'plain')
  git(wt.path, 'update-ref', 'refs/heads/--mirror', 'HEAD')
  git(wt.path, 'symbolic-ref', 'HEAD', 'refs/heads/--mirror')
  const res = await s.call('worktree.push', { projectId: s.projectId, worktreeId: wt.id, setUpstream: false })
  assert.equal(res.error?.code, 'BAD_REQUEST', JSON.stringify(res))
})

test('worktree.pull uses the branch that is checked out now, not the one the row last saw', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'a')
  git(wt.path, 'checkout', '-q', '-b', 'b')
  assert.equal(s.worktree(wt.id).branch, 'a', 'the row has not been polled yet')
  const res = await s.call('worktree.pull', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.error?.code, 'GIT_ERROR', JSON.stringify(res))
  assert.match(res.error.message, /origin (-- )?refs\/heads\/b\b/)
  assert.doesNotMatch(res.error.message, /refs\/heads\/a\b/)
  assert.equal(s.worktree(wt.id).branch, 'b')
})

test('worktree.pull is BAD_REQUEST once the worktree turns out to be detached', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'soon-detached')
  git(wt.path, 'checkout', '-q', '--detach')
  assert.equal((await s.call('worktree.pull', { projectId: s.projectId, worktreeId: wt.id })).error?.code, 'BAD_REQUEST')
})

test('worktree commands refuse a worktree path outside the allowlist', async (t) => {
  const s = await setup(t)
  const outside = join(s.dir, 'outside')
  execFileSync('git', ['init', '-q', '-b', 'main', outside], { env: gitEnv })
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees.push({ id: 'planted', name: 'planted', path: outside, isMain: false, loaded: false, branch: 'main', sessions: [] })
  })
  const ids = { projectId: s.projectId, worktreeId: 'planted' }
  assert.equal((await s.call('worktree.changes', ids)).error?.code, 'PATH_DENIED')
  assert.equal((await s.call('worktree.diff', ids)).error?.code, 'PATH_DENIED')
  assert.equal((await callWithInertPoller(s, 'worktree.pull', ids)).error?.code, 'PATH_DENIED')
})

test('worktree.remove deletes a worktree git lists outside the allowlist (an agent\'s temp worktree)', async (t) => {
  const s = await setup(t)
  for (const [branch, dirty] of [['tmp-clean', false], ['tmp-dirty', true]]) {
    const path = join(s.dir, 'scratchpad', branch)
    git(s.a, 'worktree', 'add', '-q', '-b', branch, path)
    if (dirty) writeFileSync(join(path, 'scratch.txt'), 'x')
    await s.poller.refresh(s.a)
    const wt = s.project().repositories[0].worktrees.find((w) => w.path === path)
    assert.ok(wt, 'the poller lists it')
    if (dirty) {
      const refused = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
      assert.equal(refused.error?.code, 'GIT_ERROR', JSON.stringify(refused))
      assert.equal(refused.error.details?.reason, 'dirty')
    }
    const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id, force: dirty })
    assert.deepEqual(res, { ok: true, result: null })
    assert.equal(existsSync(path), false)
    assert.equal(s.worktree(wt.id), undefined)
  }
})

test('worktree.remove refuses a row outside the allowlist that git does not list', async (t) => {
  const s = await setup(t)
  const outside = join(s.dir, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'keep.txt'), 'x')
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees.push({ id: 'planted', name: 'planted', path: outside, isMain: false, loaded: false, branch: 'main', sessions: [] })
  })
  for (const force of [false, true]) {
    const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: 'planted', force })
    assert.equal(res.error?.code, 'PATH_DENIED', JSON.stringify(res))
    assert.ok(existsSync(join(outside, 'keep.txt')))
  }
})

test('worktree commands refuse a worktree that is itself a registered repo', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'other')
  s.store.addRepo(wt.path, {})
  for (const force of [false, true]) {
    const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id, force })
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'BAD_REQUEST', JSON.stringify(res))
    assert.ok(existsSync(wt.path))
  }
  const changes = await s.call('worktree.changes', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(changes.ok, false)
  assert.equal(changes.error.code, 'BAD_REQUEST', JSON.stringify(changes))
})
