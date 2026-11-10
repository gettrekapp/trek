// scripts/serverMcpTools.test.mjs — trek-dev tools on the server: describing and resolving worktrees, then the tools.
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeWorktree, resolveWorktree } from '../server/src/mcp/describe.ts'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
import { TopicHub } from '../server/src/topicHub.ts'

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
  // The tools' poll timers are unref'd (as in the server, where the listener holds the loop): hold it for the test.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const projectId = projects.create('P', [{ registered, name: undefined }])
  await poller.refresh(a)
  const callerFor = createToolCaller({ store, hub, projects, poller, sessions, pollMs: 5, graceMs: 10, readyTimeouts: { firstOutputMs: 200, settleMs: 200 }, ...opts })
  /** Fires the one pending 2.5 s quiet timer of a session's current run. */
  const fireQuiet = () => {
    const job = jobs.find((j) => j.ms === 2500 && !j.cancelled && !j.fired)
    assert.ok(job, 'a quiet timer is pending')
    job.fired = true
    job.fn()
  }
  return { call: callerFor(projectId), callerFor, projects, projectId, sessions, spawned, registered, fireQuiet, a, dir, hub }
}

test('the tool list matches decision 5', () => {
  assert.deepEqual(MCP_TOOLS.map((t) => t.name).sort(), [
    'close_session', 'create_worktree', 'delete_session_type', 'enqueue_prompt', 'get_current_session', 'get_review_comments', 'get_stack',
    'list_session_types', 'list_worktrees', 'load_worktree', 'read_stack_log', 'read_terminal', 'remove_queued_prompt',
    'request_decision', 'save_session_type', 'send_keys', 'send_prompt', 'set_worktree_custom_tag', 'set_worktree_note',
    'set_worktree_pull_request', 'set_worktree_tag', 'set_worktree_ticket', 'speak_summary', 'start_session', 'start_stack', 'stop_stack', 'unload_worktree',
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
  assert.deepEqual(res.comments[0], { id: 'fresh', file: 'a.txt', side: 'new', line: 2, lineText: 'two', comment: 'c fresh', source: { kind: 'uncommitted' }, sourceLabel: 'Uncommitted changes', outdated: false })
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

/** A voice service stub: `hasKey`, and an mp3 that is the text's bytes. */
const voiceStub = (hasKey = true, voiceId = 'v1') => {
  const spoken = []
  return {
    spoken,
    settings: () => ({ hasKey, voiceId, modelId: 'm', promptSessions: false }),
    synthesize: async (text) => {
      spoken.push(text)
      return new TextEncoder().encode(`mp3:${text}`)
    }
  }
}

test('speak_summary sends the clip to every window that has the project open', async (t) => {
  const voice = voiceStub()
  const s = await toolSetup(t, { voice })
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  const topic = `project:${s.projectId}`
  const windows = [[], [], []]
  const subscribers = windows.map((got, i) => ({ send() {}, event: (event, payload) => (i === 2 ? false : (got.push([event, payload]), true)) }))
  // Nobody listening: nothing synthesized.
  assert.deepEqual(await s.call('speak_summary', { terminalId, summary: 'Done.' }), { played: false, reason: 'No Trek window has this project open, so nobody would hear it' })
  assert.deepEqual(voice.spoken, [])
  for (const sub of subscribers) s.hub.subscribe(topic, sub)
  // The third window is congested: it does not count.
  assert.deepEqual(await s.call('speak_summary', { terminalId, summary: '  The tests pass.  ' }), { played: true, windows: 2 })
  const audio = Buffer.from('mp3:The tests pass.').toString('base64')
  for (const got of windows.slice(0, 2)) assert.deepEqual(got, [['voice.summary', { projectId: s.projectId, sessionId: terminalId, text: 'The tests pass.', audio }]])
  await assert.rejects(s.call('speak_summary', { terminalId, summary: 'x'.repeat(401) }), /401 characters/)
  await assert.rejects(s.call('speak_summary', { terminalId, summary: ' ' }), /summary is required/)
  await assert.rejects(s.call('speak_summary', { terminalId: 'nope', summary: 'Hi' }), /No session/)
  assert.deepEqual(voice.spoken, ['The tests pass.'])
})

test('speak_summary with only an MCP call subscribed (no window) synthesizes nothing', async (t) => {
  const voice = voiceStub()
  const s = await toolSetup(t, { voice })
  const { terminalId } = await s.call('start_session', { worktree: 'main' })
  // A subscriber that takes no events, as an MCP tool call's is.
  s.hub.subscribe(`project:${s.projectId}`, { send() {} })
  assert.deepEqual(await s.call('speak_summary', { terminalId, summary: 'Done.' }), { played: false, reason: 'No Trek window has this project open, so nobody would hear it' })
  assert.deepEqual(voice.spoken, [])
})

test('speak_summary without a key, without a chosen voice (or without voice) says it is not set up', async (t) => {
  const stubs = [voiceStub(false), voiceStub(true, ''), undefined]
  for (const voice of stubs) {
    const s = await toolSetup(t, voice ? { voice } : {})
    const { terminalId } = await s.call('start_session', { worktree: 'main' })
    s.hub.subscribe(`project:${s.projectId}`, { send() {}, event: () => true })
    const result = await s.call('speak_summary', { terminalId, summary: 'Hi' })
    assert.equal(result.played, false)
    assert.match(result.reason, /not set up/)
  }
  assert.deepEqual([stubs[0].spoken, stubs[1].spoken], [[], []])
})
