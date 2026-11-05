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

const tick = () => new Promise((r) => setImmediate(r))
/** The agent command a spawn ran (the shell's -c argument). */
const cmd = (proc) => proc.opts.args.at(-1)

function setup(t, { llm } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-sessions-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  const b = join(dir, 'repos', 'b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  mkdirSync(join(dir, 'repos', 'a-x'))
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { repos: [{ id: 'a', name: 'a', path: a }, { id: 'b', name: 'b', path: b }], ...(llm ? { llm } : {}) })
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
  const sessions = new SessionManager({
    projects, store, spawner: fake.spawner,
    discover: async (cwd, ageMs, exclude) => { discoveries.push({ cwd, exclude }); return sessions.__nextDiscovery },
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
  return { dir, a, b, store, projects, sessions, saves, projectId, project, main, wx, ...fake, discoveries, scheduled }
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
