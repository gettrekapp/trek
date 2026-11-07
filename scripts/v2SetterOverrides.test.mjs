// scripts/v2SetterOverrides.test.mjs — the store setters a server window sends to its server instead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { OVERRIDDEN_SETTERS, v2SetterOverrides } from '../src/renderer/src/v2/setterOverrides.ts'

/** A backend whose every method records its call and resolves (or rejects with `fail`). */
function fakeBackend(fail) {
  const calls = []
  const method = (path) => async (...args) => {
    calls.push([path, ...args])
    if (fail) throw fail
  }
  const group = (name, names) => Object.fromEntries(names.map((n) => [n, method(`${name}.${n}`)]))
  return {
    calls,
    backend: {
      sessions: group('sessions', ['rename', 'markComplete', 'seen', 'setQueue', 'enqueue']),
      branch: group('branch', ['setTag', 'setCustomTag', 'setNote', 'setTicket', 'setPullRequest', 'setEnvVars']),
      worktrees: group('worktrees', ['setOrder'])
    }
  }
}

const meta = (status) => ({ id: 'x', worktreeId: 'w', title: 't', sessionId: 'x', status })
const slice = {
  terminals: { busy: meta('working'), bell: meta('attention'), done: meta('done'), comp: meta('complete'), gone: meta('exited') },
  terminalQueues: { busy: ['a', 'b', 'c'] }
}
const tick = () => new Promise((r) => setImmediate(r))

test('overrides exactly the listed setters', () => {
  const { backend } = fakeBackend()
  assert.deepEqual(Object.keys(v2SetterOverrides(backend, () => slice, () => {})).sort(), [...OVERRIDDEN_SETTERS].sort())
})

test('data edits go to the backend, with legacy ids', async () => {
  const { backend, calls } = fakeBackend()
  const o = v2SetterOverrides(backend, () => slice, () => {})
  o.renameTerminal('busy', 'New')
  o.enqueueTerminalText('busy', 'later')
  o.setTerminalQueue('busy', ['z'])
  o.removeQueuedText('busy', 1)
  o.removeQueuedText('busy', 9)
  o.setBranchTag('r1', 'feat', 'review')
  o.setBranchCustomTag('r1', 'feat', 'urgent', true)
  o.setBranchNote('r1', 'feat', '')
  o.setBranchTicket('r1', 'feat', null)
  o.setBranchPullRequest('r1', 'feat', 'u')
  o.setBranchEnvVars('r1', 'feat', 'A=1')
  o.setWorktreeOrder(['local /r'])
  await tick()
  assert.deepEqual(calls, [
    ['sessions.rename', 'busy', 'New'],
    ['sessions.enqueue', 'busy', 'later'],
    ['sessions.setQueue', 'busy', ['z']],
    ['sessions.setQueue', 'busy', ['a', 'c']],
    ['branch.setTag', 'r1', 'feat', 'review'],
    ['branch.setCustomTag', 'r1', 'feat', 'urgent', true],
    ['branch.setNote', 'r1', 'feat', ''],
    ['branch.setTicket', 'r1', 'feat', null],
    ['branch.setPullRequest', 'r1', 'feat', 'u'],
    ['branch.setEnvVars', 'r1', 'feat', 'A=1'],
    ['worktrees.setOrder', ['local /r']]
  ])
})

test('complete toggles against the status; seen only for attention or done', async () => {
  const { backend, calls } = fakeBackend()
  const o = v2SetterOverrides(backend, () => slice, () => {})
  o.toggleTerminalComplete('busy')
  o.toggleTerminalComplete('comp')
  o.toggleTerminalComplete('gone')
  o.toggleTerminalComplete('missing')
  for (const id of ['busy', 'bell', 'done', 'comp', 'gone', 'missing']) o.clearTerminalAttention(id)
  await tick()
  assert.deepEqual(calls, [
    ['sessions.markComplete', 'busy', true],
    ['sessions.markComplete', 'comp', false],
    ['sessions.seen', 'bell'],
    ['sessions.seen', 'done']
  ])
})

test('the status is the server\'s: local status setters do nothing, nor does adding a worktree locally', async () => {
  const { backend, calls } = fakeBackend()
  const o = v2SetterOverrides(backend, () => slice, () => {})
  o.setTerminalStatus('busy', 'idle')
  o.setTerminalSession('busy', 'other')
  o.setGlobalSessions([])
  o.addWorktreeInstance('r1', { id: 'w', name: 'w', path: '/w' })
  await tick()
  assert.deepEqual(calls, [])
})

test('a failed request is reported with a title', async () => {
  const err = Object.assign(new Error('nope'), { code: 'CONFLICT' })
  const { backend } = fakeBackend(err)
  const reports = []
  const o = v2SetterOverrides(backend, () => slice, (title, e) => reports.push([title, e.code]))
  o.setBranchNote('r1', 'feat', 'x')
  o.renameTerminal('busy', 'y')
  await tick()
  assert.deepEqual(reports, [
    ['Could not save the note', 'CONFLICT'],
    ['Could not rename the session', 'CONFLICT']
  ])
})

test('seen is sent once while it is in flight, and again after it settled', async () => {
  const release = {}
  const calls = []
  const backend = {
    sessions: {
      seen: (id) => {
        calls.push(id)
        return new Promise((r) => (release[id] = r))
      }
    }
  }
  const o = v2SetterOverrides(backend, () => slice, () => {})
  o.clearTerminalAttention('bell')
  o.clearTerminalAttention('bell')
  o.clearTerminalAttention('done')
  assert.deepEqual(calls, ['bell', 'done'])
  release.bell()
  await tick()
  o.clearTerminalAttention('bell')
  o.clearTerminalAttention('done')
  assert.deepEqual(calls, ['bell', 'done', 'bell'])
})
