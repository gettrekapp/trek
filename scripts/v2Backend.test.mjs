// scripts/v2Backend.test.mjs — a server window's backend: each action as the v2 request it sends.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createV2Backend, tornDownNote, V2_START_SIZE } from '../src/renderer/src/v2/backendV2.ts'
import { PROMPT_NOT_CONFIRMED, withPromptText } from '../src/renderer/src/v2/errors.ts'

const PRIMARY = '__primary__:r1'
const ids = () => ({
  worktrees: { [PRIMARY]: { repoId: 'r1', worktreeId: 'wm' }, w2: { repoId: 'r1', worktreeId: 'w2' } },
  worktreeByPath: { '/r': PRIMARY, '/r-feat': 'w2' },
  sessions: {},
  legacyByWorktree: { wm: PRIMARY, w2: 'w2' }
})
const repo = (extra = {}) => ({ id: 'r1', name: 'r', path: '/r', worktrees: [{ id: 'w2', name: 'feat', path: '/r-feat', branch: 'feat' }], ...extra })

class CodedError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

/**
 * A backend over fakes: `calls` records each request, `replies` answers by
 * method (a value, a function of the params, or an Error to reject with), and
 * `ui` records what the dialogs were asked; `reports` what went to `report`.
 * `revs` is the rev each method's response reports; `waits` records each
 * whenProjected's rev (null without one); `timeouts` each request sent with
 * one; `listeners` what subscribed to each server event.
 */
function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp'], localEntry = false, machine = {}, projectedAfter = [], left = () => false, revs = {} } = {}) {
  const calls = []
  const ui = []
  const reports = []
  const waits = []
  const timeouts = []
  const listeners = {}
  // The backend each teardown step was handed (the remove's own, never another window's).
  const owners = []
  const st = {
    project: { name: 'p', version: 3, repositories: [repo()], globalSessions: [] },
    terminals: {},
    terminalQueues: {},
    loadedWorktrees: {},
    hostWorktrees: { 'r1 local': [{ path: '/r', repoId: 'r1', isMain: true }] },
    ...state
  }
  const answers = [...confirms]
  const idMap = ids()
  const request = async (method, params, options) => {
    calls.push([method, params])
    if (options?.timeoutMs !== undefined) timeouts.push([method, options.timeoutMs])
    const reply = replies[method]
    const value = typeof reply === 'function' ? reply(params) : reply
    if (value instanceof Error) throw value
    return value ?? null
  }
  const backend = createV2Backend({
    projectId: 'p1',
    request,
    requestWithRev: async (method, params) => {
      const result = await request(method, params)
      return revs[method] ? { result, rev: revs[method] } : { result }
    },
    // null stands for "no welcome yet" (undefined would take the default)
    capabilities: typeof capabilities === 'function' ? capabilities : () => capabilities ?? undefined,
    localEntry,
    onEvent: (event, listener) => {
      ;(listeners[event] ??= []).push(listener)
      return () => {
        listeners[event] = listeners[event].filter((l) => l !== listener)
      }
    },
    ids: () => idMap,
    state: () => st,
    // Each projectedAfter entry is applied to the state and ids before the check, like a patch arriving.
    whenProjected: async (check, rev) => {
      waits.push(rev ?? null)
      for (const patch of projectedAfter.splice(0)) patch(st, idMap)
      return check()
    },
    termSize: (id) => (id === 's1' ? { cols: 100, rows: 30 } : null),
    focus: (id) => ui.push(['focus', id]),
    setActiveTerminal: (worktreeId, id) => ui.push(['active', worktreeId, id]),
    confirm: async (prompt) => {
      ui.push(['confirm', prompt.title, prompt.confirmLabel])
      return answers.shift() ?? false
    },
    // As installV2's: nothing shows once the window left.
    showError: async (title, message) => void (left() || ui.push(['error', title, message])),
    promptRepoPath: async () => {
      ui.push(['prompt'])
      return answers.shift() ?? null
    },
    registeredRepoPath: async (repoId) => (repoId === 'srv-b' ? '/b' : null),
    removalBlock: (r) => (r.id === 'blocked' ? 'It has live sessions.' : null),
    report: (title, err) => void (left() || reports.push([title, err.code])),
    reportEdit: (title, err, notConfirmed) => void (left() || reports.push([title, err.code, notConfirmed ?? 'edit'])),
    // The server machine's teardown: `machine.env` is the branch's VM, `machine.stack` its dev stack's
    // name (offered as the confirm's checkbox), `machine.ticked` the checkbox's answer, `machine.dirty`
    // what a fresh git status of the worktree (worktree.dirty) says.
    teardown: {
      environment: (info) => {
        ui.push(['env?', info.path])
        return machine.env ? { profile: machine.env } : undefined
      },
      confirm: async (info, prompt, owner) => {
        owners.push(owner)
        ui.push(['confirm+stack', prompt.title, prompt.detail])
        const confirmed = answers.shift() ?? false
        return { confirmed, ...(machine.stack && machine.ticked !== false ? { stackName: machine.stack } : {}) }
      },
      destroyStack: async (info, name, owner) => {
        owners.push(owner)
        calls.push(['stack.sh destroy', info.path, name])
      },
      destroyEnvironment: async (info, owner) => {
        owners.push(owner)
        calls.push(['colima delete', info.path])
      },
      isDirty: async (info, owner) => {
        owners.push(owner)
        ui.push(['git status', info.path])
        if (machine.dirty instanceof Error) throw machine.dirty
        return machine.dirty === true
      }
    },
    left
  })
  return { backend, calls, ui, st, reports, waits, timeouts, listeners, owners }
}

test('features follow the welcome capabilities, with a stable object', () => {
  const { backend } = setup()
  assert.equal(backend.kind, 'v2')
  assert.equal(backend.features.globalPanel, true)
  assert.equal(backend.features, backend.features)
  assert.equal(setup({ capabilities: [] }).backend.features.globalPanel, false)
  assert.equal(setup({ capabilities: null }).backend.features.globalPanel, false)
})

test('features before the welcome, then when the capabilities change', () => {
  let caps
  const { backend } = setup({ capabilities: () => caps })
  const before = backend.features
  assert.equal(before.globalPanel, false)
  caps = ['mcp']
  assert.equal(backend.features.globalPanel, true)
  assert.notEqual(backend.features, before)
  caps = []
  assert.equal(backend.features.globalPanel, false)
})

test("this machine's features: only the Local entry's server, once it says `local`; the server's follow its capabilities", () => {
  const local = (b) => ['reveal', 'openInEditor'].filter((name) => b.features[name])
  const server = (b) => ['docker', 'env', 'stacks', 'linear', 'voice', 'skills'].filter((name) => b.features[name])
  assert.deepEqual(local(setup({ capabilities: ['mcp', 'local'], localEntry: true }).backend), ['reveal', 'openInEditor'])
  assert.deepEqual(local(setup({ capabilities: ['mcp', 'local'] }).backend), [])
  assert.deepEqual(local(setup({ capabilities: ['mcp'], localEntry: true }).backend), [])
  assert.deepEqual(server(setup({ capabilities: ['mcp', 'docker', 'env', 'stacks'] }).backend), ['docker', 'env', 'stacks'])
  assert.deepEqual(server(setup({ capabilities: ['mcp', 'local'], localEntry: true }).backend), [])
  assert.deepEqual(server(setup({ capabilities: ['linear', 'voice', 'skills'] }).backend), ['linear', 'voice', 'skills'])
  assert.equal(setup().backend.features.linear, false)
  // A server before its welcome, then once it arrives.
  let caps
  const { backend } = setup({ capabilities: () => caps })
  assert.equal(backend.features.env, false)
  caps = ['mcp', 'env']
  assert.equal(backend.features.env, true)
})

test("docker, env and stacks go to the server by id: a worktree by the store's path, a repository by its id; the long ones with long timeouts", async () => {
  const { backend, calls, timeouts } = setup({ replies: { 'env.up': { code: 0 }, 'worktree.dirty': true } })
  const feat = { path: '/r-feat' }
  await backend.docker.list()
  await backend.docker.container('restart', 'c1')
  await backend.docker.compose('r1', 'upBuild')
  await backend.env.check()
  await backend.env.list('r1')
  await backend.env.up(feat, { enabled: true, cpu: 3 }, { FOO: 'bar' })
  await backend.env.up(feat, { enabled: true }, undefined)
  await backend.env.stop('twb-feat-abc123')
  await backend.env.destroy('twb-feat-abc123')
  await backend.env.ps(feat, undefined)
  await backend.env.ps(feat, 'compose.dev.yaml')
  await backend.env.composeFiles(feat)
  await backend.env.logs(feat, undefined, 'web', 300)
  await backend.stacks.status(feat)
  await backend.stacks.up(feat, true)
  await backend.stacks.down(feat)
  await backend.stacks.destroy({ path: '/r' })
  await backend.stacks.log(feat, 7, 120)
  assert.equal(await backend.git.dirty(feat), true)
  const w = { projectId: 'p1', worktreeId: 'w2' }
  assert.deepEqual(calls, [
    ['docker.list', {}],
    ['docker.container', { action: 'restart', id: 'c1' }],
    ['docker.compose', { projectId: 'p1', repoId: 'r1', action: 'upBuild' }],
    ['env.check', {}],
    ['env.list', { projectId: 'p1', repoId: 'r1' }],
    ['env.up', { ...w, settings: { enabled: true, cpu: 3 }, envVars: { FOO: 'bar' } }],
    ['env.up', { ...w, settings: { enabled: true } }],
    ['env.stop', { profile: 'twb-feat-abc123' }],
    ['env.destroy', { profile: 'twb-feat-abc123' }],
    ['env.ps', w],
    ['env.ps', { ...w, composeFile: 'compose.dev.yaml' }],
    ['env.composeFiles', w],
    ['env.logs', { ...w, service: 'web', tail: 300 }],
    ['stack.status', w],
    ['stack.up', { ...w, starter: true }],
    ['stack.down', w],
    ['stack.destroy', { projectId: 'p1', worktreeId: 'wm' }],
    ['stack.log', { ...w, fileId: 7, offset: 120 }],
    ['worktree.dirty', w]
  ])
  const minutes = (ms) => ms / 60_000
  assert.deepEqual(timeouts.map(([m, ms]) => [m, minutes(ms)]), [
    ['docker.container', 3],
    ['docker.compose', 30],
    ['env.up', 30],
    ['env.up', 30],
    ['env.stop', 10],
    ['env.destroy', 10],
    ['stack.down', 10],
    ['stack.destroy', 10]
  ])
})

test('a worktree path the projection does not know is refused here, and nothing is sent', async () => {
  const { backend, calls } = setup()
  await assert.rejects(backend.env.up({ path: '/elsewhere' }, { enabled: true }, undefined), (err) => err.code === 'NOT_FOUND')
  await assert.rejects(backend.stacks.status({ path: '/elsewhere' }), (err) => err.code === 'NOT_FOUND')
  assert.deepEqual(calls, [])
})

test("linear, voice and skills go to the window's server; the clip comes back as bytes; the summaries are this project's", async () => {
  const replies = {
    'linear.status': { hasKey: true },
    'linear.setKey': { ok: true, user: 'Ada' },
    'linear.issues': [{ identifier: 'TOW-1' }],
    'voice.settings': { hasKey: false, voiceId: '', modelId: 'm', promptSessions: false },
    'voice.setKey': { ok: true, voices: [] },
    'voice.voices': [{ id: 'v1', name: 'Rachel' }],
    'voice.setConfig': { voiceId: 'v1', modelId: 'm', promptSessions: true },
    'voice.synthesize': { audio: Buffer.from('mp3!').toString('base64') },
    'skills.list': [{ name: 'review', source: 'project', kind: 'skill' }]
  }
  const { backend, calls, listeners } = setup({ replies })
  assert.equal(await backend.linear.hasKey(), true)
  assert.deepEqual(await backend.linear.setKey('lin_k'), { ok: true, user: 'Ada' })
  await backend.linear.clearKey()
  assert.deepEqual(await backend.linear.issues(['TOW-1']), [{ identifier: 'TOW-1' }])
  assert.equal((await backend.voice.settings()).modelId, 'm')
  await backend.voice.setKey('sk_k')
  await backend.voice.clearKey()
  await backend.voice.voices()
  await backend.voice.setConfig({ promptSessions: true })
  assert.equal(Buffer.from(await backend.voice.synthesize('Hi')).toString(), 'mp3!')
  assert.deepEqual(await backend.skills.list({ path: '/r-feat' }), [{ name: 'review', source: 'project', kind: 'skill' }])
  assert.deepEqual(calls, [
    ['linear.status', {}],
    ['linear.setKey', { apiKey: 'lin_k' }],
    ['linear.clearKey', {}],
    ['linear.issues', { ids: ['TOW-1'] }],
    ['voice.settings', {}],
    ['voice.setKey', { apiKey: 'sk_k' }],
    ['voice.clearKey', {}],
    ['voice.voices', {}],
    ['voice.setConfig', { promptSessions: true }],
    ['voice.synthesize', { text: 'Hi' }],
    ['skills.list', { projectId: 'p1', worktreeId: 'w2' }]
  ])
  const heard = []
  const off = backend.voice.onSummary((e) => heard.push(e.text))
  for (const l of listeners['voice.summary']) l({ projectId: 'p1', sessionId: 's1', text: 'mine', audio: '' })
  for (const l of listeners['voice.summary']) l({ projectId: 'other', sessionId: 's1', text: 'theirs', audio: '' })
  off()
  assert.deepEqual(listeners['voice.summary'], [])
  assert.deepEqual(heard, ['mine'])
  // A key or voice change made anywhere (another window, the hand-over): each part's own listeners.
  const changed = []
  const offLinear = backend.linear.onChanged(() => changed.push('linear'))
  const offVoice = backend.voice.onChanged(() => changed.push('voice'))
  for (const l of listeners['integrations.changed']) l({ linear: true })
  for (const l of listeners['integrations.changed']) l({ voice: true })
  for (const l of listeners['integrations.changed']) l({ linear: true, voice: true })
  offLinear()
  offVoice()
  assert.deepEqual(listeners['integrations.changed'], [])
  assert.deepEqual(changed, ['linear', 'voice', 'linear', 'voice'])
})

test("the logs come from the window's connection, by event name, until unsubscribed", () => {
  const { backend, listeners } = setup()
  const docker = []
  const env = []
  const offDocker = backend.docker.onLog((e) => docker.push(e.data))
  const offEnv = backend.env.onLog((e) => env.push([e.profile, e.step ?? null]))
  for (const l of listeners['docker.log']) l({ data: 'pulling' })
  for (const l of listeners['env.log']) l({ profile: 'twb-x', data: '', step: 'vm' })
  offDocker()
  offEnv()
  assert.deepEqual([listeners['docker.log'], listeners['env.log']], [[], []])
  assert.deepEqual([docker, env], [['pulling'], [['twb-x', 'vm']]])
})

test('start by instance id or by path sends session.start with the v2 worktree, a size, the type and agent', async () => {
  const projectedAfter = [(st) => (st.terminals.s9 = { id: 's9', worktreeId: 'w2', title: 't', sessionId: 's9', status: 'idle' })]
  const { backend, calls, ui } = setup({ replies: { 'session.start': { sessionId: 's9', ptyId: 'p9' } }, projectedAfter })
  const llm = { provider: 'codex' }
  assert.equal(await backend.sessions.start({ worktreeId: 'w2' }, { id: 'review', name: 'Review', systemPrompt: '' }, llm), 's9')
  assert.deepEqual(calls[0], ['session.start', { projectId: 'p1', worktreeId: 'w2', sessionTypeId: 'review', llm, ...V2_START_SIZE }])
  // The new tab becomes the worktree's active one once the patch shows it.
  assert.deepEqual(ui, [['active', 'w2', 's9']])
  await backend.sessions.start({ path: '/r' })
  assert.deepEqual(calls[1], ['session.start', { projectId: 'p1', worktreeId: 'wm', ...V2_START_SIZE }])
})

test('start for an unknown target resolves null and sends nothing', async () => {
  const { backend, calls } = setup()
  assert.equal(await backend.sessions.start({ worktreeId: 'nope' }), null)
  assert.equal(await backend.sessions.start({ path: '/elsewhere' }), null)
  assert.deepEqual(calls, [])
})

test('start: the id comes back even when its tab never shows up, and nothing is made active', async () => {
  const { backend, ui } = setup({ replies: { 'session.start': { sessionId: 's9', ptyId: 'p9' } } })
  assert.equal(await backend.sessions.start({ worktreeId: 'w2' }), 's9')
  assert.deepEqual(ui, [])
})

test('start, restart and close report a refusal and resolve; NOT_CONNECTED is not reported', async () => {
  const replies = {
    'session.start': new CodedError('CAPACITY', 'too many sessions'),
    'session.restart': new CodedError('NOT_CONNECTED', ''),
    'session.close': new CodedError('NOT_FOUND', 'no session')
  }
  const { backend, reports, ui } = setup({ replies })
  assert.equal(await backend.sessions.start({ worktreeId: 'w2' }), null)
  assert.equal(await backend.sessions.restart('s1'), undefined)
  assert.equal(await backend.sessions.close('s1'), undefined)
  assert.deepEqual(reports, [
    ['Could not start the session', 'CAPACITY'],
    ['Could not close the session', 'NOT_FOUND']
  ])
  // No focus after a failed restart.
  assert.deepEqual(ui, [])
  const offline = setup({ replies: { 'session.start': new CodedError('NOT_CONNECTED', '') } })
  assert.equal(await offline.backend.sessions.start({ worktreeId: 'w2' }), null)
  assert.deepEqual(offline.reports, [])
})

test('openGlobal starts one session only when there are none, and never twice at once', async () => {
  const { backend, calls, st } = setup({ replies: { 'session.start': { sessionId: 'g1', ptyId: 'pg' } } })
  await Promise.all([backend.sessions.openGlobal(), backend.sessions.openGlobal()])
  assert.deepEqual(calls, [['session.start', { projectId: 'p1', worktreeId: null, ...V2_START_SIZE }]])
  st.project.globalSessions = [{ sessionId: 'g1', title: 'Claude' }]
  await backend.sessions.openGlobal()
  assert.equal(calls.length, 1)
  // A new tab (+) always starts one.
  await backend.sessions.startGlobal()
  assert.equal(calls.length, 2)
})

test('a failed global start rejects and clears the shared promise', async () => {
  let n = 0
  const replies = { 'session.start': () => (n++ === 0 ? new CodedError('CAPACITY', 'full') : { sessionId: 'g1', ptyId: 'pg' }) }
  const { backend, calls } = setup({ replies })
  await assert.rejects(backend.sessions.openGlobal(), { code: 'CAPACITY' })
  await backend.sessions.openGlobal()
  assert.equal(calls.length, 2)
  n = 0
  await assert.rejects(backend.sessions.startGlobal(), { code: 'CAPACITY' })
  await backend.sessions.startGlobal()
  assert.equal(calls.length, 4)
})

test('restart sends the terminal size (or the default), then focuses', async () => {
  const { backend, calls, ui } = setup()
  await backend.sessions.restart('s1')
  await backend.sessions.restart('s2')
  assert.deepEqual(calls, [
    ['session.restart', { projectId: 'p1', sessionId: 's1', cols: 100, rows: 30 }],
    ['session.restart', { projectId: 'p1', sessionId: 's2', ...V2_START_SIZE }]
  ])
  assert.deepEqual(ui, [['focus', 's1'], ['focus', 's2']])
})

test('session commands map one to one; a rename is trimmed and an empty or unchanged one sends nothing', async () => {
  const { backend, calls } = setup({ state: { terminals: { s1: { id: 's1', worktreeId: 'w2', title: 'Same', sessionId: 's1', status: 'idle' } } } })
  await backend.sessions.close('s1')
  await backend.sessions.rename('s1', '  New  ')
  await backend.sessions.rename('s1', '   ')
  await backend.sessions.rename('s1', 'Same')
  await backend.sessions.sendPrompt('s1', 'hi', false)
  await backend.sessions.enqueue('s1', 'later')
  await backend.sessions.setQueue('s1', ['a'])
  await backend.sessions.markComplete('s1', true)
  await backend.sessions.seen('s1')
  const ref = { projectId: 'p1', sessionId: 's1' }
  assert.deepEqual(calls, [
    ['session.close', ref],
    ['session.rename', { ...ref, title: 'New' }],
    ['session.sendPrompt', { ...ref, text: 'hi' }],
    ['session.enqueue', { ...ref, text: 'later' }],
    ['session.setQueue', { ...ref, queue: ['a'] }],
    ['session.markComplete', { ...ref, complete: true }],
    ['session.seen', ref]
  ])
})

test('load, unload and unload-all address the v2 worktrees', async () => {
  const { backend, calls } = setup({ state: { loadedWorktrees: { [PRIMARY]: true, w2: true } } })
  await backend.worktrees.load(PRIMARY)
  await backend.worktrees.unload('w2')
  await backend.worktrees.unloadAll()
  assert.deepEqual(calls, [
    ['worktree.load', { projectId: 'p1', worktreeId: 'wm' }],
    ['worktree.unload', { projectId: 'p1', worktreeId: 'w2' }],
    ['worktree.unload', { projectId: 'p1', worktreeId: 'wm' }],
    ['worktree.unload', { projectId: 'p1', worktreeId: 'w2' }]
  ])
  // Fire and forget: an unknown id is reported, not rejected.
  await backend.worktrees.load('nope')
})

test('load and unload report a refusal and resolve', async () => {
  const replies = { 'worktree.load': new CodedError('BAD_REQUEST', 'load the worktree first'), 'worktree.unload': new CodedError('IN_USE', 'busy') }
  const { backend, reports } = setup({ replies })
  assert.equal(await backend.worktrees.load('w2'), undefined)
  assert.equal(await backend.worktrees.unload('w2'), undefined)
  await backend.worktrees.load('nope')
  assert.deepEqual(reports, [
    ['Could not load the worktree', 'BAD_REQUEST'],
    ['Could not unload the worktree', 'IN_USE'],
    ['Could not load the worktree', 'NOT_FOUND']
  ])
})

test('unloadAll skips stale ids, and one refusal does not stop the rest', async () => {
  const replies = { 'worktree.unload': (p) => (p.worktreeId === 'wm' ? new CodedError('IN_USE', 'busy') : null) }
  const { backend, calls, reports } = setup({ replies, state: { loadedWorktrees: { gone: true, [PRIMARY]: true, w2: true } } })
  await backend.worktrees.unloadAll()
  assert.deepEqual(calls.map(([, p]) => p.worktreeId), ['wm', 'w2'])
  assert.deepEqual(reports, [['Could not unload every worktree', 'IN_USE']])
})

test('create sends worktree.create and resolves the path once the mirror shows the worktree', async () => {
  const projectedAfter = [
    (st, idMap) => {
      st.project.repositories[0].worktrees.push({ id: 'w3', name: 'pr-7', path: '/r-pr-7' })
      idMap.legacyByWorktree.w3 = 'w3'
    }
  ]
  const { backend, calls } = setup({ replies: { 'worktree.create': { worktreeId: 'w3' } }, projectedAfter })
  const created = await backend.worktrees.create({ repoId: 'r1', branch: 'pr-7', createBranch: false, fromPr: 7 })
  assert.deepEqual(created, { path: '/r-pr-7', worktreeId: 'w3' })
  assert.deepEqual(calls, [['worktree.create', { projectId: 'p1', repoId: 'r1', branch: 'pr-7', createBranch: false, fromPr: 7 }]])
})

test('create rejects with the server error, or when the worktree never shows up', async () => {
  const { backend } = setup({ replies: { 'worktree.create': new CodedError('GIT_ERROR', 'branch exists') } })
  await assert.rejects(backend.worktrees.create({ repoId: 'r1', branch: 'x', createBranch: true }), /branch exists/)
  const late = setup({ replies: { 'worktree.create': { worktreeId: 'w9' } } })
  await assert.rejects(late.backend.worktrees.create({ repoId: 'r1', branch: 'x', createBranch: true }), /has not shown up here yet/)
})

const feat = { path: '/r-feat', repoId: 'r1', isMain: false, branch: 'feat' }

test('remove: declined sends nothing', async () => {
  const { backend, calls, ui } = setup({ confirms: [false] })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(ui, [['confirm', 'Delete Worktree', 'Delete Worktree']])
  assert.deepEqual(calls, [])
})

test('remove: an id no longer in the project is shown, and nothing is sent', async () => {
  const { backend, calls, ui } = setup()
  await backend.worktrees.remove({ ...feat, path: '/gone' }, undefined)
  await backend.worktrees.remove(feat, { id: 'stale', name: 'x', path: '/r-feat' })
  const shown = ['error', 'Could not delete worktree', 'This worktree is no longer in the project.']
  assert.deepEqual(ui, [shown, shown])
  assert.deepEqual(calls, [])
})

test('remove: a loaded worktree is unloaded first; a dirty one is forced', async () => {
  const { backend, calls, ui } = setup({ confirms: [true], state: { loadedWorktrees: { w2: true } } })
  await backend.worktrees.remove({ ...feat, dirty: true }, undefined)
  assert.deepEqual(ui, [['confirm', 'Delete Worktree', 'Delete Worktree & Changes']])
  assert.deepEqual(calls, [
    ['worktree.unload', { projectId: 'p1', worktreeId: 'w2' }],
    ['worktree.remove', { projectId: 'p1', worktreeId: 'w2', force: true }]
  ])
})

test('remove: changes that appeared since the poll ask again, then force', async () => {
  let n = 0
  const replies = { 'worktree.remove': (p) => (n++ === 0 ? new CodedError('GIT_ERROR', "fatal: '/r-feat' contains modified or untracked files, use --force") : null) }
  const { backend, calls, ui } = setup({ confirms: [true, true], replies })
  await backend.worktrees.remove(feat, { id: 'w2', name: 'feat', path: '/r-feat' })
  assert.deepEqual(ui, [
    ['confirm', 'Delete Worktree', 'Delete Worktree'],
    ['confirm', 'Delete Uncommitted Changes', 'Delete Changes & Worktree']
  ])
  assert.deepEqual(calls.map(([m, p]) => [m, p.force]), [['worktree.remove', false], ['worktree.remove', true]])
})

const UNCOMMITTED_ERR = () => new CodedError('GIT_ERROR', "fatal: '/r-feat' contains modified or untracked files, use --force")
const LOADED = { loadedWorktrees: { w2: true } }

test('remove: the re-ask declined sends one remove, shows nothing, and loads the worktree again', async () => {
  const { backend, calls, ui } = setup({ confirms: [true, false], state: LOADED, replies: { 'worktree.remove': UNCOMMITTED_ERR() } })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(calls.map(([m]) => m), ['worktree.unload', 'worktree.remove', 'worktree.load'])
  assert.ok(!ui.some(([kind]) => kind === 'error'))
})

test('remove: a failed forced retry shows its own error, and loads the worktree again', async () => {
  const replies = { 'worktree.remove': (p) => (p.force ? new CodedError('GIT_ERROR', 'permission denied') : UNCOMMITTED_ERR()) }
  const { backend, calls, ui } = setup({ confirms: [true, true], state: LOADED, replies })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(calls.map(([m, p]) => [m, p.force]), [
    ['worktree.unload', undefined],
    ['worktree.remove', false],
    ['worktree.remove', true],
    ['worktree.load', undefined]
  ])
  assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', 'permission denied'])
})

test('remove: an already forced removal that git still refuses is shown, with no re-ask', async () => {
  const { backend, calls, ui } = setup({ confirms: [true, true], replies: { 'worktree.remove': UNCOMMITTED_ERR() } })
  await backend.worktrees.remove({ ...feat, dirty: true }, undefined)
  assert.deepEqual(calls.map(([m]) => m), ['worktree.remove'])
  assert.deepEqual(ui.map(([kind, title]) => [kind, title]), [['confirm', 'Delete Worktree'], ['error', 'Could not delete worktree']])
})

test('remove: another GIT_ERROR (locked) is shown, with no re-ask; the worktree is loaded again', async () => {
  const { backend, calls, ui } = setup({ confirms: [true, true], state: LOADED, replies: { 'worktree.remove': new CodedError('GIT_ERROR', "fatal: '/r-feat' is locked") } })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(calls.map(([m]) => m), ['worktree.unload', 'worktree.remove', 'worktree.load'])
  assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', "fatal: '/r-feat' is locked"])
  assert.equal(ui.filter(([kind]) => kind === 'confirm').length, 1)
})

test('remove: any other failure is shown in a dialog, the worktree is loaded again, and it resolves', async () => {
  // A failed reload is ignored: the removal's error is the one shown.
  const replies = { 'worktree.remove': new CodedError('IN_USE', 'loaded in Other'), 'worktree.load': new CodedError('GIT_ERROR', 'x') }
  const { backend, calls, ui } = setup({ confirms: [true], state: LOADED, replies })
  await backend.worktrees.remove(feat, undefined)
  assert.equal(calls.at(-1)[0], 'worktree.load')
  assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', 'loaded in Other'])
})

test('remove: a failed unload is shown, and nothing is loaded again', async () => {
  const { backend, calls, ui } = setup({ confirms: [true], state: LOADED, replies: { 'worktree.unload': new CodedError('IN_USE', 'busy') } })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(calls.map(([m]) => m), ['worktree.unload'])
  assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', 'busy'])
})

// A server that runs the environments and the stacks (5a): any server, Local or not.
const MACHINE_CAPS = { capabilities: ['mcp', 'docker', 'env', 'stacks'] }

test("remove on a server with env and stacks: the stack and the VM go after the unload, before git's removal (4c's order)", async () => {
  const { backend, calls, ui } = setup({ ...MACHINE_CAPS, confirms: [true], state: LOADED, machine: { env: 'twb-feat-abc123', stack: 'r-feat' } })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(ui[0], ['env?', '/r-feat'])
  assert.equal(ui[1][0], 'confirm+stack')
  assert.match(ui[1][2], /Its Docker environment \(Colima VM “twb-feat-abc123”\) and all its data will also be deleted\./)
  assert.deepEqual(calls, [
    ['worktree.unload', { projectId: 'p1', worktreeId: 'w2' }],
    ['stack.sh destroy', '/r-feat', 'r-feat'],
    ['colima delete', '/r-feat'],
    ['worktree.remove', { projectId: 'p1', worktreeId: 'w2', force: false }]
  ])
})

test('remove on a server with env and stacks: declined tears nothing down; the stack box unticked keeps the stack', async () => {
  const declined = setup({ ...MACHINE_CAPS, confirms: [false], machine: { env: 'twb-x', stack: 'r-feat' } })
  await declined.backend.worktrees.remove(feat, undefined)
  assert.deepEqual(declined.calls, [])
  const unticked = setup({ ...MACHINE_CAPS, confirms: [true], machine: { env: 'twb-x', stack: 'r-feat', ticked: false } })
  await unticked.backend.worktrees.remove(feat, undefined)
  assert.deepEqual(unticked.calls.map(([m]) => m), ['colima delete', 'worktree.remove'])
  // No VM and no stack: only git's removal.
  const bare = setup({ ...MACHINE_CAPS, confirms: [true] })
  await bare.backend.worktrees.remove(feat, undefined)
  assert.deepEqual(bare.calls.map(([m]) => m), ['worktree.remove'])
})

test('remove on a server with env and stacks: a fresh check finds changes the poll missed, and asks before anything is destroyed', async () => {
  // Declined: nothing is unloaded, destroyed or removed.
  const declined = setup({ ...MACHINE_CAPS, confirms: [true, false], state: LOADED, machine: { env: 'twb-x', stack: 'r-feat', dirty: true } })
  await declined.backend.worktrees.remove(feat, undefined)
  assert.deepEqual(declined.calls, [])
  assert.deepEqual(declined.ui.slice(2), [['git status', '/r-feat'], ['confirm', 'Delete Uncommitted Changes', 'Delete Changes & Worktree']])
  // Accepted: the teardown, then a forced removal (no second ask).
  const accepted = setup({ ...MACHINE_CAPS, confirms: [true, true], machine: { env: 'twb-x', dirty: true } })
  await accepted.backend.worktrees.remove(feat, undefined)
  assert.deepEqual(accepted.calls.map(([m, p]) => [m, p?.force]), [['colima delete', undefined], ['worktree.remove', true]])
  assert.equal(accepted.ui.filter(([kind]) => kind === 'confirm').length, 1)
})

test('remove on a server with env and stacks: no fresh check when nothing would be destroyed, or the poll already said dirty', async () => {
  const bare = setup({ ...MACHINE_CAPS, confirms: [true], machine: { dirty: true } })
  await bare.backend.worktrees.remove(feat, undefined)
  assert.ok(!bare.ui.some(([kind]) => kind === 'git status'))
  const polled = setup({ ...MACHINE_CAPS, confirms: [true], machine: { env: 'twb-x', dirty: true } })
  await polled.backend.worktrees.remove({ ...feat, dirty: true }, undefined)
  assert.ok(!polled.ui.some(([kind]) => kind === 'git status'))
  assert.deepEqual(polled.calls.map(([m, p]) => [m, p?.force]), [['colima delete', undefined], ['worktree.remove', true]])
})

test('remove on a server with env and stacks that fails after the teardown: loaded again, and the error says the stack and VM are gone', async () => {
  const replies = { 'worktree.remove': new CodedError('GIT_ERROR', "fatal: '/r-feat' is locked") }
  const { backend, calls, ui } = setup({ ...MACHINE_CAPS, confirms: [true], state: LOADED, replies, machine: { env: 'twb-x', stack: 'r-feat' } })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(calls.map(([m]) => m), ['worktree.unload', 'stack.sh destroy', 'colima delete', 'worktree.remove', 'worktree.load'])
  assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', "fatal: '/r-feat' is locked Its dev stack and its VM were already removed."])
  // A failed unload comes before any teardown: nothing to add.
  const unload = setup({ ...MACHINE_CAPS, confirms: [true], state: LOADED, replies: { 'worktree.unload': new CodedError('IN_USE', 'busy') }, machine: { env: 'twb-x' } })
  await unload.backend.worktrees.remove(feat, undefined)
  assert.deepEqual(unload.ui.at(-1), ['error', 'Could not delete worktree', 'busy'])
})

test('remove on a server with env and stacks: every teardown step gets the backend doing the remove', async () => {
  const { backend, owners } = setup({ ...MACHINE_CAPS, confirms: [true], machine: { env: 'twb-x', stack: 'r-feat' } })
  await backend.worktrees.remove(feat, undefined)
  assert.equal(owners.length, 4)
  for (const owner of owners) assert.equal(owner, backend)
})

test('remove on a server with env and stacks: a fresh dirty check that fails (a timeout) deletes nothing and says why', async () => {
  const machine = { env: 'twb-x', stack: 'r-feat', dirty: new Error('The server did not answer in time.') }
  const { backend, calls, ui } = setup({ ...MACHINE_CAPS, confirms: [true], state: LOADED, machine })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(calls, [])
  assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', 'The server did not answer in time.'])
})

test('tornDownNote names what is already gone', () => {
  assert.equal(tornDownNote(false, false), '')
  assert.equal(tornDownNote(true, false), ' Its dev stack was already removed.')
  assert.equal(tornDownNote(false, true), ' Its VM was already removed.')
})

test('remove on a server without env and stacks never looks at environments or stacks, not even on the Local entry', async () => {
  for (const options of [{ capabilities: ['mcp', 'local'], localEntry: true }, { capabilities: ['mcp'], localEntry: true }, {}]) {
    const { backend, calls, ui } = setup({ ...options, confirms: [true], machine: { env: 'twb-x', stack: 'r-feat' } })
    await backend.worktrees.remove(feat, undefined)
    assert.deepEqual(ui, [['confirm', 'Delete Worktree', 'Delete Worktree']])
    assert.deepEqual(calls.map(([m]) => m), ['worktree.remove'])
  }
})

test('remove and repos show the NOT_CONNECTED hint and resolve', async () => {
  const offline = new CodedError('NOT_CONNECTED', '')
  const replies = { 'worktree.remove': offline, 'server.addRepo': offline, 'repo.remove': offline }
  const { backend, ui } = setup({ confirms: [true, '/x', true], replies })
  await backend.worktrees.remove(feat, undefined)
  await backend.repos.add()
  await backend.repos.remove(repo())
  const errors = ui.filter(([kind]) => kind === 'error').map(([, , message]) => message)
  assert.deepEqual(errors, ['Not connected to the server', 'Not connected to the server', 'Not connected to the server'])
})

test('setOrder converts legacy keys and sends the one settings write', async () => {
  const { backend, calls } = setup()
  await backend.worktrees.setOrder(['local /r-feat', 'local /r', 'srv /x'])
  assert.deepEqual(calls, [['project.updateSettings', { projectId: 'p1', settings: { worktreeOrder: ['r1 /r-feat', 'r1 /r'] } }]])
  await backend.worktrees.setOrder([])
  assert.deepEqual(calls[1][1].settings, { worktreeOrder: null })
  // Keys none of which map send nothing (rather than clearing the order).
  await backend.worktrees.setOrder(['srv /x'])
  assert.equal(calls.length, 2)
})

test('git: rows come from the mirror; the rest address the worktree by path', async () => {
  const { backend, calls } = setup({ replies: { 'repo.listBranches': ['main'], 'worktree.changes': { base: 'main', files: [] }, 'worktree.diff': {} } })
  assert.deepEqual(await backend.git.listWorktrees('r1'), [{ path: '/r', repoId: 'r1', isMain: true }])
  assert.deepEqual(await backend.git.listBranches('r1'), ['main'])
  assert.deepEqual(await backend.git.changes({ path: '/r-feat' }), { base: 'main', files: [] })
  await backend.git.diff({ path: '/r' })
  await backend.git.pull({ path: '/r-feat' }, 'feat')
  await backend.git.push({ path: '/r-feat' }, 'feat')
  assert.deepEqual(calls, [
    ['repo.listBranches', { projectId: 'p1', repoId: 'r1' }],
    ['worktree.changes', { projectId: 'p1', worktreeId: 'w2' }],
    ['worktree.diff', { projectId: 'p1', worktreeId: 'wm' }],
    ['worktree.pull', { projectId: 'p1', worktreeId: 'w2' }],
    ['worktree.push', { projectId: 'p1', worktreeId: 'w2', setUpstream: true }]
  ])
  await assert.rejects(backend.git.changes({ path: '/gone' }), { code: 'NOT_FOUND' })
  await assert.rejects(backend.git.pull({ path: '/gone' }, 'x'), { code: 'NOT_FOUND' })
  await assert.rejects(backend.git.push({ path: '/gone' }, 'x'), { code: 'NOT_FOUND' })
})

test('branch data: custom tags send the whole list; a note carries what it started from; empty clears', async () => {
  const state = { project: { name: 'p', version: 3, repositories: [repo({ branchCustomTags: { feat: ['a'] } })], globalSessions: [] } }
  const { backend, calls } = setup({ state })
  await backend.branch.setCustomTag('r1', 'feat', 'b', true)
  await backend.branch.setCustomTag('r1', 'feat', 'a', false)
  await backend.branch.setNote('r1', 'feat', 'new', 'old')
  await backend.branch.setNote('r1', 'feat', '', null)
  await backend.branch.setNote('r1', 'feat', 'x')
  await backend.branch.setTag('r1', 'feat', null)
  await backend.branch.setTicket('r1', 'feat', 'TOW-1')
  await backend.branch.setPullRequest('r1', 'feat', 'https://github.com/o/r/pull/1')
  await backend.branch.setEnvVars('r1', 'feat', '')
  const ref = { projectId: 'p1', repoId: 'r1', branch: 'feat' }
  assert.deepEqual(calls, [
    ['branch.setCustomTags', { ...ref, customTags: ['a', 'b'] }],
    ['branch.setCustomTags', { ...ref, customTags: null }],
    ['branch.setNote', { ...ref, note: 'new', expected: 'old' }],
    ['branch.setNote', { ...ref, note: null, expected: null }],
    ['branch.setNote', { ...ref, note: 'x' }],
    ['branch.setTag', { ...ref, tag: null }],
    ['branch.setTicket', { ...ref, ticket: 'TOW-1' }],
    ['branch.setPr', { ...ref, pr: 'https://github.com/o/r/pull/1' }],
    ['branch.setEnv', { ...ref, env: null }]
  ])
})

test('repos.add registers the typed path with the server, then adds the registered path', async () => {
  const { backend, calls, ui } = setup({ confirms: ['/b/sub'], replies: { 'server.addRepo': { repoId: 'srv-b' }, 'repo.add': { repoId: 'r2' } } })
  await backend.repos.add()
  assert.deepEqual(calls, [
    ['server.addRepo', { path: '/b/sub' }],
    ['repo.add', { projectId: 'p1', path: '/b' }]
  ])
  assert.deepEqual(ui, [['prompt']])
})

test('repos.add: cancelled sends nothing; a refusal is shown', async () => {
  const cancelled = setup()
  await cancelled.backend.repos.add()
  assert.deepEqual(cancelled.calls, [])
  const denied = setup({ confirms: ['/x'], replies: { 'server.addRepo': new CodedError('PATH_DENIED', '/x is outside the allowed roots') } })
  await denied.backend.repos.add()
  assert.deepEqual(denied.ui.at(-1), ['error', 'Could not add the repository', '/x is outside the allowed roots'])
})

test('repos.add: a registration not visible yet is shown, and repo.add is not sent', async () => {
  const { backend, calls, ui } = setup({ confirms: ['/c'], replies: { 'server.addRepo': { repoId: 'srv-c' } } })
  await backend.repos.add()
  assert.deepEqual(calls.map(([m]) => m), ['server.addRepo'])
  assert.deepEqual(ui.at(-1), ['error', 'Could not add the repository', "Registered on the server but it isn't visible here yet — try again."])
})

test('repos.add: a refused repo.add after the registration is shown', async () => {
  const replies = { 'server.addRepo': { repoId: 'srv-b' }, 'repo.add': new CodedError('CONFLICT', 'already in the project') }
  const { backend, ui } = setup({ confirms: ['/b'], replies })
  await backend.repos.add()
  assert.deepEqual(ui.at(-1), ['error', 'Could not add the repository', 'already in the project'])
})

test('repos.remove: a block is shown; confirmed sends repo.remove', async () => {
  const blocked = setup()
  await blocked.backend.repos.remove({ id: 'blocked', name: 'b', path: '/b', worktrees: [] })
  assert.deepEqual(blocked.ui, [['error', "Can't remove b", 'It has live sessions.']])
  assert.deepEqual(blocked.calls, [])
  const { backend, calls } = setup({ confirms: [true] })
  await backend.repos.remove(repo())
  assert.deepEqual(calls, [['repo.remove', { projectId: 'p1', repoId: 'r1' }]])
})

test('repos.remove: a refusal is shown and resolves', async () => {
  const { backend, ui } = setup({ confirms: [true], replies: { 'repo.remove': new CodedError('IN_USE', 'sessions are running') } })
  await backend.repos.remove(repo())
  assert.deepEqual(ui.at(-1), ['error', "Can't remove r", 'sessions are running'])
})

test('errors: show and report reach the dialogs; NOT_CONNECTED and anything after leave stay quiet', () => {
  const flags = { left: false }
  const { backend, ui, reports } = setup({ left: () => flags.left })
  backend.errors.show('Could not save the note', 'details')
  backend.errors.report('Git pull failed', new CodedError('GIT_ERROR', 'no upstream'))
  backend.errors.report('Git pull failed', new CodedError('NOT_CONNECTED', ''))
  assert.deepEqual(ui, [['error', 'Could not save the note', 'details']])
  assert.deepEqual(reports, [['Git pull failed', 'GIT_ERROR']])
  assert.equal(backend.errors.inline(new CodedError('CAPACITY', 'too many sessions')), 'too many sessions')
  assert.equal(backend.errors.inline(new CodedError('NOT_CONNECTED', '')), null)
  flags.left = true
  assert.equal(backend.errors.inline(new CodedError('CAPACITY', 'too many sessions')), null)
  backend.errors.show('Could not save the note', 'details')
  backend.errors.report('Git pull failed', new CodedError('GIT_ERROR', 'no upstream'))
  backend.errors.promptFailed('Could not send the prompt', new CodedError('NOT_CONNECTED', ''), 'fix it')
  assert.equal(ui.length, 1)
  assert.equal(reports.length, 1)
})

test('errors.promptFailed goes through the edit reporter with the prompt wording, and shows the prompt', () => {
  const { backend, reports, ui } = setup()
  backend.errors.promptFailed('Could not send the prompt', new CodedError('NOT_CONNECTED', ''), 'fix it')
  assert.deepEqual(reports, [
    ['Could not send the prompt', 'NOT_CONNECTED', withPromptText(PROMPT_NOT_CONFIRMED, 'fix it')]
  ])
  backend.errors.promptFailed('Could not send the prompt', new CodedError('NOT_FOUND', 'no such session'), 'fix it')
  assert.deepEqual(ui.at(-1), ['error', 'Could not send the prompt', 'no such session\n\nThe prompt was:\n\nfix it'])
})

test('start, a Global start and create wait for the rev their response reports', async () => {
  const rev = { topic: 'project:p1', rev: 41 }
  const replies = { 'session.start': { sessionId: 's9', ptyId: 'p9' }, 'worktree.create': { worktreeId: 'w2' } }
  const revs = { 'session.start': rev, 'worktree.create': { ...rev, rev: 42 } }
  const { backend, waits } = setup({ replies, revs })
  await backend.sessions.start({ worktreeId: 'w2' })
  await backend.sessions.startGlobal()
  await backend.worktrees.create({ repoId: 'r1', branch: 'feat', createBranch: false })
  assert.deepEqual(waits, [rev, rev, { ...rev, rev: 42 }])
  // An older server reports none: the wait has no rev, as before.
  const old = setup({ replies })
  await old.backend.sessions.start({ worktreeId: 'w2' })
  assert.deepEqual(old.waits, [null])
})

test('setNote resolves once the mirror holds the save; without a rev it waits for nothing', async () => {
  const rev = { topic: 'project:p1', rev: 7 }
  const { backend, waits } = setup({ revs: { 'branch.setNote': rev } })
  await backend.branch.setNote('r1', 'feat', 'new', 'old')
  assert.deepEqual(waits, [rev])
  const old = setup()
  await old.backend.branch.setNote('r1', 'feat', 'new', 'old')
  assert.deepEqual(old.waits, [])
})

test('remove: a refusal the server marks dirty asks again, whatever language git spoke', async () => {
  let n = 0
  const dirty = new CodedError('GIT_ERROR', "fatal: '/r-feat' contient des fichiers modifiés", { reason: 'dirty' })
  const replies = { 'worktree.remove': () => (n++ === 0 ? dirty : null) }
  const { backend, calls, ui } = setup({ confirms: [true, true], replies })
  await backend.worktrees.remove(feat, { id: 'w2', name: 'feat', path: '/r-feat' })
  assert.deepEqual(ui.map(([, title]) => title), ['Delete Worktree', 'Delete Uncommitted Changes'])
  assert.deepEqual(calls.map(([m, p]) => [m, p.force]), [['worktree.remove', false], ['worktree.remove', true]])
})

test('rename sends the title it started from; a CONFLICT says the session was renamed elsewhere', async () => {
  const st = { terminals: { s1: { id: 's1', worktreeId: 'w2', title: 'Old', sessionId: 's1', status: 'idle' } } }
  const { backend, calls } = setup({ state: st })
  await backend.sessions.rename('s1', ' New ', 'Old')
  await backend.sessions.rename('s1', 'Newer')
  assert.deepEqual(calls, [
    ['session.rename', { projectId: 'p1', sessionId: 's1', title: 'New', expected: 'Old' }],
    ['session.rename', { projectId: 'p1', sessionId: 's1', title: 'Newer' }]
  ])
  const conflict = setup({ state: st, replies: { 'session.rename': new CodedError('CONFLICT', 'title changed since you read it') } })
  await assert.rejects(conflict.backend.sessions.rename('s1', 'New', 'Old'), (err) => {
    assert.equal(err.code, 'CONFLICT')
    assert.equal(err.message, 'The session was renamed elsewhere meanwhile, so “New” was not saved.')
    return true
  })
})

test('dequeue: session.dequeue where the server has it; otherwise the queue without the item, if it is still there', async () => {
  const state = { terminalQueues: { s1: ['a', 'b', 'c'] } }
  const { backend, calls } = setup({ state, capabilities: ['dequeue'] })
  await backend.sessions.dequeue('s1', 1, 'b')
  assert.deepEqual(calls, [['session.dequeue', { projectId: 'p1', sessionId: 's1', index: 1, expected: 'b' }]])
  const old = setup({ state, capabilities: [] })
  await old.backend.sessions.dequeue('s1', 1, 'b')
  await old.backend.sessions.dequeue('s1', 1, 'stale')
  assert.deepEqual(old.calls, [['session.setQueue', { projectId: 'p1', sessionId: 's1', queue: ['a', 'c'] }]])
})

test('dismissDecision sends session.dismissDecision where the server has decisions', async () => {
  const { backend, calls } = setup({ capabilities: ['decisions'] })
  await backend.sessions.dismissDecision('s1')
  assert.deepEqual(calls, [['session.dismissDecision', { projectId: 'p1', sessionId: 's1' }]])
  const old = setup({ capabilities: [] })
  await old.backend.sessions.dismissDecision('s1')
  assert.deepEqual(old.calls, [])
})
