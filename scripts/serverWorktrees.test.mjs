// scripts/serverWorktrees.test.mjs — worktree.* against real git in a temp dir.
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
})
