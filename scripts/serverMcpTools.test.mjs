// scripts/serverMcpTools.test.mjs — trek-dev tools on the server: describing and resolving worktrees, then the tools.
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeWorktree, resolveWorktree } from '../server/src/mcp/describe.ts'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { MCP_TOOLS, createToolCaller } from '../server/src/mcp/tools.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { SessionManager } from '../server/src/sessions/manager.ts'
import { AutomationScheduler } from '../server/src/automations/scheduler.ts'
import { BY_USER, recordHistory } from '../server/src/history/record.ts'
import { HistoryStore } from '../server/src/history/store.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { UiSelections } from '../server/src/ui/selections.ts'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { isCoreMethod } from '../server/src/v2.ts'
import { BUILTIN_SERVER_PLUGINS } from '../plugins/builtin.server.ts'
import { removeDir } from './testPlatform.mjs'

// The server resolves paths as pathContainment's realPath does: on Windows the native realpath,
// which also expands an 8.3 temp folder (C:\Users\RUNNER~1\…) to its long name.
const real = process.platform === 'win32' ? realpathSync.native : realpathSync

// Keep a user's global git config and hooks out of the real git these tests run.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

const s = (id, status = 'idle', extra = {}) => ({ id, title: id, llm: { provider: 'claude' }, queue: ['q'], status, ...extra })
const project = {
  id: 'p', name: 'P',
  settings: { worktreeTags: [{ id: 't1', name: 'Todo', color: '#fff' }], customTags: [{ id: 'c1', name: 'Hot', color: '#f00' }] },
  globalSessions: [],
  repositories: [
    { id: 'ra', name: 'A', path: '/r/a', branchData: { feat: { tag: 't1', customTags: ['c1'], note: 'n', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3' } }, worktrees: [
      { id: 'am', name: 'A', path: '/r/a', branch: 'main', isMain: true, loaded: false, sessions: [] },
      { id: 'af', name: 'feat', path: '/r/a-feat', branch: 'feat', isMain: false, loaded: true, dirty: true, ahead: 1, behind: 0, sessions: [s('s1', 'working'), s('s2', 'idle', { decision: { question: 'Which?', at: 1 } })] }
    ] },
    { id: 'rb', name: 'B', path: '/r/b', branchData: {}, worktrees: [
      { id: 'bm', name: 'B', path: '/r/b', branch: 'main', isMain: true, loaded: false, sessions: [] }
    ] }
  ]
}

test('describeWorktree', () => {
  assert.deepEqual(describeWorktree(project, project.repositories[0], project.repositories[0].worktrees[1]), {
    worktree: 'af', repo: 'A', repoId: 'ra', path: '/r/a-feat', branch: 'feat', primary: false, missing: false,
    tag: 'Todo', customTags: ['Hot'], ticket: 'TOW-1', pullRequest: 'https://github.com/o/r/pull/3', watchingPullRequest: false, note: 'n',
    dirty: true, ahead: 1, behind: 0, loaded: true,
    sessions: [
      { terminalId: 's1', title: 's1', status: 'working', llm: { provider: 'claude' }, queue: ['q'], decision: null },
      { terminalId: 's2', title: 's2', status: 'idle', llm: { provider: 'claude' }, queue: ['q'], decision: 'Which?' }
    ]
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
async function toolSetup(t, opts = {}) {
  const dir = real(mkdtempSync(join(tmpdir(), 'trek-mcp-tools-')))
  t.after(() => removeDir(dir))
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
  // A POSIX server's launches on any OS (the fake agents are not on a Windows PATH).
  const sessions = new SessionManager({ projects, store, hub, spawner, schedule, discover: async () => undefined, platform: 'linux' })
  t.after(() => { sessions.stopAll(); poller.stop(); store.close() })
  // The tools' poll timers are unref'd (as in the server, where the listener holds the loop): hold it for the test.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const projectId = projects.create('P', [{ registered, name: undefined }])
  await poller.refresh(a)
  // The built-in plugins, as the server registers them: their project settings and ticket providers.
  const plugins = createPluginRegistry({
    plugins: BUILTIN_SERVER_PLUGINS,
    secretsFile: join(dir, 'secrets.json'),
    dataDir: join(dir, 'data'),
    hub,
    projects,
    isCoreMethod,
    coreToolNames: MCP_TOOLS.map((tool) => tool.name),
    env: {},
    warn: () => {}
  })
  const history = new HistoryStore(join(dir, 'history'))
  // The automations scheduler over the real session manager, never started: runs happen only when a tool asks.
  // `automations: false` in opts leaves it out, as a server without one.
  // `automationsNow` is the scheduler's clock, for tests that move it.
  const { automations: withAutomations = true, automationsNow, ...callerOpts } = opts
  const automations = withAutomations ? new AutomationScheduler({ projects, sessions, now: automationsNow }) : undefined
  // What the clients show (ui.report); `selections: undefined` in opts leaves it out, as a server without it.
  const selections = new UiSelections(hub)
  const callerFor = createToolCaller({ store, hub, projects, poller, sessions, plugins, history, automations, selections, pollMs: 5, graceMs: 10, readyTimeouts: { firstOutputMs: 200, settleMs: 200 }, ...callerOpts })
  /** Fires the one pending 2.5 s quiet timer of a session's current run. */
  const fireQuiet = () => {
    const job = jobs.find((j) => j.ms === 2500 && !j.cancelled && !j.fired)
    assert.ok(job, 'a quiet timer is pending')
    job.fired = true
    job.fn()
  }
  return { call: callerFor(projectId), callerFor, projects, projectId, sessions, spawned, registered, fireQuiet, a, dir, hub, history, selections }
}

// speak_summary is the voice plugin's since plugin system phase 1 (scripts/voicePlugin.test.mjs).
test('the tool list matches decision 5', () => {
  assert.deepEqual(MCP_TOOLS.map((t) => t.name).sort(), [
    'add_review_comment', 'close_session', 'create_worktree', 'delete_automation', 'delete_session_type', 'enqueue_prompt', 'focus_session', 'get_current_session', 'get_pull_request', 'get_review_comments', 'get_selected_worktree', 'get_stack', 'get_worktree_history',
    'list_automations', 'list_session_types', 'list_worktrees', 'load_worktree', 'mark_session_complete', 'promote_to_primary', 'read_stack_log', 'read_terminal', 'remove_queued_prompt', 'remove_review_comment', 'remove_worktree',
    'rename_session', 'request_decision', 'restart_session', 'run_automation', 'save_automation', 'save_session_type', 'send_keys', 'send_prompt', 'set_worktree_custom_tag', 'set_worktree_note',
    'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'start_session', 'start_stack', 'stop_stack', 'unload_worktree',
    'wait_for_sessions', 'watch_pull_request'
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

test("get_review_comments: the worktree's draft, each comment outdated or not against its own source now (5c-2)", async (t) => {
  const s = await toolSetup(t)
  assert.deepEqual(await s.call('get_review_comments', { worktree: 'main' }), { worktree: s.projects.require(s.projectId).repositories[0].worktrees[0].id, revision: null, comments: [] })
  writeFileSync(join(s.a, 'a.txt'), 'one\ntwo\n')
  const comment = (id, over) => ({ id, source: { kind: 'uncommitted' }, path: 'a.txt', side: 'new', line: 2, lineText: 'two', body: `c ${id}`, at: 1, ...over })
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[0].review = {
      revision: 9,
      comments: [
        comment('fresh'),
        comment('changed', { lineText: 'TWO' }),
        comment('nofile', { path: 'gone.txt' }),
        comment('nocommit', { source: { kind: 'commit', sha: 'f'.repeat(40) } })
      ]
    }
  })
  const res = await s.call('get_review_comments', { worktree: 'main' })
  assert.equal(res.revision, 9)
  assert.deepEqual(res.comments.map((c) => [c.id, c.outdated]), [['fresh', false], ['changed', true], ['nofile', true], ['nocommit', null]])
  assert.deepEqual(res.comments[0], { id: 'fresh', file: 'a.txt', side: 'new', line: 2, lineText: 'two', comment: 'c fresh', by: 'the user', agent: false, source: { kind: 'uncommitted' }, sourceLabel: 'Uncommitted changes', outdated: false })
  // Read-only: the draft is as it was.
  assert.equal(s.projects.require(s.projectId).repositories[0].worktrees[0].review.comments.length, 4)
  await assert.rejects(s.call('get_review_comments', { worktree: 'nope' }), (e) => e.code === 'NOT_FOUND')
})

test('get_review_comments: five sources are checked, a sixth is null; another project\'s worktree is NOT_FOUND', async (t) => {
  const s = await toolSetup(t)
  const run = (...args) => execFileSync('git', ['-C', s.a, ...args], { env: gitEnv, encoding: 'utf8' })
  const shas = []
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(s.a, `f${i}.txt`), `line ${i}\n`)
    run('add', '.')
    run('commit', '-q', '-m', `c${i}`)
    shas.push(run('rev-parse', 'HEAD').trim())
  }
  const wt = () => s.projects.require(s.projectId).repositories[0].worktrees[0]
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[0].review = {
      revision: 3,
      comments: shas.map((sha, i) => ({ id: `c${i}`, source: { kind: 'commit', sha }, path: `f${i}.txt`, side: 'new', line: 1, lineText: `line ${i}`, body: 'b', at: 1 }))
    }
  })
  const res = await s.call('get_review_comments', { worktree: 'main' })
  assert.deepEqual(res.comments.map((c) => c.outdated), [false, false, false, false, false, null])

  // A second project with its own repository: its worktree id is not found from the first.
  const b = join(s.dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', '-b', 'main', b], { env: gitEnv })
  execFileSync('git', ['-C', b, 'commit', '--allow-empty', '-q', '-m', 'init'], { env: gitEnv })
  const other = s.projects.create('Q', [{ registered: { id: 'b', name: 'b', path: b }, name: undefined }])
  const otherWorktree = s.projects.require(other).repositories[0].worktrees[0].id
  await assert.rejects(s.call('get_review_comments', { worktree: otherWorktree }), (e) => e.code === 'NOT_FOUND')
  assert.equal(wt().review.comments.length, 6)
})

test('watch_pull_request: on (polled at once), off, and its refusals', async (t) => {
  const polled = []
  let available = true
  const prWatch = { available: () => available, pollSoon: (...a) => polled.push(a), forget() {}, dismiss() {} }
  const s = await toolSetup(t, { prWatch })
  const codeOf = (p) => p.then(() => 'ok', (e) => e.code)
  assert.match(await s.call('watch_pull_request', { worktree: 'main' }).catch((e) => e.message), /no linked pull request/)
  await s.call('set_worktree_pull_request', { worktree: 'main', pullRequest: 'https://github.com/o/r/pull/9' })
  assert.deepEqual(await s.call('watch_pull_request', { worktree: 'main' }), { branch: 'main', pullRequest: 'https://github.com/o/r/pull/9', watching: true })
  assert.equal(polled.length, 1)
  assert.equal((await s.call('list_worktrees', {}))[0].watchingPullRequest, true)
  assert.deepEqual(await s.call('watch_pull_request', { worktree: 'main', watch: false }), { branch: 'main', pullRequest: 'https://github.com/o/r/pull/9', watching: false })
  assert.equal((await s.call('list_worktrees', {}))[0].watchingPullRequest, false)
  assert.equal(await codeOf(s.call('watch_pull_request', { worktree: 'main', watch: 'yes' })), 'BAD_REQUEST')
  available = false
  assert.equal(await codeOf(s.call('watch_pull_request', { worktree: 'main' })), 'TOOL_ERROR')
  const bare = await toolSetup(t)
  await bare.call('set_worktree_pull_request', { worktree: 'main', pullRequest: 'https://github.com/o/r/pull/9' })
  assert.match(await bare.call('watch_pull_request', { worktree: 'main' }).catch((e) => e.message), /gh is not installed or not signed in/)
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

test('remove_worktree deletes a worktree, keeps its branch, and refuses dirty, loaded or primary ones', async (t) => {
  const s = await toolSetup(t)
  const created = await s.call('create_worktree', { branch: 'feat/rm' })
  writeFileSync(join(created.path, 'scratch.txt'), 'x')
  await assert.rejects(s.call('remove_worktree', { worktree: 'feat/rm' }), (err) => err.code === 'GIT_ERROR' && err.details?.reason === 'dirty')
  assert.ok(existsSync(created.path))
  await s.call('load_worktree', { worktree: 'feat/rm' })
  await assert.rejects(s.call('remove_worktree', { worktree: 'feat/rm', force: true }), (err) => err.code === 'IN_USE')
  await s.call('unload_worktree', { worktree: 'feat/rm' })
  await assert.rejects(s.call('remove_worktree', { worktree: 'feat/rm', force: 'yes' }), /force must be a boolean/)
  assert.deepEqual(await s.call('remove_worktree', { worktree: 'feat/rm', force: true }), { removed: true, path: created.path, branch: 'feat/rm' })
  assert.equal(existsSync(created.path), false)
  assert.equal((await s.call('list_worktrees', {})).length, 1)
  assert.match(execFileSync('git', ['-C', s.a, 'branch', '--list', 'feat/rm'], { encoding: 'utf8' }), /feat\/rm/)
  await assert.rejects(s.call('remove_worktree', { worktree: 'main' }), /main worktree cannot be removed/)
})

test('start_session, get_current_session and close_session', async (t) => {
  const s = await toolSetup(t)
  const { terminalId, status } = await s.call('start_session', { worktree: 'main' })
  assert.equal(status, 'idle')
  const current = await s.call('get_current_session', { terminalId })
  assert.equal(current.terminalId, terminalId)
  assert.equal(current.worktree.worktree, s.projects.require(s.projectId).repositories[0].worktrees[0].id)
  assert.deepEqual(await s.call('close_session', { terminalId }), { closed: true })
  await assert.rejects(s.call('get_current_session', { terminalId }), /No session/)
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Long readiness timeouts: only the session's own output and quiet timer can make it ready.
const SLOW_READY = { readyTimeouts: { firstOutputMs: 10_000, settleMs: 10_000 } }

test('send_prompt waits for the agent to be ready, then pastes', async (t) => {
  const s = await toolSetup(t, SLOW_READY)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  const proc = s.spawned.at(-1)
  const pending = s.call('send_prompt', { terminalId, text: 'hello' })
  await delay(20)
  assert.deepEqual(proc.written, [], 'nothing is sent before the first output')
  proc.emit('ready')
  await delay(20)
  assert.deepEqual(proc.written, [], 'nothing is sent while the agent is still working')
  s.fireQuiet()
  assert.deepEqual(await pending, { sent: true })
  assert.equal(proc.written[0], 'hello')
})

test('start_session with a prompt sends it once the agent is ready', async (t) => {
  const s = await toolSetup(t, SLOW_READY)
  const pending = s.call('start_session', { worktree: 'main', prompt: 'do it' })
  await delay(20)
  const proc = s.spawned.at(-1)
  assert.deepEqual(proc.written, [], 'nothing is sent before the first output')
  proc.emit('ready')
  await delay(20)
  assert.deepEqual(proc.written, [], 'nothing is sent while the agent is still working')
  s.fireQuiet()
  const r = await pending
  assert.equal(r.promptSent, true)
  assert.equal(proc.written[0], 'do it')
})

test('start_session: no promptSent without a prompt; an oversized prompt starts nothing', async (t) => {
  const s = await toolSetup(t)
  const plain = await s.call('start_session', { worktree: 'main' })
  assert.equal('promptSent' in plain, false)
  const before = s.spawned.length
  assert.equal(await codeOf(s.call('start_session', { worktree: 'main', prompt: 'x'.repeat(1024 * 1024 + 1) })), 'BAD_REQUEST')
  assert.equal(s.spawned.length, before)
})

test('start_session returns the session id when its prompt cannot be sent', async (t) => {
  const s = await toolSetup(t, SLOW_READY)
  // The session exits before it is ready.
  let pending = s.call('start_session', { worktree: 'main', prompt: 'p' })
  await delay(20)
  s.spawned.at(-1).exit(1)
  let r = await pending
  assert.equal(typeof r.terminalId, 'string')
  assert.equal(r.status, 'exited')
  assert.equal(r.promptSent, false)
  assert.match(r.reason, /exited/)
  // The session is closed before it is ready.
  pending = s.call('start_session', { worktree: 'main', prompt: 'p' })
  await delay(20)
  const id = s.projects.require(s.projectId).repositories[0].worktrees[0].sessions.at(-1).id
  await s.call('close_session', { terminalId: id })
  r = await pending
  assert.deepEqual({ ...r, reason: undefined }, { terminalId: id, status: 'closed', promptSent: false, reason: undefined })
  assert.match(r.reason, /closed/)
  // The client goes away before it is ready.
  const ac = new AbortController()
  pending = s.call('start_session', { worktree: 'main', prompt: 'p' }, ac.signal)
  await delay(20)
  ac.abort()
  r = await pending
  assert.equal(r.promptSent, false)
  assert.match(r.reason, /client disconnected/)
  assert.deepEqual(s.spawned.at(-1).written, [])
})

test('a client that disconnects stops the tool: nothing is sent', async (t) => {
  const s = await toolSetup(t, SLOW_READY)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  const proc = s.spawned.at(-1)
  const gone = new AbortController()
  gone.abort()
  await assert.rejects(s.call('send_prompt', { terminalId, text: 'x' }, gone.signal), /client disconnected/)
  await assert.rejects(s.call('start_session', { worktree: 'main', prompt: 'x' }, gone.signal), /client disconnected/)
  const ac = new AbortController()
  const pending = s.call('send_prompt', { terminalId, text: 'x' }, ac.signal)
  await delay(20)
  ac.abort()
  await assert.rejects(pending, /client disconnected/)
  proc.emit('ready')
  s.fireQuiet()
  await delay(20)
  assert.deepEqual(proc.written, [])
  // wait_for_sessions stops too.
  const wac = new AbortController()
  const waiting = s.call('wait_for_sessions', { terminalIds: [terminalId], timeoutSeconds: 600 }, wac.signal)
  proc.emit('more')
  await delay(20)
  wac.abort()
  await assert.rejects(waiting, /client disconnected/)
})

test('enqueue_prompt and remove_queued_prompt', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  assert.deepEqual(await s.call('enqueue_prompt', { terminalId, text: 'a' }), { queue: ['a'] })
  await s.call('enqueue_prompt', { terminalId, text: 'b' })
  assert.deepEqual(await s.call('remove_queued_prompt', { terminalId, index: 0 }), { removed: 'a', queue: ['b'] })
  await assert.rejects(s.call('remove_queued_prompt', { terminalId, index: 5 }), /index/)
})

test('send_keys maps named keys and counts as input', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  assert.deepEqual(await s.call('send_keys', { terminalId, keys: ['esc', 'y', 'enter'] }), { sent: 3 })
  assert.deepEqual(s.spawned.at(-1).written, ['\x1b', 'y', '\r'])
  // Answering a prompt that rang the bell clears attention, as typing does.
  s.spawned.at(-1).emit('Allow? \x07')
  await s.sessions.terminals.settled(s.projects.require(s.projectId).repositories[0].worktrees[0].sessions[0].ptyId)
  assert.equal((await s.call('get_current_session', { terminalId })).status, 'attention')
  await s.call('send_keys', { terminalId, keys: ['y'] })
  assert.equal((await s.call('get_current_session', { terminalId })).status, 'working')
})

test('read_terminal reads the headless screen', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  s.spawned.at(-1).emit('line one\r\nline two\r\n')
  const r = await s.call('read_terminal', { terminalId, lines: 1 })
  assert.deepEqual(r, { status: 'working', output: 'line two' })
})

test('wait_for_sessions: any, all with a timeout, and closed sessions', async (t) => {
  const s = await toolSetup(t)
  const a = (await s.call('start_session', { worktree: 'main' })).terminalId
  const b = (await s.call('start_session', { worktree: 'main' })).terminalId
  s.spawned[0].emit('x')
  s.spawned[1].emit('x')
  s.fireQuiet() // the first quiet timer belongs to session a: a settles to idle, b stays working
  const any = await s.call('wait_for_sessions', { terminalIds: [a, b], until: 'any', timeoutSeconds: 1 })
  assert.equal(any.timedOut, false)
  const all = await s.call('wait_for_sessions', { terminalIds: [a, b], timeoutSeconds: 0.05 })
  assert.equal(all.timedOut, true)
  assert.deepEqual(all.sessions.map((x) => x.status), ['idle', 'working'])
  // A session that disappears during the wait counts as settled and reports closed.
  s.spawned[0].emit('y') // a is working again: nothing holds yet
  const waiting = s.call('wait_for_sessions', { terminalIds: [b, a], until: 'any', timeoutSeconds: 1 })
  let closing
  setTimeout(() => { closing = s.call('close_session', { terminalId: a }) }, 20)
  const closed = await waiting
  assert.deepEqual(await closing, { closed: true })
  assert.equal(closed.timedOut, false)
  assert.deepEqual(closed.sessions, [{ terminalId: b, status: 'working' }, { terminalId: a, status: 'closed' }])
  // An id that is already gone when the wait starts is an error, as on the desktop.
  await assert.rejects(s.call('wait_for_sessions', { terminalIds: [b, a] }), /No session/)
})

test('tools see only their own project', async (t) => {
  const s = await toolSetup(t)
  const other = s.projects.create('Other', [{ registered: s.registered, name: undefined }])
  const otherCall = s.callerFor(other)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  await assert.rejects(otherCall('get_current_session', { terminalId }), /No session/)
})

const codeOf = (promise) => promise.then(() => 'ok', (e) => e.code)

/** A second real git repo, registered and polled, for multi-repo and cross-project cases. */
async function secondRepo(s, name = 'b') {
  const dir = join(s.dir, 'repos', name)
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: gitEnv })
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-q', '-m', 'init'], { env: gitEnv })
  return { id: name, name, path: dir }
}

test('a second project cannot reach the first project worktrees by id, path or branch', async (t) => {
  const s = await toolSetup(t)
  const created = await s.call('create_worktree', { branch: 'feat/x' })
  const b = await secondRepo(s)
  const other = s.projects.create('Other', [{ registered: b, name: undefined }])
  const otherCall = s.callerFor(other)
  for (const ref of [created.worktree, created.path, 'feat/x']) {
    assert.equal(await codeOf(otherCall('load_worktree', { worktree: ref })), 'NOT_FOUND', ref)
    assert.equal(await codeOf(otherCall('set_worktree_note', { worktree: ref, note: 'x' })), 'NOT_FOUND', ref)
  }
})

test('create_worktree: repo is required, ambiguous or unknown in a multi-repo project', async (t) => {
  const s = await toolSetup(t)
  const b = await secondRepo(s)
  const dup = await secondRepo(s, 'a2')
  const multi = s.projects.create('Multi', [{ registered: s.registered, name: undefined }, { registered: b, name: undefined }, { registered: dup, name: 'b', }])
  const call = s.callerFor(multi)
  assert.equal(await codeOf(call('create_worktree', { branch: 'x' })), 'BAD_REQUEST')
  assert.equal(await codeOf(call('create_worktree', { branch: 'x', repo: 'nope' })), 'NOT_FOUND')
  // Two repositories called "b": the name is ambiguous, an id is not.
  assert.equal(await codeOf(call('create_worktree', { branch: 'x', repo: 'b' })), 'BAD_REQUEST')
})

test('create_worktree with existingBranch checks out a branch that exists', async (t) => {
  const s = await toolSetup(t)
  execFileSync('git', ['-C', s.a, 'branch', 'old'], { env: gitEnv })
  assert.notEqual(await codeOf(s.call('create_worktree', { branch: 'old' })), 'ok')
  const created = await s.call('create_worktree', { branch: 'old', existingBranch: true })
  assert.equal(created.branch, 'old')
  assert.equal(created.repoId, s.projects.require(s.projectId).repositories[0].id)
})

test('tags: clear, custom off, unknown custom, wrong types', async (t) => {
  const s = await toolSetup(t)
  s.projects.apply(s.projectId, (d) => {
    d.settings.worktreeTags = [{ id: 'todo', name: 'Todo', color: '#fff' }]
    d.settings.customTags = [{ id: 'hot', name: 'Hot', color: '#f00' }]
  })
  await s.call('set_worktree_tag', { worktree: 'main', tag: 'todo' })
  assert.deepEqual(await s.call('set_worktree_tag', { worktree: 'main' }), { branch: 'main', tag: null })
  assert.equal(s.projects.require(s.projectId).repositories[0].branchData.main?.tag ?? null, null)
  await s.call('set_worktree_custom_tag', { worktree: 'main', tag: 'hot' })
  assert.deepEqual(await s.call('set_worktree_custom_tag', { worktree: 'main', tag: 'Hot', enabled: false }), { branch: 'main', customTags: [] })
  assert.equal(await codeOf(s.call('set_worktree_custom_tag', { worktree: 'main', tag: 'cold' })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('set_worktree_tag', { worktree: 'main', tag: 5 })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('set_worktree_custom_tag', { worktree: 'main', tag: 'hot', enabled: 'false' })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('set_worktree_note', { worktree: 'main', note: 7 })), 'BAD_REQUEST')
  // Nothing was cleared by the refused calls.
  assert.deepEqual(s.projects.require(s.projectId).repositories[0].branchData.main?.customTags ?? [], [])
})

test('tickets: numbers, Azure DevOps URLs, unrecognised input, wrong types', async (t) => {
  const s = await toolSetup(t)
  const n = await s.call('set_worktree_ticket', { worktree: 'main', ticket: 123 })
  assert.equal(n.ticket, '123')
  assert.equal(s.projects.require(s.projectId).repositories[0].branchData.main.ticket, '123')
  const ado = await s.call('set_worktree_ticket', { worktree: 'main', ticket: 'https://dev.azure.com/o/p/_workitems/edit/42' })
  assert.equal(ado.ticket, '42')
  assert.equal(ado.url, 'https://dev.azure.com/o/p/_workitems/edit/42')
  assert.equal(s.projects.require(s.projectId).settings.azureDevOpsBaseUrl, 'https://dev.azure.com/o/p')
  assert.equal(await codeOf(s.call('set_worktree_ticket', { worktree: 'main', ticket: 'not a ticket' })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('set_worktree_ticket', { worktree: 'main', ticket: { id: 1 } })), 'BAD_REQUEST')
  assert.equal(s.projects.require(s.projectId).repositories[0].branchData.main.ticket, '42')
  assert.deepEqual(await s.call('set_worktree_ticket', { worktree: 'main' }), { branch: 'main', ticket: null })
})

test("tickets go through the project's trackers: one turned off refuses its ids and URLs, naming those on", async (t) => {
  const s = await toolSetup(t)
  const linear = await s.call('set_worktree_ticket', { worktree: 'main', ticket: 'https://linear.app/acme/issue/TOW-5' })
  assert.deepEqual(linear, { branch: 'main', ticket: 'TOW-5', url: 'https://linear.app/acme/issue/TOW-5' })
  assert.equal(s.projects.require(s.projectId).settings.linearWorkspace, 'acme')
  s.projects.apply(s.projectId, (d) => {
    d.settings.plugins = { linear: { enabled: false } }
  })
  const err = await s.call('set_worktree_ticket', { worktree: 'main', ticket: 'TOW-6' }).catch((e) => e)
  assert.equal(err.code, 'BAD_REQUEST')
  assert.match(err.message, /Unrecognised ticket "TOW-6"\. Use an Azure DevOps work item id or URL\./)
  assert.equal(s.projects.require(s.projectId).repositories[0].branchData.main.ticket, 'TOW-5', 'the stored ticket is kept')
  s.projects.apply(s.projectId, (d) => {
    d.settings.plugins = { linear: { enabled: false }, 'azure-devops': { enabled: false } }
  })
  const none = await s.call('set_worktree_ticket', { worktree: 'main', ticket: '12' }).catch((e) => e)
  assert.match(none.message, /No ticket tracker is on in this project/)
})

test('pull requests: #n inferred from another branch PR, none to infer from, wrong types', async (t) => {
  const s = await toolSetup(t)
  await s.call('create_worktree', { branch: 'feat' })
  assert.equal(await codeOf(s.call('set_worktree_pull_request', { worktree: 'feat', pullRequest: '#42' })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('set_worktree_pull_request', { worktree: 'feat', pullRequest: 'nope' })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('set_worktree_pull_request', { worktree: 'feat', pullRequest: true })), 'BAD_REQUEST')
  await s.call('set_worktree_pull_request', { worktree: 'main', pullRequest: 'https://github.com/o/r/pull/9' })
  assert.deepEqual(await s.call('set_worktree_pull_request', { worktree: 'feat', pullRequest: '#42' }), { branch: 'feat', pullRequest: 'https://github.com/o/r/pull/42' })
  assert.deepEqual(await s.call('set_worktree_pull_request', { worktree: 'feat', pullRequest: 43 }), { branch: 'feat', pullRequest: 'https://github.com/o/r/pull/43' })
  assert.deepEqual(await s.call('set_worktree_pull_request', { worktree: 'feat' }), { branch: 'feat', pullRequest: null })
})

test('save_session_type: by id, unknown id, llm null, rename clash, bad arguments', async (t) => {
  const s = await toolSetup(t)
  const one = await s.call('save_session_type', { name: 'One', systemPrompt: 'p', llm: { provider: 'codex' } })
  assert.equal(one.llm.provider, 'codex')
  const two = await s.call('save_session_type', { name: 'Two' })
  const renamed = await s.call('save_session_type', { id: one.id, name: 'Uno', llm: null })
  assert.equal(renamed.name, 'Uno')
  assert.equal(renamed.systemPrompt, 'p')
  assert.equal('llm' in renamed, false)
  assert.equal(await codeOf(s.call('save_session_type', { id: 'nope', name: 'X' })), 'NOT_FOUND')
  assert.equal(await codeOf(s.call('save_session_type', { id: 5, name: 'X' })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('save_session_type', { id: two.id, name: ' uno ' })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('save_session_type', { name: 'x'.repeat(201) })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('save_session_type', { id: two.id, name: 'a\nb' })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('save_session_type', { name: 'Big', systemPrompt: 'x'.repeat(100_001) })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('save_session_type', { name: 'Big', initialMessage: 'x'.repeat(100_001) })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('save_session_type', { name: 'Big', systemPrompt: 5 })), 'BAD_REQUEST')
  assert.deepEqual((await s.call('list_session_types', {})).map((x) => x.name), ['Uno', 'Two'])
})

test('save_session_type caps the number of types', async (t) => {
  const s = await toolSetup(t)
  s.projects.apply(s.projectId, (d) => {
    d.settings.sessionTypes = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, systemPrompt: '' }))
  })
  assert.equal(await codeOf(s.call('save_session_type', { name: 'One more' })), 'BAD_REQUEST')
  assert.equal((await s.call('save_session_type', { id: 't0', name: 'Renamed' })).name, 'Renamed')
})

test('delete_session_type: unknown type is NOT_FOUND, and malformed saved entries do not break the lookup', async (t) => {
  const s = await toolSetup(t)
  assert.equal(await codeOf(s.call('delete_session_type', { sessionType: 'nope' })), 'NOT_FOUND')
  s.projects.apply(s.projectId, (d) => { d.settings.sessionTypes = [{ id: 'z' }, { id: 'k', name: 'Keep', systemPrompt: '' }] })
  assert.equal(await codeOf(s.call('delete_session_type', { sessionType: 'nope' })), 'NOT_FOUND')
  assert.deepEqual(await s.call('list_session_types', {}), [{ id: 'z' }, { id: 'k', name: 'Keep', systemPrompt: '' }])
})

test('request_decision flags the session for every client; typing answers it; bad arguments', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  assert.deepEqual(await s.call('request_decision', { terminalId, question: ' Use Postgres or SQLite? ' }), { notified: true })
  const session = () => s.projects.require(s.projectId).repositories[0].worktrees[0].sessions[0]
  assert.equal(session().decision.question, 'Use Postgres or SQLite?')
  assert.equal((await s.call('get_current_session', { terminalId })).decision, 'Use Postgres or SQLite?')
  assert.equal((await s.call('list_worktrees', {}))[0].sessions[0].decision, 'Use Postgres or SQLite?')
  await s.call('send_keys', { terminalId, keys: ['1', 'enter'] })
  assert.equal(session().decision, undefined)
  assert.equal((await s.call('get_current_session', { terminalId })).decision, null)
  await assert.rejects(s.call('request_decision', { terminalId, question: '  ' }), (e) => e.code === 'BAD_REQUEST' && /question is required/.test(e.message))
  await assert.rejects(s.call('request_decision', { terminalId, question: 7 }), (e) => e.code === 'BAD_REQUEST')
  await assert.rejects(s.call('request_decision', { question: 'q' }), (e) => e.code === 'BAD_REQUEST' && /terminalId/.test(e.message))
  await assert.rejects(s.call('request_decision', { terminalId: 'nope', question: 'q' }), (e) => e.code === 'NOT_FOUND')
  const other = s.callerFor(s.projects.create('Q', [{ registered: s.registered, name: undefined }]))
  await assert.rejects(other('request_decision', { terminalId, question: 'q' }), (e) => e.code === 'NOT_FOUND', 'another project cannot flag it')
})

test('Global sessions: only get_current_session and request_decision reach them', async (t) => {
  const s = await toolSetup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: null, cols: 80, rows: 24 })
  const me = await s.call('get_current_session', { terminalId: sessionId })
  assert.equal(me.terminalId, sessionId)
  assert.equal(me.worktree, null)
  assert.deepEqual(await s.call('request_decision', { terminalId: sessionId, question: 'Which repo?' }), { notified: true })
  assert.equal(s.projects.require(s.projectId).globalSessions[0].decision.question, 'Which repo?')
  const calls = [
    ['send_prompt', { terminalId: sessionId, text: 'x' }],
    ['enqueue_prompt', { terminalId: sessionId, text: 'x' }],
    ['remove_queued_prompt', { terminalId: sessionId, index: 0 }],
    ['send_keys', { terminalId: sessionId, keys: ['y'] }],
    ['read_terminal', { terminalId: sessionId }],
    ['close_session', { terminalId: sessionId }],
    ['rename_session', { terminalId: sessionId, title: 'x' }],
    ['mark_session_complete', { terminalId: sessionId }],
    ['restart_session', { terminalId: sessionId }],
    ['wait_for_sessions', { terminalIds: [sessionId], timeoutSeconds: 0.01 }]
  ]
  for (const [name, args] of calls) {
    await assert.rejects(s.call(name, args), (e) => e.code === 'BAD_REQUEST' && /the Global session can't be targeted by tools/.test(e.message), name)
  }
  assert.deepEqual(s.spawned.at(-1).written, [])
  assert.equal(s.projects.require(s.projectId).globalSessions.length, 1)
})

test('wait_for_sessions: dedupes ids, caps their number, refuses non-strings', async (t) => {
  const s = await toolSetup(t)
  const a = (await s.call('start_session', { worktree: 'main' })).terminalId
  s.spawned.at(-1).emit('x')
  s.fireQuiet()
  const r = await s.call('wait_for_sessions', { terminalIds: [a, a], timeoutSeconds: 1 })
  assert.deepEqual(r.sessions, [{ terminalId: a, status: 'idle' }])
  const many = Array.from({ length: 51 }, (_, i) => `id${i}`)
  await assert.rejects(s.call('wait_for_sessions', { terminalIds: many }), (e) => e.code === 'BAD_REQUEST' && /50/.test(e.message))
  await assert.rejects(s.call('wait_for_sessions', { terminalIds: [a, 5] }), (e) => e.code === 'BAD_REQUEST' && e.message === 'terminalIds must be strings')
})

test('wait_for_sessions: until all succeeds once every session settles', async (t) => {
  const s = await toolSetup(t)
  const a = (await s.call('start_session', { worktree: 'main' })).terminalId
  const b = (await s.call('start_session', { worktree: 'main' })).terminalId
  s.spawned[0].emit('x')
  s.spawned[1].emit('x')
  const waiting = s.call('wait_for_sessions', { terminalIds: [a, b], timeoutSeconds: 5 })
  await delay(20)
  s.fireQuiet()
  s.fireQuiet()
  const r = await waiting
  assert.equal(r.timedOut, false)
  assert.deepEqual(r.sessions.map((x) => x.status), ['idle', 'idle'])
})

test('wait_for_sessions reads one project snapshot per poll', async (t) => {
  let sleeps = 0
  const sleep = (ms) => { sleeps++; return new Promise((resolve) => setTimeout(resolve, ms)) }
  const s = await toolSetup(t, { sleep })
  const ids = []
  for (let i = 0; i < 5; i++) {
    ids.push((await s.call('start_session', { worktree: 'main' })).terminalId)
    s.spawned.at(-1).emit('x') // working
  }
  const require = s.projects.require.bind(s.projects)
  let reads = 0
  s.projects.require = (id) => { reads++; return require(id) }
  sleeps = 0
  const r = await s.call('wait_for_sessions', { terminalIds: ids, timeoutSeconds: 0.1 })
  s.projects.require = require
  assert.equal(r.timedOut, true)
  assert.ok(sleeps > 3, `polled ${sleeps} times`)
  assert.ok(reads <= sleeps + 4, `${reads} snapshots for ${sleeps} polls`)
})

test('at most 16 tool waits run at once per project', async (t) => {
  const s = await toolSetup(t, SLOW_READY)
  const { terminalId } = await s.call('start_session', { worktree: 'main' }) // no output yet: send_prompt waits
  const ac = new AbortController()
  const waits = Array.from({ length: 16 }, () => s.call('send_prompt', { terminalId, text: 'x' }, ac.signal))
  await assert.rejects(s.call('wait_for_sessions', { terminalIds: [terminalId], timeoutSeconds: 1 }), (e) => e.code === 'CAPACITY' && /too many waits in progress/.test(e.message))
  await assert.rejects(s.call('send_prompt', { terminalId, text: 'x' }), (e) => e.code === 'CAPACITY')
  await assert.rejects(s.call('start_session', { worktree: 'main', prompt: 'x' }), (e) => e.code === 'CAPACITY')
  ac.abort()
  for (const w of waits) await assert.rejects(w, /client disconnected/)
  // The slots are free again.
  const r = await s.call('wait_for_sessions', { terminalIds: [terminalId], timeoutSeconds: 0.02 })
  assert.equal(r.timedOut, true)
  assert.deepEqual(s.spawned[0].written, [])
})

test('a restarted complete session is not settled until its first output', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  s.spawned.at(-1).emit('x')
  s.sessions.markComplete({ projectId: s.projectId, sessionId: terminalId, complete: true })
  await s.call('unload_worktree', { worktree: 'main' })
  await s.call('load_worktree', { worktree: 'main' }) // restarts its pty
  assert.equal(s.spawned.length, 2)
  assert.equal((await s.call('get_current_session', { terminalId })).status, 'complete')
  assert.equal(s.sessions.hasOutput(terminalId), false)
  const quiet = await s.call('wait_for_sessions', { terminalIds: [terminalId], timeoutSeconds: 0.05 })
  assert.equal(quiet.timedOut, true)
  const waiting = s.call('wait_for_sessions', { terminalIds: [terminalId], timeoutSeconds: 1 })
  await delay(20)
  s.spawned.at(-1).emit('hello')
  const r = await waiting
  assert.equal(r.timedOut, false)
  assert.deepEqual(r.sessions, [{ terminalId, status: 'complete' }])
})

test('send_prompt, send_keys and read_terminal on stopped sessions; bad arguments', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  assert.equal(await codeOf(s.call('send_prompt', { terminalId, text: '' })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('send_prompt', { terminalId, text: '   ' })), 'BAD_REQUEST')
  await s.call('enqueue_prompt', { terminalId, text: 'a' })
  for (const index of [true, '0', 0.5, null]) {
    assert.equal(await codeOf(s.call('remove_queued_prompt', { terminalId, index })), 'BAD_REQUEST', String(index))
  }
  s.spawned.at(-1).exit(0)
  assert.equal((await s.call('get_current_session', { terminalId })).status, 'exited')
  await assert.rejects(s.call('send_prompt', { terminalId, text: 'x' }), (e) => e.code === 'BAD_REQUEST' && /exited/.test(e.message))
  assert.equal(await codeOf(s.call('send_keys', { terminalId, keys: ['y'] })), 'BAD_REQUEST')
  assert.equal(await codeOf(s.call('read_terminal', { terminalId })), 'BAD_REQUEST')
})

test('read_terminal: a session that stops while the screen settles is not running', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  const proc = s.spawned.at(-1)
  const terminals = s.sessions.terminals
  const settled = terminals.settled
  terminals.settled = async () => { proc.exit(0) }
  t.after(() => { terminals.settled = settled })
  await assert.rejects(s.call('read_terminal', { terminalId }), (e) => e.code === 'BAD_REQUEST' && e.message === 'the session is not running')
})

test('read_terminal clamps lines', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  s.spawned.at(-1).emit('one\r\ntwo\r\nthree\r\n')
  const read = async (lines) => (await s.call('read_terminal', { terminalId, lines })).output
  assert.equal(await read(0), 'one\ntwo\nthree') // 0 is the default, 80
  assert.equal(await read(-1), 'three')
  assert.equal(await read(2.5), 'two\nthree')
  assert.equal(await read(1e9), 'one\ntwo\nthree')
})

test('history: MCP changes record MCP, the session named by terminalId and the reason; get_worktree_history reads them', async (t) => {
  const s = await toolSetup(t)
  s.projects.apply(s.projectId, (d) => { d.settings.worktreeTags = [{ id: 'todo', name: 'Todo', color: '#fff' }] })
  // A saved session in the main checkout, for terminalId to name (no pty needed).
  const terminalId = 'term-1'
  const title = 'Fix login'
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[0].sessions.push({ id: terminalId, title, llm: { provider: 'claude' }, queue: [], status: 'idle' })
  })
  await s.call('set_worktree_tag', { worktree: 'main', tag: 'todo', reason: '  starting work  ', terminalId })
  await s.call('set_worktree_ticket', { worktree: 'main', ticket: '', terminalId: 'not-a-session' })
  await s.call('set_worktree_note', { worktree: 'main', note: 'n' })
  const repoId = s.projects.require(s.projectId).repositories[0].id
  const events = s.history.list(s.projectId, repoId, 'main').events
  assert.deepEqual(events.map((e) => [e.kind, e.actor, e.reason]), [
    ['note', { kind: 'mcp' }, undefined],
    ['status', { kind: 'mcp', terminalId, sessionTitle: title }, 'starting work']
  ])
  await assert.rejects(s.call('set_worktree_note', { worktree: 'main', note: 'm', reason: 'x'.repeat(501) }), /at most 500/)
  await assert.rejects(s.call('set_worktree_note', { worktree: 'main', note: 'm', reason: 5 }), /reason must be a string/)
  const read = await s.call('get_worktree_history', { worktree: 'main', limit: 1 })
  assert.equal(read.branch, 'main')
  assert.equal(read.more, true)
  assert.deepEqual(read.entries.map(({ at, ...rest }) => rest), [{ change: 'Note added', by: 'MCP' }])
  assert.match(read.entries[0].at, /^\d{4}-\d\d-\d\dT/)
})

test('every changing tool takes reason and terminalId', () => {
  for (const name of ['set_worktree_tag', 'set_worktree_custom_tag', 'set_worktree_note', 'set_worktree_ticket', 'set_worktree_pull_request', 'watch_pull_request', 'create_worktree', 'remove_worktree', 'promote_to_primary']) {
    const props = MCP_TOOLS.find((tool) => tool.name === name).inputSchema.properties
    assert.ok(props.reason && props.terminalId, name)
  }
})

test('history: get_worktree_history names the user plainly, not "You"', async (t) => {
  const s = await toolSetup(t)
  const repoId = s.projects.require(s.projectId).repositories[0].id
  recordHistory({ history: s.history }, s.projectId, repoId, 'main', [{ kind: 'note', to: { text: 'hi' } }], BY_USER)
  const read = await s.call('get_worktree_history', { worktree: 'main' })
  assert.deepEqual(read.entries.map((e) => e.by), ['the user'])
})

test('history: create_worktree and remove_worktree record created and removed as MCP; a bad reason changes nothing', async (t) => {
  const s = await toolSetup(t)
  const repoId = s.projects.require(s.projectId).repositories[0].id
  await assert.rejects(s.call('create_worktree', { branch: 'feat/bad', reason: 7 }), /reason must be a string/)
  assert.equal((await s.call('list_worktrees', {})).length, 1)
  assert.equal(s.history.list(s.projectId, repoId, 'feat/bad').events.length, 0)
  const created = await s.call('create_worktree', { branch: 'feat/h', reason: 'for the task' })
  await s.call('remove_worktree', { worktree: 'feat/h', reason: 'done' })
  const events = s.history.list(s.projectId, repoId, 'feat/h').events
  const by = (kind) => events.find((e) => e.kind === kind)
  assert.deepEqual([by('created')?.actor, by('created')?.reason], [{ kind: 'mcp' }, 'for the task'])
  assert.deepEqual([by('removed')?.actor, by('removed')?.reason], [{ kind: 'mcp' }, 'done'])
  assert.ok(created.path)
})

test('history: a bad reason on set_worktree_ticket with a URL writes no settings; a terminalId from another project is ignored', async (t) => {
  const s = await toolSetup(t)
  const before = JSON.stringify(s.projects.require(s.projectId).settings)
  await assert.rejects(s.call('set_worktree_ticket', { worktree: 'main', ticket: 'https://linear.app/ws/issue/TOW-1', reason: 'x'.repeat(501) }), /at most 500/)
  assert.equal(JSON.stringify(s.projects.require(s.projectId).settings), before)
  const other = s.projects.create('Q', [{ registered: s.registered, name: undefined }])
  s.projects.apply(other, (d) => {
    d.repositories[0].worktrees[0].sessions.push({ id: 'foreign', title: 'Foreign', llm: { provider: 'claude' }, queue: [], status: 'idle' })
  })
  await s.call('set_worktree_note', { worktree: 'main', note: 'n', terminalId: 'foreign' })
  const repoId = s.projects.require(s.projectId).repositories[0].id
  assert.deepEqual(s.history.list(s.projectId, repoId, 'main').events[0].actor, { kind: 'mcp' })
})

const MORNING = { name: 'Morning', prompt: 'Check the PRs', cron: '0 9 * * *', timezone: 'America/New_York' }

test('save_automation creates with defaults and list_automations lists it', async (t) => {
  const s = await toolSetup(t)
  assert.deepEqual(await s.call('list_automations', {}), [])
  const created = await s.call('save_automation', { name: 'Morning', prompt: 'Check the PRs', cron: '0 9 * * *' })
  assert.equal(created.name, 'Morning')
  assert.equal(created.cron, '0 9 * * *')
  assert.equal(created.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone)
  assert.equal(created.enabled, true)
  assert.ok(!Number.isNaN(Date.parse(created.nextRun)), 'nextRun is a time')
  assert.deepEqual(created.history, [])
  assert.equal('llm' in created, false)
  assert.equal('runSession' in created, false)
  assert.deepEqual((await s.call('list_automations', {})).map((a) => a.id), [created.id])
  for (const missing of ['name', 'prompt', 'cron']) {
    const args = { ...MORNING }
    delete args[missing]
    await assert.rejects(s.call('save_automation', args), (e) => e.code === 'BAD_REQUEST' && e.message.includes(`${missing} is required to create an automation`), missing)
  }
})

test('save_automation updates by name or id, changing only what is passed', async (t) => {
  const s = await toolSetup(t)
  const created = await s.call('save_automation', { ...MORNING, llm: { provider: 'claude' } })
  const off = await s.call('save_automation', { automation: 'morning', enabled: false })
  assert.equal(off.id, created.id)
  assert.deepEqual([off.name, off.prompt, off.cron, off.timezone, off.enabled, off.llm], ['Morning', 'Check the PRs', '0 9 * * *', 'America/New_York', false, { provider: 'claude' }])
  assert.equal('nextRun' in off, false)
  const moved = await s.call('save_automation', { automation: created.id, cron: '30 8 * * *', llm: null, enabled: true })
  assert.deepEqual([moved.cron, moved.enabled, 'llm' in moved], ['30 8 * * *', true, false])
  assert.equal((await s.call('list_automations', {})).length, 1)
})

test('save_automation refusals: unknown and ambiguous references, a cron under 5 minutes, the 51st', async (t) => {
  const s = await toolSetup(t)
  const one = await s.call('save_automation', MORNING)
  const two = await s.call('save_automation', MORNING)
  assert.notEqual(one.id, two.id, 'without `automation` a save always creates')
  await assert.rejects(s.call('save_automation', { automation: 'Morning', enabled: false }), (e) => e.code === 'BAD_REQUEST' && e.message.includes(one.id) && e.message.includes(two.id))
  await assert.rejects(s.call('save_automation', { automation: 'nope', enabled: false }), (e) => e.code === 'NOT_FOUND' && /Morning/.test(e.message))
  await assert.rejects(s.call('save_automation', { ...MORNING, cron: '* * * * *' }), (e) => e.code === 'BAD_REQUEST' && /every 5 minutes/.test(e.message))
  await assert.rejects(s.call('save_automation', { ...MORNING, timezone: 'Mars/Olympus' }), (e) => e.code === 'BAD_REQUEST' && /IANA timezone/.test(e.message))
  s.projects.apply(s.projectId, (d) => {
    d.automations = Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, prompt: 'p', schedule: { cron: '0 9 * * *', tz: 'UTC' }, enabled: false, createdAt: 0, lastSlot: 0, history: [] }))
  })
  await assert.rejects(s.call('save_automation', MORNING), (e) => e.code === 'CAPACITY')
})

test('delete_automation removes one, by name', async (t) => {
  const s = await toolSetup(t)
  await s.call('save_automation', MORNING)
  assert.deepEqual(await s.call('delete_automation', { automation: 'Morning' }), { deleted: 'Morning' })
  assert.deepEqual(await s.call('list_automations', {}), [])
  await assert.rejects(s.call('delete_automation', { automation: 'Morning' }), (e) => e.code === 'NOT_FOUND')
})

test('run_automation runs it in its run tab and records the run; a busy tab is CONFLICT', async (t) => {
  const s = await toolSetup(t)
  const created = await s.call('save_automation', MORNING)
  const { terminalId } = await s.call('run_automation', { automation: 'Morning' })
  const tab = s.projects.require(s.projectId).globalSessions.find((g) => g.id === terminalId)
  assert.deepEqual(tab.context, { kind: 'automation', automationId: created.id })
  let [listed] = await s.call('list_automations', {})
  assert.equal(listed.runSession.terminalId, terminalId)
  assert.deepEqual(listed.history.map((r) => [r.trigger, r.outcome]), [['manual', 'ran']])
  // The tab's run started a moment ago, so it is still busy.
  await assert.rejects(s.call('run_automation', { automation: created.id }), (e) => e.code === 'CONFLICT')
  ;[listed] = await s.call('list_automations', {})
  assert.deepEqual(listed.history.map((r) => [r.trigger, r.outcome]), [['manual', 'skipped'], ['manual', 'ran']])
  assert.ok(listed.history[0].error, 'the skip says why')
})

test('the automation tools say so on a server without automations', async (t) => {
  const s = await toolSetup(t, { automations: false })
  for (const [name, args] of [['list_automations', {}], ['save_automation', MORNING], ['delete_automation', { automation: 'x' }], ['run_automation', { automation: 'x' }]]) {
    await assert.rejects(s.call(name, args), (e) => e.code === 'TOOL_ERROR' && /this server runs no automations/.test(e.message), name)
  }
})

test("read_terminal and wait_for_sessions take an automation's run tab; tools that act on a session still refuse it", async (t) => {
  const s = await toolSetup(t)
  await s.call('save_automation', MORNING)
  const { terminalId } = await s.call('run_automation', { automation: 'Morning' })
  const read = await s.call('read_terminal', { terminalId })
  assert.equal(typeof read.output, 'string')
  const waited = await s.call('wait_for_sessions', { terminalIds: [terminalId], timeoutSeconds: 0.05 })
  assert.equal(waited.sessions[0].terminalId, terminalId)
  const refused = [
    ['send_prompt', { terminalId, text: 'x' }],
    ['enqueue_prompt', { terminalId, text: 'x' }],
    ['remove_queued_prompt', { terminalId, index: 0 }],
    ['send_keys', { terminalId, keys: ['y'] }],
    ['close_session', { terminalId }]
  ]
  for (const [name, args] of refused) {
    await assert.rejects(s.call(name, args), (e) => e.code === 'BAD_REQUEST' && /the Global session can't be targeted by tools/.test(e.message), name)
  }
})

test('run_automation: CONFLICT while the run tab is working (as when a run calls it on itself); it runs again in the same tab once done', async (t) => {
  let clock = Date.now()
  const s = await toolSetup(t, { automationsNow: () => clock })
  await s.call('save_automation', MORNING)
  const { terminalId } = await s.call('run_automation', { automation: 'Morning' })
  // Past the window in which a tab counts as busy just for having started.
  clock += 60_000
  const setStatus = (status) => s.projects.apply(s.projectId, (d) => { d.globalSessions.find((g) => g.id === terminalId).status = status })
  setStatus('working')
  await assert.rejects(s.call('run_automation', { automation: 'Morning' }), (e) => e.code === 'CONFLICT')
  setStatus('done')
  assert.deepEqual(await s.call('run_automation', { automation: 'Morning' }), { terminalId })
})

test("add_review_comment writes a labelled comment on a line the diff shows; remove_review_comment takes only an agent's", async (t) => {
  const s = await toolSetup(t)
  writeFileSync(join(s.a, 'a.txt'), 'one\ntwo\n')
  const main = () => s.projects.require(s.projectId).repositories[0].worktrees[0]
  const source = { kind: 'uncommitted' }
  const added = await s.call('add_review_comment', { worktree: 'main', file: 'a.txt', line: 2, comment: 'Why two?', source })
  assert.deepEqual(added, {
    worktree: main().id,
    revision: main().review.revision,
    comment: { id: added.comment.id, file: 'a.txt', side: 'new', line: 2, lineText: 'two', comment: 'Why two?', by: 'an agent', agent: true, source, sourceLabel: 'Uncommitted changes', outdated: false }
  })
  assert.deepEqual(main().review.comments[0].by, { kind: 'mcp' })

  // A call that names its session is labelled with the session's title.
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[0].sessions.push({ id: 's1', title: 'Review 2', llm: { provider: 'claude' }, queue: [], status: 'idle' })
  })
  const named = await s.call('add_review_comment', { worktree: 'main', file: 'a.txt', line: 1, comment: 'And one?', source, terminalId: 's1' })
  assert.equal(named.comment.by, 'Review 2')
  assert.equal(named.comment.lineText, 'one')
  assert.deepEqual((await s.call('get_review_comments', { worktree: 'main' })).comments.map((c) => c.by), ['an agent', 'Review 2'])

  const refused = [
    [{ file: 'a.txt', line: 9, comment: 'x', source }, /line 9 of a\.txt is not in Uncommitted changes/],
    [{ file: 'a.txt', line: 1, side: 'old', comment: 'x', source }, /removed line 1 of a\.txt is not in Uncommitted changes/],
    [{ file: 'nope.txt', line: 1, comment: 'x', source }, /nope\.txt has no changes in Uncommitted changes/],
    [{ file: 'a.txt', line: 1, side: 'left', comment: 'x', source }, /side must be "old" or "new"/],
    [{ file: 'a.txt', line: 0, comment: 'x', source }, /line must be a whole number/],
    [{ file: 'a.txt', line: 1, comment: '  ', source }, /comment must not be empty/],
    [{ file: 'a.txt', line: 1, source }, /comment is required/],
    [{ line: 1, comment: 'x', source }, /file is required/],
    [{ file: 'a.txt', line: 1, comment: 'x', source: { kind: 'staged' } }, /source\.kind/]
  ]
  for (const [args, message] of refused) {
    await assert.rejects(s.call('add_review_comment', { worktree: 'main', ...args }), (e) => e.code === 'BAD_REQUEST' && message.test(e.message), JSON.stringify(args))
  }
  assert.equal(main().review.comments.length, 2, 'a refused comment is not added')

  // The user's own comment stays out of an agent's reach.
  s.projects.apply(s.projectId, (d) => {
    const w = d.repositories[0].worktrees[0]
    w.review = { ...w.review, comments: [...w.review.comments, { id: 'mine', source, path: 'a.txt', side: 'new', line: 2, lineText: 'two', body: 'mine', at: 1 }] }
  })
  await assert.rejects(s.call('remove_review_comment', { worktree: 'main', id: 'mine' }), (e) => e.code === 'BAD_REQUEST' && /the user's/.test(e.message))
  assert.deepEqual(await s.call('remove_review_comment', { worktree: 'main', id: added.comment.id }), { worktree: main().id, removed: added.comment.id })
  await assert.rejects(s.call('remove_review_comment', { worktree: 'main', id: added.comment.id }), (e) => e.code === 'NOT_FOUND')
  assert.deepEqual(main().review.comments.map((c) => c.id), [named.comment.id, 'mine'])
})

test('add_review_comment: a removed line (side old), an unknown terminalId and a stray reason', async (t) => {
  const s = await toolSetup(t)
  writeFileSync(join(s.a, 'a.txt'), 'one\ntwo\n')
  execFileSync('git', ['-C', s.a, 'add', '.'], { env: gitEnv })
  execFileSync('git', ['-C', s.a, 'commit', '-q', '-m', 'a'], { env: gitEnv })
  writeFileSync(join(s.a, 'a.txt'), 'one\n')
  const source = { kind: 'uncommitted' }
  const old = await s.call('add_review_comment', { worktree: 'main', file: 'a.txt', line: 2, side: 'old', comment: 'Why drop it?', source, terminalId: 'no-such-session', reason: 7 })
  assert.deepEqual([old.comment.side, old.comment.line, old.comment.lineText, old.comment.by, old.comment.agent], ['old', 2, 'two', 'an agent', true])
})

test('rename_session, mark_session_complete and restart_session', async (t) => {
  const s = await toolSetup(t)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  const session = () => s.projects.require(s.projectId).repositories[0].worktrees[0].sessions.find((x) => x.id === terminalId)

  assert.deepEqual(await s.call('rename_session', { terminalId, title: '  Fix the login  ' }), { terminalId, title: 'Fix the login' })
  assert.equal(session().title, 'Fix the login')
  for (const title of [undefined, '', '   ', 7, 'a\x1bb', 'x'.repeat(5000)]) {
    await assert.rejects(s.call('rename_session', { terminalId, title }), (e) => e.code === 'BAD_REQUEST', JSON.stringify(title))
  }
  assert.equal(session().title, 'Fix the login')
  await assert.rejects(s.call('rename_session', { terminalId: 'nope', title: 'x' }), (e) => e.code === 'NOT_FOUND')

  assert.deepEqual(await s.call('mark_session_complete', { terminalId }), { terminalId, status: 'complete' })
  assert.deepEqual(await s.call('mark_session_complete', { terminalId, complete: false }), { terminalId, status: 'idle' })
  // Clearing a session that is not complete leaves its status alone.
  assert.deepEqual(await s.call('mark_session_complete', { terminalId, complete: false }), { terminalId, status: 'idle' })
  await assert.rejects(s.call('mark_session_complete', { terminalId, complete: 'yes' }), (e) => e.code === 'BAD_REQUEST' && /complete must be a boolean/.test(e.message))

  await assert.rejects(s.call('restart_session', { terminalId }), (e) => e.code === 'BAD_REQUEST' && /the session is running/.test(e.message))
  s.spawned.at(-1).exit(0)
  assert.equal(session().status, 'exited')
  const before = s.spawned.length
  const restarted = await s.call('restart_session', { terminalId })
  assert.equal(restarted.terminalId, terminalId)
  assert.equal(typeof restarted.status, 'string')
  assert.equal(s.spawned.length, before + 1, 'the agent was launched again')
  assert.deepEqual([s.spawned.at(-1).opts.cols, s.spawned.at(-1).opts.rows], [120, 32])
  await assert.rejects(s.call('restart_session', { terminalId }), (e) => e.code === 'BAD_REQUEST' && /the session is running/.test(e.message))
})

test('get_pull_request: the linked pull request now, and its refusals', async (t) => {
  const url = 'https://github.com/o/r/pull/9'
  let available = true
  let answer = { number: 9, state: 'OPEN', mergeable: 'CONFLICTING', headSha: 'abc', checks: 'failing', failed: ['build', 'lint'], commentTimes: ['2026-01-01T00:00:00Z', '2026-01-02T03:04:05Z'] }
  const reads = []
  const prWatch = {
    available: () => available, pollSoon() {}, forget() {}, dismiss() {},
    read: async (pr) => {
      reads.push(pr)
      if (answer instanceof Error) throw answer
      return answer
    }
  }
  const s = await toolSetup(t, { prWatch })
  const refusal = (p) => p.then(() => ['ok', ''], (e) => [e.code, e.message])

  assert.match((await refusal(s.call('get_pull_request', { worktree: 'main' })))[1], /main has no linked pull request/)
  await s.call('set_worktree_pull_request', { worktree: 'main', pullRequest: url })
  assert.deepEqual(await s.call('get_pull_request', { worktree: 'main' }), {
    branch: 'main', pullRequest: url, number: 9, state: 'open', mergeable: 'conflicting', checks: 'failing', failedChecks: ['build', 'lint'],
    headSha: 'abc', comments: 2, lastCommentAt: '2026-01-02T03:04:05Z', watching: false
  })
  assert.deepEqual(reads, [{ url, number: 9, owner: 'o', repo: 'r' }])

  // Watched, with a notice showing, and no comments from others.
  await s.call('watch_pull_request', { worktree: 'main' })
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[0].prNotice = { title: 'PR #9', text: 'Checks failed', url, at: Date.UTC(2026, 0, 3) }
  })
  answer = { number: 9, state: 'MERGED', mergeable: 'UNKNOWN', headSha: 'def', checks: 'passing', failed: [], commentTimes: [] }
  assert.deepEqual(await s.call('get_pull_request', { worktree: 'main' }), {
    branch: 'main', pullRequest: url, number: 9, state: 'merged', mergeable: 'unknown', checks: 'passing', failedChecks: [],
    headSha: 'def', comments: 0, watching: true, lastNotice: { text: 'Checks failed', at: '2026-01-03T00:00:00.000Z' }
  })

  answer = new Error('HTTP 502: bad gateway')
  assert.deepEqual(await refusal(s.call('get_pull_request', { worktree: 'main' })), ['TOOL_ERROR', `Could not read ${url}: HTTP 502: bad gateway`])
  available = false
  const signedOut = await refusal(s.call('get_pull_request', { worktree: 'main' }))
  assert.equal(signedOut[0], 'TOOL_ERROR')
  assert.match(signedOut[1], /gh is not installed or not signed in/)

  // A link that is not a GitHub pull request (as an older client's branch.setPr could store).
  s.projects.apply(s.projectId, (d) => { d.repositories[0].branchData.main = { pr: 'https://example.com/x' } })
  available = true
  const notGitHub = await refusal(s.call('get_pull_request', { worktree: 'main' }))
  assert.equal(notGitHub[0], 'BAD_REQUEST')
  assert.match(notGitHub[1], /is not a GitHub pull request URL/)

  // A server with no watcher at all.
  const bare = await toolSetup(t)
  await bare.call('set_worktree_pull_request', { worktree: 'main', pullRequest: url })
  assert.match((await refusal(bare.call('get_pull_request', { worktree: 'main' })))[1], /gh is not installed or not signed in/)
})

test('get_selected_worktree and focus_session act on the most recently used client', async (t) => {
  const s = await toolSetup(t)
  const topic = `project:${s.projectId}`
  const client = () => {
    const events = []
    const w = { events, send() {}, event: (event, payload) => (events.push([event, payload]), true) }
    s.hub.subscribe(topic, w)
    return w
  }
  const noClient = (e) => e.code === 'BAD_REQUEST' && /No Trek window has this project open/.test(e.message)
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  const main = s.projects.require(s.projectId).repositories[0].worktrees[0]

  await assert.rejects(s.call('get_selected_worktree', {}), noClient)
  await assert.rejects(s.call('focus_session', { terminalId }), noClient)

  const desktop = client()
  s.selections.report(s.projectId, desktop, { worktreeId: main.id, sessionId: terminalId, client: 'desktop' }, true)
  const shown = await s.call('get_selected_worktree', {})
  assert.equal(shown.worktree.worktree, main.id)
  assert.deepEqual([shown.terminalId, shown.client], [terminalId, 'desktop'])
  assert.ok(!Number.isNaN(Date.parse(shown.at)))

  // A phone used after it is the one that counts; ids it reports that no longer exist read as null.
  await new Promise((resolve) => setTimeout(resolve, 2))
  const phone = client()
  s.selections.report(s.projectId, phone, { worktreeId: 'gone', sessionId: 'gone', client: 'phone' }, true)
  assert.deepEqual({ ...(await s.call('get_selected_worktree', {})), at: 0 }, { worktree: null, terminalId: null, client: 'phone', at: 0 })

  assert.deepEqual(await s.call('focus_session', { terminalId }), { focused: true, client: 'phone' })
  assert.deepEqual(phone.events, [['ui.focus', { projectId: s.projectId, worktreeId: main.id, sessionId: terminalId }]])
  assert.deepEqual(desktop.events, [])
  await assert.rejects(s.call('focus_session', { terminalId: 'nope' }), (e) => e.code === 'NOT_FOUND')

  // A Global session can be what a client shows, but cannot be focused by a tool.
  const { sessionId: globalId } = s.sessions.start({ projectId: s.projectId, worktreeId: null, cols: 80, rows: 24 })
  s.selections.report(s.projectId, phone, { worktreeId: null, sessionId: globalId, client: 'phone' }, true)
  assert.deepEqual({ ...(await s.call('get_selected_worktree', {})), at: 0 }, { worktree: null, terminalId: globalId, client: 'phone', at: 0 })
  await assert.rejects(s.call('focus_session', { terminalId: globalId }), (e) => e.code === 'BAD_REQUEST' && /the Global session can't be targeted by tools/.test(e.message))

  // A server without selection tracking.
  const bare = await toolSetup(t, { selections: undefined })
  await assert.rejects(bare.call('get_selected_worktree', {}), (e) => e.code === 'TOOL_ERROR')
})
