// scripts/serverMcpTools.test.mjs — trek-dev tools on the server: describing and resolving worktrees, then the tools.
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeWorktree, resolveWorktree } from '../server/src/mcp/describe.ts'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { MCP_TOOLS, createToolCaller } from '../server/src/mcp/tools.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { SessionManager } from '../server/src/sessions/manager.ts'
import { TopicHub } from '../server/src/topicHub.ts'

// Keep a user's global git config and hooks out of the real git these tests run.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

const s = (id, status = 'idle') => ({ id, title: id, llm: { provider: 'claude' }, queue: ['q'], status })
const project = {
  id: 'p', name: 'P',
  settings: { worktreeTags: [{ id: 't1', name: 'Todo', color: '#fff' }], customTags: [{ id: 'c1', name: 'Hot', color: '#f00' }] },
  globalSessions: [],
  repositories: [
    { id: 'ra', name: 'A', path: '/r/a', branchData: { feat: { tag: 't1', customTags: ['c1'], note: 'n', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3' } }, worktrees: [
      { id: 'am', name: 'A', path: '/r/a', branch: 'main', isMain: true, loaded: false, sessions: [] },
      { id: 'af', name: 'feat', path: '/r/a-feat', branch: 'feat', isMain: false, loaded: true, dirty: true, ahead: 1, behind: 0, sessions: [s('s1', 'working')] }
    ] },
    { id: 'rb', name: 'B', path: '/r/b', branchData: {}, worktrees: [
      { id: 'bm', name: 'B', path: '/r/b', branch: 'main', isMain: true, loaded: false, sessions: [] }
    ] }
  ]
}

test('describeWorktree', () => {
  assert.deepEqual(describeWorktree(project, project.repositories[0], project.repositories[0].worktrees[1]), {
    worktree: 'af', repo: 'A', path: '/r/a-feat', branch: 'feat', primary: false, missing: false,
    tag: 'Todo', customTags: ['Hot'], ticket: 'TOW-1', pullRequest: 'https://github.com/o/r/pull/3', note: 'n',
    dirty: true, ahead: 1, behind: 0, loaded: true,
    sessions: [{ terminalId: 's1', title: 's1', status: 'working', llm: { provider: 'claude' }, queue: ['q'] }]
  })
})

test('resolveWorktree: id, path, then branch or name; ambiguity across repositories', () => {
  assert.equal(resolveWorktree(project, 'af').worktree.id, 'af')
  assert.equal(resolveWorktree(project, '/r/a-feat').worktree.id, 'af')
  assert.equal(resolveWorktree(project, 'feat').worktree.id, 'af')
  assert.throws(() => resolveWorktree(project, 'main'), (e) => e.code === 'BAD_REQUEST' && /A: \/r\/a/.test(e.message) && /B: \/r\/b/.test(e.message))
  assert.throws(() => resolveWorktree(project, 'nope'), (e) => e.code === 'NOT_FOUND')
})

/** A fake pty: records writes, emits output, exits on demand (as in serverSessions.test.mjs). */
function fakeSpawner() {
  const spawned = []
  const spawner = (opts) => {
    const proc = {
      opts, written: [], killed: false, dataCb: () => {}, exitCb: () => {},
      onData(cb) { this.dataCb = cb }, onExit(cb) { this.exitCb = cb },
      write(d) { this.written.push(d) }, resize() {}, pause() {}, resume() {},
      kill() { this.killed = true; setImmediate(() => this.exitCb(129)) },
      emit(d) { this.dataCb(d) }, exit(code) { this.exitCb(code) }
    }
    spawned.push(proc)
    return proc
  }
  return { spawned, spawner }
}

/** A project on a real git repo, a fake pty spawner, and a tool caller for it. */
async function toolSetup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-mcp-tools-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  execFileSync('git', ['-C', a, 'commit', '--allow-empty', '-q', '-m', 'init'], { env: gitEnv })
  const configPath = join(dir, 'config.json')
  const registered = { id: 'a', name: 'a', path: a }
  saveConfig(configPath, { repos: [registered] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
  const { spawned, spawner } = fakeSpawner()
  const jobs = []
  const schedule = (fn, ms) => { const job = { fn, ms, cancelled: false, fired: false }; jobs.push(job); return { cancel: () => { job.cancelled = true } } }
  const sessions = new SessionManager({ projects, store, hub, spawner, schedule, discover: async () => undefined })
  t.after(() => { sessions.stopAll(); poller.stop(); store.close() })
  const projectId = projects.create('P', [{ registered, name: undefined }])
  await poller.refresh(a)
  const callerFor = createToolCaller({ store, hub, projects, poller, sessions, pollMs: 5, graceMs: 10, readyTimeouts: { firstOutputMs: 200, settleMs: 200 } })
  /** Fires the one pending 2.5 s quiet timer of a session's current run. */
  const fireQuiet = () => {
    const job = jobs.find((j) => j.ms === 2500 && !j.cancelled && !j.fired)
    assert.ok(job, 'a quiet timer is pending')
    job.fired = true
    job.fn()
  }
  return { call: callerFor(projectId), callerFor, projects, projectId, sessions, spawned, registered, fireQuiet, a, dir }
}

test('the tool list matches decision 5', () => {
  assert.deepEqual(MCP_TOOLS.map((t) => t.name).sort(), [
    'close_session', 'create_worktree', 'delete_session_type', 'enqueue_prompt', 'get_current_session',
    'list_session_types', 'list_worktrees', 'load_worktree', 'read_terminal', 'remove_queued_prompt',
    'save_session_type', 'send_keys', 'send_prompt', 'set_worktree_custom_tag', 'set_worktree_note',
    'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'start_session', 'unload_worktree',
    'wait_for_sessions'
  ])
})

test('list_worktrees and create_worktree', async (t) => {
  const s = await toolSetup(t)
  assert.equal((await s.call('list_worktrees', {})).length, 1)
  const created = await s.call('create_worktree', { branch: 'feat/x' })
  assert.equal(created.branch, 'feat/x')
  assert.equal((await s.call('list_worktrees', {})).length, 2)
})

test('branch data tools: tag by name, custom tag, note, ticket, pull request', async (t) => {
  const s = await toolSetup(t)
  s.projects.apply(s.projectId, (d) => {
    d.settings.worktreeTags = [{ id: 'todo', name: 'Todo', color: '#fff' }]
    d.settings.customTags = [{ id: 'hot', name: 'Hot', color: '#f00' }]
  })
  assert.deepEqual(await s.call('set_worktree_tag', { worktree: 'main', tag: 'todo' }), { branch: 'main', tag: 'Todo' })
  await assert.rejects(s.call('set_worktree_tag', { worktree: 'main', tag: 'nope' }), /Todo/)
  assert.deepEqual(await s.call('set_worktree_custom_tag', { worktree: 'main', tag: 'hot' }), { branch: 'main', customTags: ['Hot'] })
  assert.deepEqual(await s.call('set_worktree_note', { worktree: 'main', note: 'hi' }), { branch: 'main' })
  const ticket = await s.call('set_worktree_ticket', { worktree: 'main', ticket: 'https://linear.app/acme/issue/tow-5/x' })
  assert.deepEqual(ticket, { branch: 'main', ticket: 'TOW-5', url: 'https://linear.app/acme/issue/TOW-5' })
  assert.deepEqual(await s.call('set_worktree_pull_request', { worktree: 'main', pullRequest: 'https://github.com/o/r/pull/9' }), { branch: 'main', pullRequest: 'https://github.com/o/r/pull/9' })
  const data = s.projects.require(s.projectId).repositories[0].branchData.main
  assert.deepEqual([data.tag, data.customTags, data.note, data.ticket, data.pr], ['todo', ['hot'], 'hi', 'TOW-5', 'https://github.com/o/r/pull/9'])
  assert.equal(s.projects.require(s.projectId).settings.linearWorkspace, 'acme')
})

test('session types: list, save (create and update by name), delete', async (t) => {
  const s = await toolSetup(t)
  assert.deepEqual(await s.call('list_session_types', {}), [])
  const created = await s.call('save_session_type', { name: 'Review', systemPrompt: 'Review it' })
  assert.equal(created.name, 'Review')
  const updated = await s.call('save_session_type', { name: 'review', initialMessage: 'go' })
  assert.equal(updated.id, created.id)
  assert.equal(updated.initialMessage, 'go')
  assert.equal(updated.systemPrompt, 'Review it')
  // As on the desktop, a name match takes the name as passed: the type is now "review".
  assert.equal(updated.name, 'review')
  assert.deepEqual(await s.call('delete_session_type', { sessionType: 'Review' }), { deleted: 'review' })
  assert.deepEqual(await s.call('list_session_types', {}), [])
})

test('load_worktree and unload_worktree', async (t) => {
  const s = await toolSetup(t)
  assert.deepEqual(await s.call('load_worktree', { worktree: 'main' }), { loaded: true, sessions: [] })
  assert.deepEqual(await s.call('unload_worktree', { worktree: 'main' }), { unloaded: true })
})
