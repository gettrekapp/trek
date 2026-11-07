// scripts/serverSessions.test.mjs — locating sessions, and the SessionManager against a fake pty.
import test from 'node:test'
import assert from 'node:assert/strict'
import { findSession, findWorktree } from '../server/src/sessions/locate.ts'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { SessionManager } from '../server/src/sessions/manager.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'

const s = (id) => ({ id, title: id, llm: { provider: 'claude' }, queue: [], status: 'idle' })
const project = {
  id: 'p', name: 'P', settings: {},
  globalSessions: [s('g1')],
  repositories: [{ id: 'r', name: 'R', path: '/r/a', branchData: {}, worktrees: [
    { id: 'm', name: 'R', path: '/r/a', isMain: true, loaded: false, sessions: [s('s1')] },
    { id: 'w', name: 'x', path: '/r/a-x', isMain: false, loaded: true, sessions: [s('s2')] }
  ] }]
}

test('findSession finds worktree and Global sessions, or answers NOT_FOUND / BAD_REQUEST', () => {
  const a = findSession(project, 's2')
  assert.equal(a.session.id, 's2')
  assert.equal(a.worktree.id, 'w')
  assert.equal(a.repo.id, 'r')
  const g = findSession(project, 'g1')
  assert.equal(g.session.id, 'g1')
  assert.equal(g.worktree, undefined)
  assert.throws(() => findSession(project, 'nope'), (e) => e.code === 'NOT_FOUND')
  assert.throws(() => findSession(project, 3), (e) => e.code === 'BAD_REQUEST')
})

test('findWorktree', () => {
  assert.equal(findWorktree(project, 'w').worktree.path, '/r/a-x')
  assert.throws(() => findWorktree(project, 'nope'), (e) => e.code === 'NOT_FOUND')
})

function fakeSpawner() {
  const spawned = []
  // ignoreHup: kill() without SIGKILL leaves the process running, as an agent that ignores SIGHUP
  const hooks = { calls: 0, failAt: new Set(), onSpawn: undefined, ignoreHup: false }
  const spawner = (opts) => {
    hooks.calls++
    if (hooks.failAt.has(hooks.calls)) throw new Error(`spawn ${hooks.calls} failed`)
    const proc = {
      opts, written: [], killed: false, dataCb: () => {}, exitCb: () => {},
      onData(cb) { this.dataCb = cb }, onExit(cb) { this.exitCb = cb },
      write(d) { this.written.push(d) }, resize() {}, pause() {}, resume() {},
      kill(signal) { this.killed = true; if (!hooks.ignoreHup || signal === 'SIGKILL') setImmediate(() => this.exitCb(129)) },
      emit(d) { this.dataCb(d) }, exit(code) { this.exitCb(code) }
    }
    spawned.push(proc)
    hooks.onSpawn?.(proc)
    return proc
  }
  return { spawned, spawner, hooks }
}

const tick = () => new Promise((r) => setImmediate(r))
/** The agent command a spawn ran (the shell's -c argument). */
const cmd = (proc) => proc.opts.args.at(-1)

function setup(t, { llm, maxSessions, mcpAccess, commandExists } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-sessions-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  const b = join(dir, 'repos', 'b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  mkdirSync(join(dir, 'repos', 'a-x'))
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { repos: [{ id: 'a', name: 'a', path: a }, { id: 'b', name: 'b', path: b }], ...(llm ? { llm } : {}), ...(maxSessions ? { maxSessions } : {}) })
  const store = new ConfigStore(configPath)
  t.after(() => store.close())
  const hub = new TopicHub()
  const saves = []
  let n = 0
  const projects = new ProjectState({
    hub, store: { save: (p) => saves.push(structuredClone(p)), remove: () => {} },
    onSummariesChange: () => {}, newId: () => `id${++n}`
  })
  const fake = fakeSpawner()
  const discoveries = []
  const scheduled = []
  const clock = { t: 1_000_000 }
  const sessions = new SessionManager({
    projects, store, hub, spawner: fake.spawner, now: () => clock.t, mcpAccess, commandExists,
    discover: async (cwd, ageMs, exclude) => {
      discoveries.push({ cwd, ageMs, exclude })
      const next = sessions.__nextDiscovery
      return typeof next === 'function' ? next() : next
    },
    schedule: (fn, ms) => { const job = { fn, ms, cancelled: false }; scheduled.push(job); return { cancel: () => { job.cancelled = true } } }
  })
  t.after(() => sessions.stopAll())
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'a', path: a }, name: undefined }])
  // A linked worktree row as the poller would add it
  projects.apply(projectId, (d) => {
    d.repositories[0].worktrees.push({ id: 'wx', name: 'x', path: join(dir, 'repos', 'a-x'), branch: 'x', isMain: false, loaded: false, sessions: [] })
  })
  const project = () => projects.require(projectId)
  const main = () => project().repositories[0].worktrees[0]
  const wx = () => project().repositories[0].worktrees[1]
  return { dir, a, b, store, hub, projects, sessions, saves, projectId, project, main, wx, ...fake, discoveries, scheduled, clock }
}

const size = { cols: 100, rows: 30 }

test('start: spawns the agent in the worktree, records the session and loads the worktree', (t) => {
  const s = setup(t)
  const savesBefore = s.saves.length
  const { sessionId, ptyId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const session = s.wx().sessions[0]
  assert.equal(session.id, sessionId)
  assert.equal(session.agentSessionId, sessionId)
  assert.equal(session.ptyId, ptyId)
  assert.equal(session.status, 'idle')
  assert.equal(session.title, 'x')
  assert.deepEqual(session.queue, [])
  assert.equal(s.wx().loaded, true)
  assert.ok(s.saves.length > savesBefore, 'a new session is saved')
  const proc = s.spawned[0]
  assert.equal(cmd(proc), `claude --permission-mode auto --session-id ${sessionId}`)
  assert.equal(proc.opts.args[0], '-ilc')
  assert.equal(proc.opts.cwd, s.wx().path)
  assert.deepEqual([proc.opts.cols, proc.opts.rows], [100, 30])
  assert.equal(proc.opts.env.TREK_SESSION_ID, sessionId)
  assert.equal(proc.opts.env.TREK_WORKTREE_ID, 'wx')
  assert.equal(s.sessions.terminals.has(ptyId), true)
})

test('start: titles, session types, LLM resolution and refusals', (t) => {
  const s = setup(t, { llm: { llmDefault: { provider: 'gemini' }, providers: {} } })
  s.projects.apply(s.projectId, (d) => {
    d.settings.sessionTypes = [{ id: 'rev', name: 'Review', systemPrompt: 'Review it', initialMessage: 'go', llm: { provider: 'codex' } }]
  })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.deepEqual(s.wx().sessions.map((x) => x.title), ['x', 'Gemini 2'])
  assert.match(cmd(s.spawned[0]), /^gemini /, 'the server default applies with no project default')

  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', sessionTypeId: 'rev', ...size })
  const typed = s.wx().sessions[2]
  assert.equal(typed.title, 'Review')
  assert.equal(typed.sessionTypeId, 'rev')
  assert.equal(typed.systemPrompt, 'Review it')
  assert.equal(typed.agentSessionId, undefined, 'codex ids are discovered')
  assert.match(cmd(s.spawned[2]), /^codex .*developer_instructions=.*Review it.* -- 'go'$/)

  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', llm: { provider: 'claude', model: 'opus' }, title: ' Mine ', ...size })
  assert.equal(s.wx().sessions[3].title, 'Mine')
  assert.match(cmd(s.spawned[3]), /^claude .*--model 'opus'/)

  const code = (fn) => { try { fn() } catch (e) { return e.code } return 'ok' }
  assert.equal(code(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', sessionTypeId: 'nope', ...size })), 'BAD_REQUEST')
  assert.equal(code(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'nope', ...size })), 'NOT_FOUND')
  assert.equal(code(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', cols: 0, rows: 30 })), 'BAD_REQUEST')
  assert.equal(code(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', llm: 'claude', ...size })), 'BAD_REQUEST')
  s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees[1].missing = true })
  assert.equal(code(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })), 'BAD_REQUEST')
})

test('start: a blocked path is IN_USE', (t) => {
  const s = setup(t)
  const unblock = s.sessions.blockPath(s.wx().path)
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size }), (e) => e.code === 'IN_USE')
  unblock()
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
})

test('Global sessions run in the first repo with the others as addDirs', (t) => {
  const s = setup(t)
  s.projects.apply(s.projectId, (d) => {
    d.repositories.push({ id: 'rb', name: 'b', path: s.b, branchData: {}, worktrees: [{ id: 'mb', name: 'b', path: s.b, isMain: true, loaded: false, sessions: [] }] })
    d.settings.globalSystemPrompt = 'Be global'
  })
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  assert.equal(s.project().globalSessions[0].id, sessionId)
  assert.equal(s.project().globalSessions[0].title, 'Claude')
  const proc = s.spawned[0]
  assert.equal(proc.opts.cwd, s.a)
  assert.match(cmd(proc), /--append-system-prompt 'Be global' --add-dir '.*\/repos\/b'/)
  assert.equal(proc.opts.env.TREK_WORKTREE_ID, undefined)
  s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  assert.equal(s.project().globalSessions[1].title, 'Claude 2')
})

test('exit marks the session exited; restart resumes it; restart while running is refused', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.throws(() => s.sessions.restart({ projectId: s.projectId, sessionId, ...size }), (e) => e.code === 'BAD_REQUEST')
  s.spawned[0].exit(3)
  let session = s.wx().sessions[0]
  assert.equal(session.status, 'exited')
  assert.equal(session.exitCode, 3)
  assert.equal(session.ptyId, undefined)
  const { ptyId } = s.sessions.restart({ projectId: s.projectId, sessionId, cols: 90, rows: 20 })
  session = s.wx().sessions[0]
  assert.equal(session.ptyId, ptyId)
  assert.equal(session.status, 'idle')
  assert.equal(session.exitCode, undefined)
  assert.equal(cmd(s.spawned[1]), `claude --permission-mode auto --resume ${sessionId}`)
})

test('close kills the pty and removes the session', async (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.close({ projectId: s.projectId, sessionId })
  assert.equal(s.spawned[0].killed, true)
  assert.deepEqual(s.wx().sessions, [])
  await tick()
  assert.deepEqual(s.wx().sessions, [], 'the kill does not resurrect it')
})

test('unload kills the ptys and keeps the sessions idle; load resumes them; complete survives', async (t) => {
  const s = setup(t)
  const one = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const two = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.markComplete({ projectId: s.projectId, sessionId: two.sessionId, complete: true })
  s.sessions.unloadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  await tick()
  assert.ok(s.spawned.every((p) => p.killed))
  assert.equal(s.wx().loaded, false)
  assert.deepEqual(s.wx().sessions.map((x) => [x.status, x.ptyId]), [['idle', undefined], ['complete', undefined]])

  s.sessions.loadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  assert.equal(s.wx().loaded, true)
  assert.deepEqual(s.spawned.slice(2).map(cmd), [
    `claude --permission-mode auto --resume ${one.sessionId}`,
    `claude --permission-mode auto --resume ${two.sessionId}`
  ])
  assert.deepEqual([s.spawned[2].opts.cols, s.spawned[2].opts.rows], [120, 32])
  s.sessions.loadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  assert.equal(s.spawned.length, 4, 'loading twice spawns nothing more')
})

test('start on an unloaded worktree resumes its other sessions first', (t) => {
  const s = setup(t)
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[1].sessions.push({ id: 'old', agentSessionId: '22222222-2222-4222-8222-222222222222', title: 'Old', llm: { provider: 'claude' }, queue: [], status: 'idle' })
  })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.match(cmd(s.spawned[0]), /--resume 22222222-2222-4222-8222-222222222222$/)
  assert.match(cmd(s.spawned[1]), /--session-id /)
})

test('restart of a worktree session needs the worktree loaded', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.unloadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  assert.throws(() => s.sessions.restart({ projectId: s.projectId, sessionId, ...size }), (e) => e.code === 'BAD_REQUEST' && /load/.test(e.message))
})

test('Codex ids are discovered and then used to resume', async (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', llm: { provider: 'codex' }, ...size })
  assert.equal(s.scheduled.length, 1)
  assert.equal(s.scheduled[0].ms, 2000)
  s.sessions.__nextDiscovery = undefined
  await s.scheduled[0].fn()
  assert.equal(s.discoveries[0].cwd, s.wx().path)
  assert.equal(s.scheduled.length, 2, 'not found yet: polls again')
  s.sessions.__nextDiscovery = 'cdx-1'
  await s.scheduled[1].fn()
  assert.equal(s.wx().sessions[0].agentSessionId, 'cdx-1')
  assert.equal(s.scheduled.length, 2, 'found: stops polling')
  s.spawned[0].exit(0)
  s.sessions.restart({ projectId: s.projectId, sessionId, ...size })
  assert.match(cmd(s.spawned[1]), /^codex resume 'cdx-1' /)
})

test('stopAll kills every pty and ignores their exits', async (t) => {
  const s = setup(t)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.stopAll()
  await tick()
  assert.equal(s.spawned[0].killed, true)
  assert.notEqual(s.wx().sessions[0].status, 'exited')
})

const codeOf = (fn) => { try { fn() } catch (e) { return e.code } return 'ok' }
const codex = { llm: { provider: 'codex' } }
/** The last job scheduled and not cancelled. */
const live = (s) => s.scheduled.filter((j) => !j.cancelled)

test('Codex discovery in one folder binds the oldest pending session first', async (t) => {
  const s = setup(t)
  const older = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...codex, ...size })
  s.clock.t += 500
  const newer = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...codex, ...size })
  assert.equal(s.scheduled.length, 1, 'one poll loop per folder')
  const ids = ['c1', 'c2']
  s.sessions.__nextDiscovery = () => ids.shift()
  await s.scheduled[0].fn()
  assert.equal(s.discoveries[0].ageMs, 500, 'the scan is for the older session')
  assert.equal(s.scheduled.length, 2, 'the newer one is still pending')
  await s.scheduled[1].fn()
  assert.deepEqual(s.discoveries[1].exclude, ['c1'])
  assert.equal(s.discoveries[1].ageMs, 0, 'then for the newer one')
  const byId = Object.fromEntries(s.wx().sessions.map((x) => [x.id, x.agentSessionId]))
  assert.deepEqual(byId, { [older.sessionId]: 'c1', [newer.sessionId]: 'c2' })
  assert.equal(s.scheduled.length, 2, 'nothing pending: the loop ends')
  assert.equal(s.saves.at(-1).repositories[0].worktrees[1].sessions.find((x) => x.id === newer.sessionId).agentSessionId, 'c2', 'a discovered id is saved')
})

test('Codex discovery: the poll delay follows the claimant age; an id another session took is dropped', async (t) => {
  const s = setup(t)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...codex, ...size })
  assert.equal(s.scheduled[0].ms, 2000)
  s.clock.t += 61_000
  s.sessions.__nextDiscovery = undefined
  await s.scheduled[0].fn()
  assert.equal(s.scheduled[1].ms, 15_000)
  // While the scan runs, another session is bound to the id it will find.
  s.sessions.__nextDiscovery = () => {
    s.projects.apply(s.projectId, (d) => { d.globalSessions.push({ id: 'other', agentSessionId: 'taken', title: 'o', llm: { provider: 'codex' }, queue: [], status: 'idle' }) })
    return 'taken'
  }
  await s.scheduled[1].fn()
  assert.equal(s.wx().sessions[0].agentSessionId, undefined)
  assert.equal(s.scheduled.length, 3, 'still pending: polls again')
})

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

test('Codex discovery: a stale result is not applied after close or restart', async (t) => {
  const s = setup(t)
  const one = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...codex, ...size })
  let d = deferred()
  s.sessions.__nextDiscovery = () => d.promise
  let polling = s.scheduled[0].fn()
  s.spawned[0].exit(1)
  s.sessions.restart({ projectId: s.projectId, sessionId: one.sessionId, ...size })
  const before = s.scheduled.length
  d.resolve('stale')
  await polling
  assert.equal(s.wx().sessions[0].agentSessionId, undefined, 'not applied after a restart')
  assert.equal(s.scheduled.length, before, 'the stale poll schedules nothing')

  d = deferred()
  polling = live(s).at(-1).fn()
  s.sessions.close({ projectId: s.projectId, sessionId: one.sessionId })
  d.resolve('stale2')
  await polling
  assert.equal(s.scheduled.length, before, 'nothing scheduled after close')
})

test('Codex discovery: closing a session cancels its discovery', async (t) => {
  const s = setup(t)
  const one = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...codex, ...size })
  s.sessions.close({ projectId: s.projectId, sessionId: one.sessionId })
  assert.equal(s.scheduled[0].cancelled, true)
  await s.scheduled[0].fn()
  assert.equal(s.discoveries.length, 0)
})

test('Codex discovery stops when the session record disappears without close', async (t) => {
  const s = setup(t)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...codex, ...size })
  s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees[1].sessions = [] })
  await s.scheduled[0].fn()
  assert.equal(s.discoveries.length, 0)
  assert.equal(s.scheduled.length, 1, 'no further polls')
})

test('loadWorktree: a failed spawn marks that session exited and loads the rest', (t) => {
  const s = setup(t)
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[1].sessions = ['a', 'b', 'c'].map((id) => ({ id, agentSessionId: undefined, title: id, llm: { provider: 'claude' }, queue: [], status: 'idle' }))
  })
  s.hooks.failAt.add(2)
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args))
  s.sessions.loadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  assert.equal(s.wx().loaded, true)
  assert.equal(s.spawned.length, 2)
  const [a, b, c] = s.wx().sessions
  assert.ok(a.ptyId && s.sessions.terminals.has(a.ptyId))
  assert.ok(c.ptyId && s.sessions.terminals.has(c.ptyId))
  assert.deepEqual([b.status, b.exitCode, b.ptyId], ['exited', -1, undefined])
  assert.equal(errors.length, 1, 'the failure is logged')
  s.sessions.restart({ projectId: s.projectId, sessionId: 'b', ...size })
  assert.equal(s.wx().sessions[1].status, 'idle')
})

test('forgetProject kills every session of the project, Global ones too, and stops discovery', async (t) => {
  const s = setup(t)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...codex, ...size })
  const other = s.projects.create('Q', [{ registered: { id: 'a', name: 'a', path: s.a }, name: undefined }])
  s.sessions.start({ projectId: other, worktreeId: null, ...size })
  s.sessions.forgetProject(s.projectId)
  assert.deepEqual(s.spawned.map((p) => p.killed), [true, true, true, false])
  assert.equal(s.scheduled[0].cancelled, true)
  s.projects.delete(s.projectId)
  await tick()
  assert.equal(s.projects.require(other).globalSessions[0].status, 'idle')
})

test('forgetRepo kills the sessions of that repository only', async (t) => {
  const s = setup(t)
  s.projects.apply(s.projectId, (d) => {
    d.repositories.push({ id: 'rb', name: 'b', path: s.b, branchData: {}, worktrees: [{ id: 'mb', name: 'b', path: s.b, isMain: true, loaded: true, sessions: [] }] })
  })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'mb', ...codex, ...size })
  s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  s.sessions.forgetRepo(s.projectId, 'rb')
  assert.deepEqual(s.spawned.map((p) => p.killed), [false, true, false])
  assert.equal(s.scheduled[0].cancelled, true)
  await tick()
  assert.equal(s.project().repositories[1].worktrees[0].sessions[0].status, 'idle', 'its exit is not recorded')
})

test('Global sessions: a missing main worktree, a blocked path, an unregistered repo or a denied addDir is refused', (t) => {
  const s = setup(t)
  s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees[0].missing = true })
  assert.equal(codeOf(() => s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })), 'BAD_REQUEST')
  s.projects.apply(s.projectId, (d) => { delete d.repositories[0].worktrees[0].missing })
  const unblock = s.sessions.blockPath(s.a)
  assert.equal(codeOf(() => s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })), 'IN_USE')
  unblock()
  s.projects.apply(s.projectId, (d) => {
    d.repositories.push({ id: 'rz', name: 'z', path: '/elsewhere/z', branchData: {}, worktrees: [{ id: 'mz', name: 'z', path: '/elsewhere/z', isMain: true, loaded: false, sessions: [] }] })
  })
  assert.equal(codeOf(() => s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })), 'PATH_DENIED', 'an addDir outside the allowlist')
  s.projects.apply(s.projectId, (d) => { d.repositories.pop(); d.repositories[0].path = d.repositories[0].worktrees[0].path = join(s.dir, 'repos', 'a-x') })
  assert.equal(codeOf(() => s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })), 'PATH_DENIED', 'a main worktree whose repo is not registered')
  assert.equal(s.spawned.length, 0)
  assert.deepEqual(s.project().globalSessions, [])
})

test('after stopAll, start, restart and load refuse', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.stopAll()
  const shut = (fn) => { try { fn() } catch (e) { return /shutting down/.test(e.message) } return false }
  assert.ok(shut(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })))
  assert.ok(shut(() => s.sessions.restart({ projectId: s.projectId, sessionId, ...size })))
  assert.ok(shut(() => s.sessions.loadWorktree({ projectId: s.projectId, worktreeId: 'm' })))
})

test('a spawn whose record vanished kills the new pty', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].exit(0)
  s.hooks.onSpawn = () => s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees[1].sessions = [] })
  assert.equal(codeOf(() => s.sessions.restart({ projectId: s.projectId, sessionId, ...size })), 'NOT_FOUND')
  assert.equal(s.spawned[1].killed, true)
})

test('start: unknown providers, long titles and control characters are BAD_REQUEST', (t) => {
  const s = setup(t)
  assert.equal(codeOf(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', llm: { provider: 'nope' }, ...size })), 'BAD_REQUEST')
  assert.equal(codeOf(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', title: 'x'.repeat(201), ...size })), 'BAD_REQUEST')
  assert.equal(codeOf(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', title: 'a\u001b[2Jb', ...size })), 'BAD_REQUEST')
  s.projects.apply(s.projectId, (d) => { d.settings.sessionTypes = [{ id: 'bad', name: 'Bad\nname' }] })
  assert.equal(codeOf(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', sessionTypeId: 'bad', ...size })), 'BAD_REQUEST')
  assert.equal(s.spawned.length, 0)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', title: 'x'.repeat(200), ...size })
  assert.equal(s.wx().sessions[0].title.length, 200)
})

test('rename trims, guards with expected, and refuses an empty title', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.rename({ projectId: s.projectId, sessionId, title: '  New  ' })
  assert.equal(s.wx().sessions[0].title, 'New')
  assert.throws(() => s.sessions.rename({ projectId: s.projectId, sessionId, title: 'X', expected: 'Old' }), (e) => e.code === 'CONFLICT')
  assert.throws(() => s.sessions.rename({ projectId: s.projectId, sessionId, title: '   ' }), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => s.sessions.rename({ projectId: s.projectId, sessionId, title: 'x'.repeat(201) }), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => s.sessions.rename({ projectId: s.projectId, sessionId, title: 'a\u0007b' }), (e) => e.code === 'BAD_REQUEST')
  assert.equal(s.wx().sessions[0].title, 'New')
})

test('enqueue appends, setQueue replaces; both are saved', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const before = s.saves.length
  s.sessions.enqueue({ projectId: s.projectId, sessionId, text: 'one' })
  s.sessions.enqueue({ projectId: s.projectId, sessionId, text: 'two' })
  assert.deepEqual(s.wx().sessions[0].queue, ['one', 'two'])
  s.sessions.setQueue({ projectId: s.projectId, sessionId, queue: ['two'] })
  assert.deepEqual(s.wx().sessions[0].queue, ['two'])
  assert.equal(s.saves.length, before + 3)
  assert.throws(() => s.sessions.enqueue({ projectId: s.projectId, sessionId, text: '' }), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => s.sessions.setQueue({ projectId: s.projectId, sessionId, queue: ['ok', 3] }), (e) => e.code === 'BAD_REQUEST')
})

test('dequeue removes one prompt, guarded by expected; it is saved', async (t) => {
  const s = setup(t)
  const { call } = v2(s)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const ref = { projectId: s.projectId, sessionId }
  s.sessions.setQueue({ ...ref, queue: ['a', 'b', 'c'] })
  const queue = () => s.wx().sessions[0].queue
  const before = s.saves.length
  assert.deepEqual(await call('session.dequeue', { ...ref, index: 1, expected: 'b' }), { ok: true, result: null })
  assert.deepEqual(queue(), ['a', 'c'])
  assert.equal(s.saves.length, before + 1)
  // Another client sent 'a' meanwhile: index 0 is now 'c'.
  s.sessions.setQueue({ ...ref, queue: ['c'] })
  const stale = await call('session.dequeue', { ...ref, index: 0, expected: 'a' })
  assert.deepEqual([stale.error.code, stale.error.message], ['CONFLICT', 'queue[0] changed since you read it'])
  assert.equal((await call('session.dequeue', { ...ref, index: 3, expected: 'c' })).error.code, 'CONFLICT', 'the queue no longer reaches the index')
  assert.equal((await call('session.dequeue', { ...ref, index: 3 })).error.code, 'BAD_REQUEST')
  for (const index of [-1, 0.5, '0', undefined]) {
    assert.equal((await call('session.dequeue', { ...ref, index })).error.code, 'BAD_REQUEST', String(index))
  }
  assert.equal((await call('session.dequeue', { ...ref, index: 0, expected: 3 })).error.code, 'BAD_REQUEST')
  assert.deepEqual(queue(), ['c'])
  await call('session.dequeue', { ...ref, index: 0 })
  assert.deepEqual(queue(), [])
  assert.equal((await call('session.dequeue', { ...ref, index: 0 })).error.message, 'the queue is empty')
})

test('sendPrompt pastes with CRs, bracketed when the agent asked for it, then presses enter', async (t) => {
  const s = setup(t)
  const { sessionId, ptyId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const proc = s.spawned[0]
  await s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: 'a\nb' })
  assert.deepEqual(proc.written, ['a\rb'])
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(proc.written, ['a\rb', '\r'])
  proc.emit('\x1b[?2004h')
  await s.sessions.terminals.settled(ptyId)
  await s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: 'c' })
  assert.equal(proc.written[2], '\x1b[200~c\x1b[201~')
  proc.exit(0)
  await assert.rejects(Promise.resolve().then(() => s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: 'd' })), (e) => e.code === 'BAD_REQUEST')
})

test('seen clears attention and done; markComplete false resumes tracking', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  for (const status of ['attention', 'done']) {
    s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees[1].sessions[0].status = status })
    s.sessions.seen({ projectId: s.projectId, sessionId })
    assert.equal(s.wx().sessions[0].status, 'idle')
  }
  s.sessions.markComplete({ projectId: s.projectId, sessionId, complete: true })
  s.sessions.seen({ projectId: s.projectId, sessionId })
  assert.equal(s.wx().sessions[0].status, 'complete', 'seen leaves complete alone')
  s.sessions.markComplete({ projectId: s.projectId, sessionId, complete: false })
  assert.equal(s.wx().sessions[0].status, 'idle')
  assert.throws(() => s.sessions.markComplete({ projectId: s.projectId, sessionId, complete: 'yes' }), (e) => e.code === 'BAD_REQUEST')
})

function v2(s) {
  const events = []
  const terminal = { send: (event, payload) => events.push({ event, ...payload }), bufferedAmount: () => 0 }
  const call = (method, params) =>
    dispatchV2(method, params, { store: s.store, hub: s.hub, subscriber: undefined, projects: s.projects, poller: undefined, sessions: s.sessions, terminal })
  return { events, terminal, call }
}

test('v2: session.start, pty.attach/write/resize/detach, session.close', async (t) => {
  const s = setup(t)
  const { call, events } = v2(s)
  const started = await call('session.start', { projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.equal(started.ok, true, JSON.stringify(started))
  const { sessionId, ptyId } = started.result
  s.spawned[0].emit('hello')
  const attached = await call('pty.attach', { ptyId })
  assert.equal(attached.result.seq, 5)
  assert.deepEqual(events[0], { event: 'pty.data', ptyId, seq: 0, data: 'hello', replay: true })
  assert.deepEqual(await call('pty.write', { ptyId, data: 'x' }), { ok: true, result: null })
  assert.deepEqual(s.spawned[0].written, ['x'])
  assert.equal((await call('pty.resize', { ptyId, cols: 0, rows: 1 })).error.code, 'BAD_REQUEST')
  assert.deepEqual(await call('pty.detach', { ptyId }), { ok: true, result: null })
  assert.equal((await call('pty.attach', { ptyId: 'nope' })).error.code, 'PTY_NOT_FOUND')
  assert.equal((await call('pty.write', { ptyId, data: 3 })).error.code, 'BAD_REQUEST')
  assert.deepEqual(await call('session.close', { projectId: s.projectId, sessionId }), { ok: true, result: null })
})

test('v2: worktree.load / unload, and the other session methods are wired', async (t) => {
  const s = setup(t)
  const { call } = v2(s)
  const { sessionId } = (await call('session.start', { projectId: s.projectId, worktreeId: 'wx', ...size })).result
  for (const [method, params] of [
    ['worktree.unload', { worktreeId: 'wx' }],
    ['worktree.load', { worktreeId: 'wx' }],
    ['session.rename', { sessionId, title: 'R' }],
    ['session.enqueue', { sessionId, text: 'q' }],
    ['session.setQueue', { sessionId, queue: [] }],
    ['session.markComplete', { sessionId, complete: true }],
    ['session.seen', { sessionId }],
    ['session.sendPrompt', { sessionId, text: 'hi' }]
  ]) {
    const res = await call(method, { projectId: s.projectId, ...params })
    assert.equal(res.ok, true, `${method}: ${JSON.stringify(res)}`)
  }
  s.spawned.at(-1).exit(1)
  const restarted = await call('session.restart', { projectId: s.projectId, sessionId, ...size })
  assert.equal(restarted.ok, true, JSON.stringify(restarted))
  assert.ok(restarted.result.ptyId)
})

test('Codex discovery: a poll whose result handling throws still schedules the next poll', async (t) => {
  const s = setup(t)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...codex, ...size })
  const all = s.projects.all.bind(s.projects)
  let throwNext = false
  t.mock.method(s.projects, 'all', () => {
    if (throwNext) { throwNext = false; throw new Error('boom') }
    return all()
  })
  const warnings = []
  t.mock.method(console, 'warn', (...args) => warnings.push(args))
  s.sessions.__nextDiscovery = () => { throwNext = true; return 'cdx-x' }
  await s.scheduled[0].fn()
  assert.equal(s.scheduled.length, 2, 'the next poll is scheduled')
  assert.ok(warnings.length >= 1, 'the failure is logged')
  s.sessions.__nextDiscovery = 'cdx-y'
  await s.scheduled[1].fn()
  assert.equal(s.wx().sessions[0].agentSessionId, 'cdx-y')
})

test('blockPath is ref-counted, and each unblock works once', (t) => {
  const s = setup(t)
  const start = () => codeOf(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size }))
  const one = s.sessions.blockPath(s.wx().path)
  const two = s.sessions.blockPath(s.wx().path)
  one()
  one()
  assert.equal(start(), 'IN_USE', 'still blocked by the second')
  two()
  assert.equal(start(), 'ok')
  two()
  const three = s.sessions.blockPath(s.wx().path)
  assert.equal(start(), 'IN_USE', 'an extra unblock does not cancel a later block')
  three()
})

test('main-worktree sessions need the repo registered', (t) => {
  const s = setup(t)
  s.projects.apply(s.projectId, (d) => { d.repositories[0].path = d.repositories[0].worktrees[0].path = join(s.dir, 'repos', 'a-x') })
  assert.equal(codeOf(() => s.sessions.start({ projectId: s.projectId, worktreeId: s.main().id, ...size })), 'PATH_DENIED')
  assert.equal(s.spawned.length, 0)
})

/** A project with repositories a (first, with worktree wx) and b. */
function twoRepos(t) {
  const s = setup(t)
  s.projects.apply(s.projectId, (d) => {
    d.repositories.push({ id: 'rb', name: 'b', path: s.b, branchData: {}, worktrees: [{ id: 'mb', name: 'b', path: s.b, isMain: true, loaded: false, sessions: [] }] })
  })
  return s
}

test('repo.remove of the first repository ends the Global sessions; they restart in the new first one', async (t) => {
  const s = twoRepos(t)
  const { call } = v2(s)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const g = s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  s.sessions.start({ projectId: s.projectId, worktreeId: null, ...codex, ...size })
  assert.match(cmd(s.spawned[1]), /--add-dir/)
  const res = await call('repo.remove', { projectId: s.projectId, repoId: s.project().repositories[0].id })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(s.spawned.map((p) => p.killed), [true, true, true])
  assert.equal(live(s).length, 0, 'Global discovery stopped')
  await tick()
  const [kept] = s.project().globalSessions
  assert.equal(kept.id, g.sessionId, 'the record is kept')
  assert.equal(kept.ptyId, undefined)
  assert.equal(kept.status, 'idle')
  assert.equal(s.project().globalSessions.length, 2)
  s.sessions.restart({ projectId: s.projectId, sessionId: g.sessionId, ...size })
  assert.equal(s.spawned[3].opts.cwd, s.b)
  assert.doesNotMatch(cmd(s.spawned[3]), /--add-dir/)
})

test('repo.remove of an additional directory ends the Global sessions too, and only them', async (t) => {
  const s = twoRepos(t)
  const { call } = v2(s)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const g = s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  const other = s.projects.create('Q', [{ registered: { id: 'a', name: 'a', path: s.a }, name: undefined }])
  s.sessions.start({ projectId: other, worktreeId: null, ...size })
  const res = await call('repo.remove', { projectId: s.projectId, repoId: 'rb' })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.deepEqual(s.spawned.map((p) => p.killed), [false, true, false])
  await tick()
  assert.equal(s.project().globalSessions[0].status, 'idle')
  s.sessions.restart({ projectId: s.projectId, sessionId: g.sessionId, ...size })
  assert.equal(s.spawned[3].opts.cwd, s.a)
  assert.doesNotMatch(cmd(s.spawned[3]), /--add-dir/)
  assert.equal((await call('repo.remove', { projectId: s.projectId, repoId: s.project().repositories[0].id })).error.code, 'BAD_REQUEST')
  assert.equal(s.spawned[3].killed, false, 'a refused remove ends nothing')
})

test('v2: pty.write refuses data over 1 MiB', async (t) => {
  const s = setup(t)
  const { call } = v2(s)
  const { ptyId } = (await call('session.start', { projectId: s.projectId, worktreeId: 'wx', ...size })).result
  await call('pty.attach', { ptyId })
  assert.equal((await call('pty.write', { ptyId, data: 'x'.repeat(1024 * 1024 + 1) })).error.code, 'BAD_REQUEST')
  assert.equal(s.spawned[0].written.length, 0)
  assert.equal((await call('pty.write', { ptyId, data: 'x'.repeat(1024 * 1024) })).ok, true)
})

// ---- live status and the attention topic ----

/** The quiet-timer jobs (2500 ms) still pending (neither cancelled nor fired), newest last. */
const quietJobs = (s) => s.scheduled.filter((j) => j.ms === 2500 && !j.cancelled && !j.fired)
/** Fires the one pending quiet timer, as its setTimeout would. */
const fireQuiet = (s) => {
  const jobs = quietJobs(s)
  assert.equal(jobs.length, 1, 'one quiet timer is pending')
  jobs[0].fired = true
  jobs[0].fn()
}
const statusOf = (s) => s.wx().sessions[0].status
const attention = (s) => s.hub.subscribe('attention', { send() {} }).snapshot.entries

test('output → working; quiet → done after a marker, idle after a repaint', (t) => {
  const s = setup(t)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const proc = s.spawned[0]
  proc.emit('Thinking… (esc to interrupt)')
  assert.equal(statusOf(s), 'working')
  proc.emit('more')
  assert.equal(quietJobs(s).length, 1, 'each chunk restarts the one quiet timer')
  fireQuiet(s)
  assert.equal(statusOf(s), 'done')
  assert.equal(attention(s)[0].status, 'done')
  proc.emit('repaint')
  assert.equal(statusOf(s), 'working')
  assert.deepEqual(attention(s), [])
  fireQuiet(s)
  assert.equal(statusOf(s), 'idle')
})

test('a bell sets attention and lists it; real input clears it, a terminal reply does not', async (t) => {
  const s = setup(t)
  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].emit('\x07')
  await s.sessions.terminals.settled(ptyId)
  assert.equal(statusOf(s), 'attention')
  assert.deepEqual(attention(s).map((e) => [e.sessionId, e.worktreeId, e.status]), [[sessionId, 'wx', 'attention']])
  s.sessions.noteInput(ptyId, '\x1b[12;1R')
  assert.equal(statusOf(s), 'attention')
  s.sessions.noteInput(ptyId, 'y')
  assert.equal(statusOf(s), 'working')
  assert.deepEqual(attention(s), [])
})

test('complete ignores output and bells; typing re-engages tracking', async (t) => {
  const s = setup(t)
  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.markComplete({ projectId: s.projectId, sessionId, complete: true })
  s.spawned[0].emit('esc to interrupt\x07')
  await s.sessions.terminals.settled(ptyId)
  assert.equal(statusOf(s), 'complete')
  s.sessions.noteInput(ptyId, 'x')
  assert.equal(statusOf(s), 'working')
})

test('input that leaves attention or complete for working arms the quiet timer', async (t) => {
  const s = setup(t)
  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].emit('\x07')
  await s.sessions.terminals.settled(ptyId)
  fireQuiet(s)
  assert.equal(statusOf(s), 'attention')
  s.sessions.noteInput(ptyId, 'y')
  assert.equal(statusOf(s), 'working')
  fireQuiet(s)
  assert.equal(statusOf(s), 'idle', 'no output after the input: the session settles')
  // complete → working through sendPrompt arms it too
  s.sessions.markComplete({ projectId: s.projectId, sessionId, complete: true })
  await s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: 'go' })
  assert.equal(statusOf(s), 'working')
  fireQuiet(s)
  assert.equal(statusOf(s), 'idle')
})

test('after stopAll, output, bells and input schedule nothing and publish nothing', async (t) => {
  const s = setup(t)
  s.hooks.ignoreHup = true
  const { ptyId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.stopAll()
  const scheduled = s.scheduled.length
  const publish = t.mock.method(s.hub, 'publish')
  s.spawned[0].emit('esc to interrupt\x07')
  await s.sessions.terminals.settled(ptyId)
  s.sessions.noteInput(ptyId, 'y')
  assert.equal(s.scheduled.length, scheduled)
  assert.equal(publish.mock.callCount(), 0)
  assert.equal(statusOf(s), 'idle')
  s.spawned[0].exit(137)
})

test('status changes are not saved; seen and rename update the attention topic', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const saves = s.saves.length
  s.spawned[0].emit('esc to interrupt')
  fireQuiet(s)
  assert.equal(s.saves.length, saves, 'working/done are runtime-only')
  s.sessions.rename({ projectId: s.projectId, sessionId, title: 'Renamed' })
  assert.equal(attention(s)[0].title, 'Renamed')
  s.sessions.seen({ projectId: s.projectId, sessionId })
  assert.deepEqual(attention(s), [])
})

test('project.rename and project.updateSettings republish the attention topic with the name and audioAlerts', async (t) => {
  const s = setup(t)
  const { call } = v2(s)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].emit('esc to interrupt')
  fireQuiet(s)
  const before = attention(s)[0]
  assert.equal(before.audioAlerts, undefined)
  assert.equal((await call('project.rename', { projectId: s.projectId, name: 'Renamed project' })).ok, true)
  assert.equal(attention(s)[0].projectName, 'Renamed project')
  assert.equal((await call('project.updateSettings', { projectId: s.projectId, settings: { audioAlerts: true } })).ok, true)
  assert.equal(attention(s)[0].audioAlerts, true)
  assert.equal((await call('project.updateSettings', { projectId: s.projectId, settings: { audioAlerts: null } })).ok, true)
  assert.equal(Object.hasOwn(attention(s)[0], 'audioAlerts'), false)
  assert.equal(attention(s)[0].since, before.since, 'a relabel keeps since')
})

test('exit, close and unload cancel the quiet timer and drop attention entries', async (t) => {
  const s = setup(t)
  const one = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].emit('esc to interrupt')
  fireQuiet(s)
  assert.equal(attention(s).length, 1)
  s.spawned[0].emit('x')
  s.spawned[0].exit(0)
  assert.equal(quietJobs(s).length, 0)
  assert.equal(statusOf(s), 'exited')
  assert.deepEqual(attention(s), [])
  s.sessions.restart({ projectId: s.projectId, sessionId: one.sessionId, ...size })
  s.spawned[1].emit('esc to interrupt')
  s.sessions.unloadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  assert.equal(quietJobs(s).length, 0)
})

test('sendPrompt counts as input', async (t) => {
  const s = setup(t)
  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].emit('\x07')
  await s.sessions.terminals.settled(ptyId)
  await s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: 'go' })
  assert.equal(statusOf(s), 'working')
})

test('pty.write notes input through the v2 handler', async (t) => {
  const s = setup(t)
  const { call } = v2(s)
  const { ptyId } = (await call('session.start', { projectId: s.projectId, worktreeId: 'wx', ...size })).result
  s.spawned[0].emit('\x07')
  await s.sessions.terminals.settled(ptyId)
  await call('pty.attach', { ptyId })
  await call('pty.write', { ptyId, data: 'n' })
  assert.equal(statusOf(s), 'working')
})

test('close and project.delete drop attention entries and cancel the quiet timer', async (t) => {
  const s = setup(t)
  const { call } = v2(s)
  const one = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].emit('esc to interrupt')
  fireQuiet(s)
  assert.equal(attention(s).length, 1)
  s.spawned[0].emit('x')
  s.sessions.close({ projectId: s.projectId, sessionId: one.sessionId })
  assert.equal(quietJobs(s).length, 0)
  assert.deepEqual(attention(s), [])
  const two = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[1].emit('\x07')
  await s.sessions.terminals.settled(two.ptyId)
  assert.equal(attention(s).length, 1)
  assert.equal((await call('project.delete', { projectId: s.projectId })).ok, true)
  assert.equal(quietJobs(s).length, 0)
  assert.deepEqual(attention(s), [])
})

// ---- limits ----

test('maxSessions caps running sessions; load marks the rest exited -1', async (t) => {
  const s = setup(t, { maxSessions: 2 })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const second = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size }), (e) => e.code === 'CAPACITY' && /maximum of 2/.test(e.message))
  assert.equal(s.wx().sessions.length, 2, 'a refused start leaves no record')
  // An exit frees a slot
  s.spawned[1].exit(0)
  s.sessions.restart({ projectId: s.projectId, sessionId: second.sessionId, ...size })
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size }), (e) => e.code === 'CAPACITY')
  // Unload frees both; loading three dormant sessions with a cap of 2 runs two
  s.sessions.unloadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  await new Promise((r) => setImmediate(r))
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[1].sessions.push({ id: 'third', agentSessionId: '33333333-3333-4333-8333-333333333333', title: 'T', llm: { provider: 'claude' }, queue: [], status: 'idle' })
  })
  s.sessions.loadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  const states = s.wx().sessions.map((x) => [x.status, x.exitCode])
  assert.deepEqual(states, [['idle', undefined], ['idle', undefined], ['exited', -1]])
})

test('maxSessions counts a closed session whose process has not exited yet', async (t) => {
  const s = setup(t, { maxSessions: 2 })
  s.hooks.ignoreHup = true
  const one = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.close({ projectId: s.projectId, sessionId: one.sessionId })
  await tick()
  assert.equal(s.spawned[0].killed, true)
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size }), (e) => e.code === 'CAPACITY' && /maximum of 2/.test(e.message))
  // The dying process ends (SIGKILL, or it gives in): its slot is free.
  s.spawned[0].exit(137)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.equal(s.wx().sessions.length, 2)
})

test('at the cap, start on an unloaded worktree refuses before loading it', (t) => {
  const s = setup(t, { maxSessions: 2 })
  s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[1].sessions.push({ id: 'dormant', agentSessionId: '33333333-3333-4333-8333-333333333333', title: 'D', llm: { provider: 'claude' }, queue: [], status: 'idle' })
  })
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size }), (e) => e.code === 'CAPACITY' && /maximum of 2/.test(e.message))
  assert.equal(s.wx().loaded, false, 'the worktree is not loaded')
  assert.deepEqual(s.wx().sessions.map((x) => [x.id, x.status, x.exitCode]), [['dormant', 'idle', undefined]])
})

test('prompt and queue limits', async (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const big = 'x'.repeat(1024 * 1024 + 1)
  await assert.rejects(s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: big }), (e) => e.code === 'BAD_REQUEST')
  assert.equal(s.spawned[0].written.length, 0)
  assert.throws(() => s.sessions.enqueue({ projectId: s.projectId, sessionId, text: 'q'.repeat(100_001) }), (e) => e.code === 'BAD_REQUEST')
  s.sessions.enqueue({ projectId: s.projectId, sessionId, text: 'q'.repeat(100_000) })
  assert.throws(() => s.sessions.setQueue({ projectId: s.projectId, sessionId, queue: Array(101).fill('q') }), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => s.sessions.setQueue({ projectId: s.projectId, sessionId, queue: ['q'.repeat(100_001)] }), (e) => e.code === 'BAD_REQUEST')
  s.sessions.setQueue({ projectId: s.projectId, sessionId, queue: Array(100).fill('q') })
  assert.throws(() => s.sessions.enqueue({ projectId: s.projectId, sessionId, text: 'one more' }), (e) => e.code === 'BAD_REQUEST')
  assert.equal(s.wx().sessions[0].queue.length, 100)
})

test('pty.write and pty.resize need the connection to be attached', async (t) => {
  const s = setup(t)
  const { call } = v2(s)
  const { ptyId } = (await call('session.start', { projectId: s.projectId, worktreeId: 'wx', ...size })).result
  assert.equal((await call('pty.write', { ptyId, data: 'x' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('pty.resize', { ptyId, cols: 90, rows: 20 })).error.code, 'BAD_REQUEST')
  assert.equal(s.spawned[0].written.length, 0)
  await call('pty.attach', { ptyId })
  assert.equal((await call('pty.write', { ptyId, data: 'x' })).ok, true)
  assert.equal((await call('pty.resize', { ptyId, cols: 90, rows: 20 })).ok, true)
  await call('pty.detach', { ptyId })
  assert.equal((await call('pty.write', { ptyId, data: 'x' })).error.code, 'BAD_REQUEST', 'detach ends write access')
})

// ---- status review extras ----

test('sendPrompt counts as input whatever its bytes are', async (t) => {
  const s = setup(t)
  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].emit('\x07')
  await s.sessions.terminals.settled(ptyId)
  assert.equal(statusOf(s), 'attention')
  // These bytes look like a cursor report, which pty.write would not count as input.
  await s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: '\x1b[12;1R' })
  assert.equal(statusOf(s), 'working')
})

test('a Global session in attention is listed with worktreeId null', async (t) => {
  const s = setup(t)
  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  s.spawned[0].emit('\x07')
  await s.sessions.terminals.settled(ptyId)
  assert.deepEqual(attention(s).map((e) => [e.sessionId, e.worktreeId, e.status]), [[sessionId, null, 'attention']])
})

test('attention entries are oldest first with their since; markComplete drops one', async (t) => {
  const s = setup(t)
  const first = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const second = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  // The later session in the list enters first, so the order is by since, not by position.
  const t0 = s.clock.t
  s.spawned[1].emit('esc to interrupt')
  fireQuiet(s)
  s.clock.t += 5000
  s.spawned[0].emit('\x07')
  await s.sessions.terminals.settled(first.ptyId)
  assert.deepEqual(
    attention(s).map((e) => [e.sessionId, e.status, e.since]),
    [[second.sessionId, 'done', t0], [first.sessionId, 'attention', t0 + 5000]]
  )
  s.sessions.markComplete({ projectId: s.projectId, sessionId: first.sessionId, complete: true })
  assert.deepEqual(attention(s).map((e) => e.sessionId), [second.sessionId])
})

// ---- decisions ----

const decisionOf = (s) => s.wx().sessions[0].decision

test('requestDecision flags the session and lists it, unsaved; real input clears it, a terminal reply does not', async (t) => {
  const s = setup(t)
  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const saves = s.saves.length
  s.sessions.requestDecision({ projectId: s.projectId, sessionId, question: '  Ship it?  ' })
  assert.deepEqual(decisionOf(s), { question: 'Ship it?', at: s.clock.t })
  assert.equal(s.saves.length, saves, 'decisions are runtime-only')
  assert.deepEqual(attention(s).map((e) => [e.sessionId, e.status, e.since, e.decision]), [[sessionId, 'idle', s.clock.t, { question: 'Ship it?', at: s.clock.t }]])
  s.sessions.noteInput(ptyId, '\x1b[12;1R')
  s.sessions.noteInput(ptyId, '\x1b[I')
  assert.equal(decisionOf(s)?.question, 'Ship it?', 'terminal replies and focus reports do not answer it')
  s.sessions.noteInput(ptyId, 'y')
  assert.equal(decisionOf(s), undefined)
  assert.equal(statusOf(s), 'idle', 'input to an idle session leaves its status alone')
  assert.deepEqual(attention(s), [])
})

test('a decision on a done session: input clears it in one patch and keeps done and its since', async (t) => {
  const s = setup(t)
  const { ptyId, sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.spawned[0].emit('esc to interrupt')
  fireQuiet(s)
  const doneSince = attention(s)[0].since
  s.clock.t += 7000
  s.sessions.requestDecision({ projectId: s.projectId, sessionId, question: 'Which one?' })
  assert.deepEqual(attention(s).map((e) => [e.status, e.since, e.decision.question]), [['done', doneSince, 'Which one?']])
  const publish = t.mock.method(s.projects, 'apply')
  s.sessions.noteInput(ptyId, '1')
  assert.equal(publish.mock.callCount(), 1, 'one change for the decision and the status')
  assert.equal(decisionOf(s), undefined)
  assert.equal(statusOf(s), 'done')
  assert.deepEqual(attention(s).map((e) => [e.status, e.since, e.decision]), [['done', doneSince, undefined]])
})

test('sendPrompt and tool keys answer a decision; seen does not; dismissDecision does; a new request replaces it', async (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const ask = (question) => s.sessions.requestDecision({ projectId: s.projectId, sessionId, question })
  ask('one')
  await s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: 'go' })
  assert.equal(decisionOf(s), undefined, 'a prompt is the user acting')
  ask('two')
  s.sessions.noteUserInput(sessionId)
  assert.equal(decisionOf(s), undefined, 'so are send_keys')
  ask('three')
  s.sessions.seen({ projectId: s.projectId, sessionId })
  assert.equal(decisionOf(s)?.question, 'three', 'showing the session does not answer it')
  s.clock.t += 10
  ask('four')
  assert.deepEqual(decisionOf(s), { question: 'four', at: s.clock.t })
  s.sessions.dismissDecision({ projectId: s.projectId, sessionId })
  assert.equal(decisionOf(s), undefined)
  assert.deepEqual(attention(s), [])
  assert.doesNotThrow(() => s.sessions.dismissDecision({ projectId: s.projectId, sessionId }), 'dismissing nothing is fine')
})

test('decisions: exit and session.restart keep one, unload and forgetGlobal clear them; bad questions and ids are refused', async (t) => {
  const s = setup(t)
  const one = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const global = s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  s.sessions.requestDecision({ projectId: s.projectId, sessionId: one.sessionId, question: 'q1' })
  s.sessions.requestDecision({ projectId: s.projectId, sessionId: global.sessionId, question: 'q2' })
  s.spawned[0].exit(0)
  assert.equal(decisionOf(s)?.question, 'q1', 'the question is still open after the agent exits')
  s.sessions.restart({ projectId: s.projectId, sessionId: one.sessionId, ...size })
  assert.equal(decisionOf(s)?.question, 'q1', 'and after session.restart')
  s.sessions.unloadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  assert.equal(decisionOf(s), undefined)
  s.sessions.forgetGlobal(s.projectId)
  assert.equal(s.project().globalSessions[0].decision, undefined)
  assert.deepEqual(attention(s), [])
  const bad = (p) => assert.throws(() => s.sessions.requestDecision({ projectId: s.projectId, sessionId: global.sessionId, ...p }), (e) => e.code === 'BAD_REQUEST')
  bad({ question: '   ' })
  bad({ question: 5 })
  bad({})
  bad({ question: 'x'.repeat(1001) })
  bad({ question: 'red \x1b[31mtext' })
  bad({ question: 'nul\u0000' })
  s.sessions.requestDecision({ projectId: s.projectId, sessionId: global.sessionId, question: '\n Pick:\n\t a  or\r\nb \n' })
  assert.equal(s.project().globalSessions[0].decision?.question, 'Pick: a or b', 'whitespace collapses to one line')
  assert.doesNotThrow(() => s.sessions.requestDecision({ projectId: s.projectId, sessionId: global.sessionId, question: 'x'.repeat(1000) }))
  assert.throws(() => s.sessions.requestDecision({ projectId: s.projectId, sessionId: 'nope', question: 'q' }), (e) => e.code === 'NOT_FOUND')
  assert.throws(() => s.sessions.dismissDecision({ projectId: s.projectId, sessionId: 'nope' }), (e) => e.code === 'NOT_FOUND')
})

test('v2: session.dismissDecision is wired; pty.write answers a decision', async (t) => {
  const s = setup(t)
  const { call } = v2(s)
  const { ptyId, sessionId } = (await call('session.start', { projectId: s.projectId, worktreeId: 'wx', ...size })).result
  s.sessions.requestDecision({ projectId: s.projectId, sessionId, question: 'q' })
  assert.deepEqual(await call('session.dismissDecision', { projectId: s.projectId, sessionId }), { ok: true, result: null })
  assert.equal(decisionOf(s), undefined)
  s.sessions.requestDecision({ projectId: s.projectId, sessionId, question: 'q' })
  await call('pty.attach', { ptyId })
  await call('pty.write', { ptyId, data: '\x1b[1;1R' })
  assert.equal(decisionOf(s)?.question, 'q')
  await call('pty.write', { ptyId, data: 'n' })
  assert.equal(decisionOf(s), undefined)
})

test('v2: server.agents lists every provider, whether it is installed, and the server default', async (t) => {
  const asked = []
  const commandExists = async (binary) => { asked.push(binary); return binary === 'claude' || binary === 'my-claude' }
  const s = setup(t, { llm: { llmDefault: { provider: 'codex', model: 'gpt-5' }, providers: { gemini: { command: 'KEY=secret gem' } } }, commandExists })
  const { call } = v2(s)
  const all = await call('server.agents', {})
  assert.equal(all.ok, true, JSON.stringify(all))
  assert.deepEqual(all.result, {
    llmDefault: { provider: 'codex', model: 'gpt-5' },
    agents: [
      { provider: 'claude', label: 'Claude', installed: true },
      { provider: 'codex', label: 'Codex', installed: false },
      { provider: 'gemini', label: 'Gemini', installed: false },
      { provider: 'grok', label: 'Grok', installed: false },
      { provider: 'local', label: 'Local', installed: true }
    ]
  })
  assert.equal(JSON.stringify(all.result).includes('secret'), false, 'command lines are not sent')
  assert.deepEqual(asked.sort(), ['claude', 'codex', 'gem', 'grok'], 'local runs claude: one check')
  s.projects.apply(s.projectId, (d) => { d.settings.claudeCommand = 'nope-claude --x' })
  const scoped = await call('server.agents', { projectId: s.projectId })
  assert.equal(scoped.result.agents[0].installed, false, "the project's claudeCommand")
  assert.equal(scoped.result.agents[4].installed, true, 'local keeps the server command')
  assert.equal((await call('server.agents', { projectId: 'nope' })).error.code, 'NOT_FOUND')
  assert.equal((await call('server.agents', { projectId: 5 })).error.code, 'BAD_REQUEST')
})

test('maxSessions refusals use CAPACITY', (t) => {
  const s = setup(t, { maxSessions: 1 })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size }), (e) => e.code === 'CAPACITY')
})

test('a project holds at most MAX_SESSIONS_PER_PROJECT session records', async (t) => {
  const { MAX_SESSIONS_PER_PROJECT } = await import('../server/src/sessions/limits.ts')
  const s = setup(t)
  s.projects.apply(s.projectId, (d) => {
    for (let i = 0; i < MAX_SESSIONS_PER_PROJECT; i++) {
      d.repositories[0].worktrees[1].sessions.push({ id: `r${i}`, title: 't', llm: { provider: 'claude' }, queue: [], status: 'idle' })
    }
  })
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size }), (e) => e.code === 'CAPACITY')
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size }), (e) => e.code === 'CAPACITY', 'Global sessions count too')
  assert.equal(s.wx().loaded, false, 'refused before loading')
})

test('terminal sizes are capped at 500 columns and 200 rows', (t) => {
  const s = setup(t)
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', cols: 501, rows: 30 }), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', cols: 80, rows: 201 }), (e) => e.code === 'BAD_REQUEST')
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', cols: 500, rows: 200 })
})

test('sessions launch with the project\'s MCP access; Global sessions get the role prompt', (t) => {
  const s = setup(t, { mcpAccess: (projectId) => ({ configPath: `/m/${projectId}.json`, url: 'http://127.0.0.1:9/mcp', token: 'tok', geminiSettingsPath: `/m/${projectId}-g.json`, codexHeadersHelper: `/bin/cat '/m/${projectId}.codex.json'` }) })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.match(cmd(s.spawned[0]), new RegExp(`--mcp-config '/m/${s.projectId}.json' --allowedTools mcp__trek-dev`))
  s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  assert.match(cmd(s.spawned[1]), /global Claude session/)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', llm: { provider: 'codex' }, ...size })
  // Codex reads its token through the helper, from a file: never from its environment or argv.
  assert.match(cmd(s.spawned[2]), new RegExp(`http_headers_helper="/bin/cat .*/m/${s.projectId}\\.codex\\.json`))
  assert.ok(!JSON.stringify(s.spawned[2].opts.env).includes('tok'))
  assert.ok(!cmd(s.spawned[2]).includes('tok'))
})

test('without MCP access sessions launch as before', (t) => {
  const s = setup(t)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.doesNotMatch(cmd(s.spawned[0]), /--mcp-config/)
})

test('a throwing mcpAccess is logged and the session launches without MCP', (t) => {
  const err = t.mock.method(console, 'error', () => {})
  const s = setup(t, { mcpAccess: () => { throw new Error('bad project') } })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.equal(s.spawned.length, 1)
  assert.doesNotMatch(cmd(s.spawned[0]), /--mcp-config/)
  assert.equal(err.mock.callCount(), 1)
})
