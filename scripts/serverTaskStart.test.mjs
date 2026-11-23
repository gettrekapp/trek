// scripts/serverTaskStart.test.mjs — task.start: a new worktree on task/<slug> from a real git repo, and a
// session started there with the task as its first message (a fake session manager; no agent runs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { realPath } from '../src/host/pathContainment.ts'
import { removeDir } from './testPlatform.mjs'

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })

async function setup(t, { startFails = false, repos = 1 } = {}) {
  const dir = realPath(mkdtempSync(join(tmpdir(), 'trek-task-start-')))
  t.after(() => removeDir(dir))
  const paths = []
  for (let i = 0; i < repos; i++) {
    const p = join(dir, 'repos', `r${i}`)
    execFileSync('git', ['init', '-q', '-b', 'main', p], { env: gitEnv })
    git(p, 'commit', '--allow-empty', '-q', '-m', 'init')
    paths.push(p)
  }
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid', name: 'box', repos: paths.map((p, i) => ({ id: `r${i}`, name: `r${i}`, path: p })) })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {}, onAttentionChange: () => {} })
  t.after(() => { poller.stop(); store.close() })
  const started = []
  const sessions = {
    refreshAttention() {},
    blockPath: () => () => {},
    start: (p) => {
      if (startFails) throw Object.assign(new Error('a project holds at most 500 sessions; close some first'), { code: 'CAPACITY' })
      started.push(p)
      return { sessionId: `s${started.length}`, ptyId: `pty${started.length}` }
    }
  }
  // No plugins: no PR provider, and no plugin method (an unknown method is NOT_FOUND).
  const plugins = { prProviders: () => [], handler: () => undefined }
  const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber: { send() {} }, projects, poller, sessions, plugins })
  const created = await call('project.create', { name: 'P', repositories: paths.map((path) => ({ path })) })
  const projectId = created.result.projectId
  for (const p of paths) await poller.refresh(p)
  const project = () => projects.require(projectId)
  const repoIds = project().repositories.map((r) => r.id)
  const addTask = async (title, extra = {}) => (await call('task.save', { projectId, task: { title, ...extra } })).result.id
  return { dir, paths, call, project, projectId, repoIds, started, addTask }
}

test('task.start makes task/<slug>, starts a session with the task prompt, and records the start', async (t) => {
  const s = await setup(t)
  const taskId = await s.addTask('Fix the login bug', { details: 'It 500s.' })
  const res = await s.call('task.start', { projectId: s.projectId, taskId, repositoryId: s.repoIds[0] })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.result.branch, 'task/fix-the-login-bug')
  const wt = s.project().repositories[0].worktrees.find((w) => w.id === res.result.worktreeId)
  assert.equal(wt.branch, 'task/fix-the-login-bug')
  assert.ok(existsSync(wt.path))
  assert.equal(s.started.length, 1)
  assert.equal(s.started[0].worktreeId, res.result.worktreeId)
  assert.match(s.started[0].initialMessage, /^Fix the login bug\n\nIt 500s\.\n\nThis is Trek task /)
  const [start] = s.project().tasks[0].starts
  assert.deepEqual([start.repositoryId, start.worktreeId, start.branch, start.sessionId], [s.repoIds[0], res.result.worktreeId, 'task/fix-the-login-bug', 's1'])
})

test('task.start picks -2 when the branch is taken, and starts in the repository asked for', async (t) => {
  const s = await setup(t, { repos: 2 })
  git(s.paths[1], 'branch', 'task/same')
  const taskId = await s.addTask('Same')
  const res = await s.call('task.start', { projectId: s.projectId, taskId, repositoryId: s.repoIds[1] })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.result.branch, 'task/same-2')
  assert.ok(s.project().repositories[1].worktrees.some((w) => w.id === res.result.worktreeId))
})

test('task.start refusals: archived task, unknown repository, unknown task, Tasks off', async (t) => {
  const s = await setup(t)
  const taskId = await s.addTask('Old')
  await s.call('task.setArchived', { projectId: s.projectId, taskId, archived: true })
  const code = async (params) => (await s.call('task.start', { projectId: s.projectId, ...params })).error?.code
  assert.equal(await code({ taskId, repositoryId: s.repoIds[0] }), 'BAD_REQUEST')
  await s.call('task.setArchived', { projectId: s.projectId, taskId, archived: false })
  assert.equal(await code({ taskId, repositoryId: 'nope' }), 'NOT_FOUND')
  assert.equal(await code({ taskId: 'nope', repositoryId: s.repoIds[0] }), 'NOT_FOUND')
  await s.call('project.updateSettings', { projectId: s.projectId, settings: { tasksEnabled: false } })
  assert.equal(await code({ taskId, repositoryId: s.repoIds[0] }), 'TOOL_ERROR')
  assert.equal(s.project().repositories[0].worktrees.filter((w) => !w.isMain).length, 0, 'no worktree was made')
})

test('task.start: a session that fails keeps the worktree, records the start without a session, and names the branch', async (t) => {
  const s = await setup(t, { startFails: true })
  const taskId = await s.addTask('Busy')
  const res = await s.call('task.start', { projectId: s.projectId, taskId, repositoryId: s.repoIds[0] })
  assert.equal(res.error?.code, 'CAPACITY')
  assert.match(res.error.message, /task\/busy/)
  const [start] = s.project().tasks[0].starts
  assert.equal(start.branch, 'task/busy')
  assert.equal('sessionId' in start, false)
  assert.ok(s.project().repositories[0].worktrees.some((w) => w.branch === 'task/busy'))
})
