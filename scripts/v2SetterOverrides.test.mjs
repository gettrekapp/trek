// scripts/v2SetterOverrides.test.mjs — the store setters a server window sends to its server instead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { OVERRIDDEN_SETTERS, refindQueued, v2SetterOverrides } from '../src/renderer/src/v2/setterOverrides.ts'

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
      sessions: group('sessions', ['rename', 'markComplete', 'seen', 'setQueue', 'enqueue', 'dequeue', 'dismissDecision']),
      branch: group('branch', ['setTag', 'setCustomTag', 'setNote', 'setTicket', 'setPullRequest', 'setEnvVars']),
      worktrees: group('worktrees', ['setOrder'])
    }
  }
}

const meta = (status) => ({ id: 'x', worktreeId: 'w', title: 't', sessionId: 'x', status })
const slice = {
  terminals: { busy: meta('working'), bell: meta('attention'), done: meta('done'), comp: meta('complete'), gone: meta('exited') },
  terminalQueues: { busy: ['a', 'b', 'c'] },
  decisions: { bell: { terminalId: 'bell', question: 'Ship it?', requestedAt: 1 } }
}
const tick = () => new Promise((r) => setImmediate(r))
/** Reports nothing. */
const quiet = { report: () => {}, reportEdit: () => {} }

test('overrides exactly the listed setters', () => {
  const { backend } = fakeBackend()
  assert.deepEqual(Object.keys(v2SetterOverrides(backend, () => slice, quiet)).sort(), [...OVERRIDDEN_SETTERS].sort())
})

test('data edits go to the backend, with legacy ids', async () => {
  const { backend, calls } = fakeBackend()
  const o = v2SetterOverrides(backend, () => slice, quiet)
  o.renameTerminal('busy', 'New', 'Old')
  o.enqueueTerminalText('busy', 'later')
  o.setTerminalQueue('busy', ['z'])
  o.removeQueuedText('busy', 1)
  o.removeQueuedText('busy', 9)
  o.setBranchTag('r1', 'feat', 'review')
  o.setBranchCustomTag('r1', 'feat', 'urgent', true)
  o.setBranchNote('r1', 'feat', '')
  o.setBranchTicket('r1', 'feat', null)
  o.setBranchPullRequest('r1', 'feat', 'u')
  o.setWorktreeOrder(['local /r'])
  await tick()
  assert.deepEqual(calls, [
    ['sessions.rename', 'busy', 'New', 'Old'],
    ['sessions.enqueue', 'busy', 'later'],
    ['sessions.setQueue', 'busy', ['z']],
    ['sessions.dequeue', 'busy', 1, 'b'],
    ['branch.setTag', 'r1', 'feat', 'review'],
    ['branch.setCustomTag', 'r1', 'feat', 'urgent', true],
    ['branch.setNote', 'r1', 'feat', ''],
    ['branch.setTicket', 'r1', 'feat', null],
    ['branch.setPullRequest', 'r1', 'feat', 'u'],
    ['worktrees.setOrder', ['local /r']]
  ])
})

test('complete toggles against the status; seen only for attention or done', async () => {
  const { backend, calls } = fakeBackend()
  const o = v2SetterOverrides(backend, () => slice, quiet)
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
  const o = v2SetterOverrides(backend, () => slice, quiet)
  o.setTerminalStatus('busy', 'idle')
  o.setTerminalSession('busy', 'other')
  o.setGlobalSessions([])
  // Only the server's MCP opens a decision for a server session.
  o.requestDecision('busy', 'local question')
  o.addWorktreeInstance('r1', { id: 'w', name: 'w', path: '/w' })
  await tick()
  assert.deepEqual(calls, [])
})

test('a failed edit is reported as an edit, a failed seen as an acknowledgement', async () => {
  const err = Object.assign(new Error('nope'), { code: 'CONFLICT' })
  const { backend } = fakeBackend(err)
  const reports = []
  const o = v2SetterOverrides(backend, () => slice, {
    report: (title, e) => reports.push(['report', title, e.code]),
    reportEdit: (title, e) => reports.push(['edit', title, e.code])
  })
  o.setBranchNote('r1', 'feat', 'x')
  o.renameTerminal('busy', 'y')
  o.clearTerminalAttention('bell')
  await tick()
  assert.deepEqual(reports, [
    ['edit', 'Could not save the note', 'CONFLICT'],
    ['edit', 'Could not rename the session', 'CONFLICT'],
    ['report', 'Could not update the session', 'CONFLICT']
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
  const o = v2SetterOverrides(backend, () => slice, quiet)
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

test('a dequeue CONFLICT shows nothing; any other failure is reported as an edit', async () => {
  const reports = []
  const failing = (code) => ({
    sessions: { dequeue: async () => Promise.reject(Object.assign(new Error('x'), { code })) }
  })
  const errors = { report: () => {}, reportEdit: (title, e) => reports.push([title, e.code]) }
  v2SetterOverrides(failing('CONFLICT'), () => slice, errors).removeQueuedText('busy', 0)
  v2SetterOverrides(failing('NOT_FOUND'), () => slice, errors).removeQueuedText('busy', 0)
  await tick()
  assert.deepEqual(reports, [['Could not update the queue', 'NOT_FOUND']])
})

test('refindQueued: the same index while the prompt is still there, else its first occurrence, else -1', () => {
  assert.equal(refindQueued(['a', 'b', 'b'], 2, 'b'), 2)
  assert.equal(refindQueued(['x', 'a', 'b'], 1, 'b'), 2)
  assert.equal(refindQueued(['b'], 3, 'b'), 0)
  assert.equal(refindQueued(['a', 'c'], 1, 'b'), -1)
  assert.equal(refindQueued(undefined, 0, 'b'), -1)
})

test('a dequeue CONFLICT is retried once where the store now has the prompt; a second CONFLICT shows nothing', async () => {
  const calls = []
  const reports = []
  let current = { ...slice, terminalQueues: { busy: ['a', 'b', 'c'] } }
  const conflict = () => Object.assign(new Error('x'), { code: 'CONFLICT' })
  const backend = {
    sessions: {
      dequeue: async (id, index, expected) => {
        calls.push([id, index, expected])
        // The other client's change lands in the store before the refusal.
        current = { ...current, terminalQueues: { busy: ['new', 'a', 'b', 'c'] } }
        throw conflict()
      }
    }
  }
  const errors = { report: () => {}, reportEdit: (title, e) => reports.push([title, e.code]) }
  v2SetterOverrides(backend, () => current, errors).removeQueuedText('busy', 1)
  await tick()
  await tick()
  assert.deepEqual(calls, [
    ['busy', 1, 'b'],
    ['busy', 2, 'b']
  ])
  assert.deepEqual(reports, [])

  // Gone from the newer queue: no retry.
  calls.length = 0
  current = { ...slice, terminalQueues: { busy: ['a', 'b'] } }
  const gone = {
    sessions: {
      dequeue: async (id, index, expected) => {
        calls.push([id, index, expected])
        current = { ...current, terminalQueues: { busy: ['a'] } }
        throw conflict()
      }
    }
  }
  v2SetterOverrides(gone, () => current, errors).removeQueuedText('busy', 1)
  await tick()
  await tick()
  assert.deepEqual(calls, [['busy', 1, 'b']])
  assert.deepEqual(reports, [])
})

test('dismissing a decision asks the server, once while it is in flight; none open sends nothing', async () => {
  const release = []
  const calls = []
  const backend = {
    sessions: {
      dismissDecision: (id) => {
        calls.push(id)
        return new Promise((r) => release.push(r))
      }
    }
  }
  const o = v2SetterOverrides(backend, () => slice, quiet)
  o.clearDecision('bell')
  o.clearDecision('bell')
  o.clearDecision('busy')
  assert.deepEqual(calls, ['bell'])
  release[0]()
  await tick()
  o.clearDecision('bell')
  assert.deepEqual(calls, ['bell', 'bell'])
})

test('a failed dismiss is reported as an acknowledgement', async () => {
  const err = Object.assign(new Error('gone'), { code: 'NOT_FOUND' })
  const reports = []
  const o = v2SetterOverrides(fakeBackend(err).backend, () => slice, {
    report: (title, e) => reports.push(['report', title, e.code]),
    reportEdit: (title, e) => reports.push(['edit', title, e.code])
  })
  o.clearDecision('bell')
  await tick()
  assert.deepEqual(reports, [['report', 'Could not dismiss the decision', 'NOT_FOUND']])
})
