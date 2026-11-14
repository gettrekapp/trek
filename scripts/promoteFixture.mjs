// scripts/promoteFixture.mjs — the phase 5e tests' fixture (serverPromote.test.mjs,
// serverPromoteTool.test.mjs): one server's handlers over real git in a temp dir, with a session
// manager on a fake pty spawner. Not a test file itself.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { SessionManager } from '../server/src/sessions/manager.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { projectDir } from '../src/host/claudeSessionService.ts'
import { PromoteRequests } from '../server/src/promote/requests.ts'
import { realPath } from '../src/host/pathContainment.ts'
import { removeDirWhenFree } from './testPlatform.mjs'

export const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })
export const CLAUDE_ID = '11111111-2222-4333-8444-555555555555'
export const MAIN_ID = '22222222-2222-4333-8444-555555555555'

function fakeSpawner() {
  const spawned = []
  const spawner = (opts) => {
    const proc = {
      opts, killed: false, dataCb: () => {}, exitCb: () => {},
      onData(cb) { this.dataCb = cb }, onExit(cb) { this.exitCb = cb },
      write() {}, resize() {}, pause() {}, resume() {},
      kill() { this.killed = true; setImmediate(() => this.exitCb(129)) }
    }
    spawned.push(proc)
    return proc
  }
  return { spawned, spawner }
}

/**
 * A repository `app` (main, with origin/HEAD → main) and a worktree on `feat` with a commit, work
 * in progress (changed, staged, untracked), a Claude session with a history, a Codex session, a
 * review draft and branch data; the main checkout has a Claude session of its own.
 */
export async function setup(t, options = {}) {
  // realPath: on Windows the OS's (long names, as the server resolves a repo, not RUNNER~1).
  const dir = realPath(mkdtempSync(join(tmpdir(), 'trek-server-promote-')))
  // A temp home for Claude's histories (projectDir): homedir() reads HOME, or USERPROFILE on Windows.
  const home = process.env.HOME
  const profile = process.env.USERPROFILE
  process.env.HOME = join(dir, 'home')
  process.env.USERPROFILE = join(dir, 'home')
  const restore = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  t.after(() => { restore('HOME', home); restore('USERPROFILE', profile) })
  const origin = join(dir, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv })
  const app = join(dir, 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', app], { env: gitEnv })
  writeFileSync(join(app, 'README'), 'one\n')
  writeFileSync(join(app, '.gitignore'), 'ignored/\n')
  git(app, 'add', '.')
  git(app, 'commit', '-q', '-m', 'init')
  git(app, 'remote', 'add', 'origin', origin)
  git(app, 'push', '-q', '-u', 'origin', 'main')
  git(app, 'remote', 'set-head', 'origin', 'main')
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 's', name: 's', repos: [{ id: 'r', name: 'app', path: app }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {}, onAttentionChange: () => {} })
  const { spawned, spawner } = fakeSpawner()
  // A POSIX server's launches on any OS: a Windows one looks the agent up on PATH before it spawns
  // (winLaunch.ts, checked in serverWinLaunch.test.mjs), and the fake agents are not there.
  const sessions = new SessionManager({ projects, store, hub, spawner, schedule: () => ({ cancel() {} }), discover: async () => undefined, platform: 'linux' })
  const promoteRequests = new PromoteRequests(hub, { timeoutMs: 2000, checkMs: 20, ...(options.requests ?? {}) })
  // In this order, in one hook: the directory goes once what runs over it is stopped.
  t.after(async () => { promoteRequests.stop(); sessions.stopAll(); poller.stop(); store.close(); await removeDirWhenFree(dir) })
  const recoveryDir = join(dir, 'recovery')
  const ctx = { store, hub, subscriber: { send: () => {} }, projects, poller, sessions, promoteRequests, promoteRecoveryDir: recoveryDir }
  const call = (method, params) => dispatchV2(method, params, ctx)
  /** A call from another connection (a window): its own subscriber */
  const callAs = (subscriber, method, params) => dispatchV2(method, params, { ...ctx, subscriber })
  const created = await call('project.create', { name: 'P', repositories: [{ path: app }] })
  const projectId = created.result.projectId
  await poller.refresh(app)
  const project = () => projects.require(projectId)
  const repo = () => project().repositories[0]
  const repoId = repo().id
  const made = await call('worktree.create', { projectId, repoId, branch: 'feat', createBranch: true })
  assert.equal(made.ok, true, JSON.stringify(made))
  const worktreeId = made.result.worktreeId
  const path = repo().worktrees.find((w) => w.id === worktreeId).path
  writeFileSync(join(path, 'feat.txt'), 'committed\n')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'feat')
  writeFileSync(join(path, 'README'), 'one\nchanged\n')
  writeFileSync(join(path, 'staged.txt'), 'staged\n')
  git(path, 'add', 'staged.txt')
  writeFileSync(join(path, 'untracked.txt'), 'new\n')
  mkdirSync(join(path, 'ignored'))
  writeFileSync(join(path, 'ignored', 'local.db'), 'x')
  mkdirSync(projectDir(path), { recursive: true })
  writeFileSync(join(projectDir(path), `${CLAUDE_ID}.jsonl`), '{"type":"user"}\n')
  // Claude's folder of the session's subagent transcripts and tool results
  mkdirSync(join(projectDir(path), CLAUDE_ID, 'subagents'), { recursive: true })
  writeFileSync(join(projectDir(path), CLAUDE_ID, 'subagents', 'agent-1.jsonl'), '{}\n')
  const mainId = repo().worktrees.find((w) => w.isMain).id
  projects.apply(projectId, (d) => {
    const r = d.repositories[0]
    r.worktrees.find((w) => w.id === worktreeId).sessions.push(
      { id: CLAUDE_ID, agentSessionId: CLAUDE_ID, title: 'Claude 1', llm: { provider: 'claude' }, queue: ['later'], status: 'idle' },
      { id: 'codex-1', title: 'Codex 1', llm: { provider: 'codex' }, queue: [], status: 'idle' }
    )
    r.worktrees.find((w) => w.id === worktreeId).review = { revision: 3, comments: [{ id: 'c1', at: 1, source: { kind: 'branch' }, path: 'README', side: 'new', line: 2, lineText: 'changed', body: 'why?' }] }
    r.worktrees.find((w) => w.id === mainId).sessions.push({ id: MAIN_ID, agentSessionId: MAIN_ID, title: 'Main Claude', llm: { provider: 'claude' }, queue: [], status: 'idle' })
    r.branchData.feat = { ...(r.branchData.feat ?? {}), note: 'the note' }
  })
  return { dir, app, call, callAs, recoveryDir, projects, poller, sessions, hub, spawned, projectId, repoId, worktreeId, mainId, path, project, repo, promoteRequests, ctx }
}

export const status = (cwd) => git(cwd, 'status', '--porcelain').split('\n').filter(Boolean).sort()
export const branchOf = (cwd) => git(cwd, 'symbolic-ref', '--short', 'HEAD').trim()

