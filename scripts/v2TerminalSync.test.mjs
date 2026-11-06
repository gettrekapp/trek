// scripts/v2TerminalSync.test.mjs — which terminal entries a server window keeps, attaches and drops.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTACH_RETRY_MAX_MS,
  ATTACH_RETRY_MIN_MS,
  attachRetryDelay,
  planTerminalSync,
  recordAttachFailure,
  shouldRetry,
  terminalTargets
} from '../src/renderer/src/v2/terminalSync.ts'

const s = (id, ptyId) => ({ id, agentSessionId: id, title: id, llm: { provider: 'claude' }, queue: [], status: 'idle', ...(ptyId ? { ptyId } : {}) })
const wt = (id, loaded, sessions) => ({ id, name: id, path: `/${id}`, isMain: false, loaded, sessions })

test('targets: loaded worktrees in order, then Global; unloaded worktrees have none', () => {
  const project = {
    id: 'p',
    name: 'p',
    settings: {},
    repositories: [
      { id: 'r1', name: 'r1', path: '/r1', branchData: {}, worktrees: [wt('a', true, [s('a1', 'pa'), s('a2')]), wt('b', false, [s('b1', 'pb')])] },
      { id: 'r2', name: 'r2', path: '/r2', branchData: {}, worktrees: [wt('c', true, [s('c1', 'pc')])] }
    ],
    globalSessions: [s('g1', 'pg')]
  }
  assert.deepEqual(terminalTargets(project), [
    { id: 'a1', ptyId: 'pa' },
    { id: 'a2', ptyId: null },
    { id: 'c1', ptyId: 'pc' },
    { id: 'g1', ptyId: 'pg' }
  ])
})

test('a new session gets an entry, and an attach when it runs', () => {
  assert.deepEqual(planTerminalSync([], [{ id: 'a', ptyId: 'p1' }, { id: 'b', ptyId: null }]), {
    create: ['a', 'b'],
    attach: [{ id: 'a', ptyId: 'p1' }],
    reattach: [],
    detach: [],
    dispose: []
  })
})

test('nothing to do when every entry matches', () => {
  const slots = [{ id: 'a', ptyId: 'p1' }, { id: 'b', ptyId: null }]
  assert.deepEqual(planTerminalSync(slots, slots), { create: [], attach: [], reattach: [], detach: [], dispose: [] })
})

test('a restart moves the entry to the new pty; an exit-then-restart is a plain attach', () => {
  const plan = planTerminalSync(
    [{ id: 'a', ptyId: 'p1' }, { id: 'b', ptyId: null }],
    [{ id: 'a', ptyId: 'p2' }, { id: 'b', ptyId: 'p3' }]
  )
  assert.deepEqual(plan.reattach, [{ id: 'a', from: 'p1', to: 'p2' }])
  assert.deepEqual(plan.attach, [{ id: 'b', ptyId: 'p3' }])
  assert.deepEqual(plan.create, [])
})

test('a session that lost its pty is detached; the entry stays for its scrollback', () => {
  const plan = planTerminalSync([{ id: 'a', ptyId: 'p1' }], [{ id: 'a', ptyId: null }])
  assert.deepEqual(plan.detach, [{ id: 'a', ptyId: 'p1' }])
  assert.deepEqual(plan.dispose, [])
})

test('closed sessions and unloaded worktrees are disposed', () => {
  const plan = planTerminalSync([{ id: 'a', ptyId: 'p1' }, { id: 'b', ptyId: null }, { id: 'c', ptyId: 'p3' }], [{ id: 'b', ptyId: null }])
  assert.deepEqual(plan.dispose, ['a', 'c'])
  assert.deepEqual(plan.detach, [])
})

const none = { create: [], attach: [], reattach: [], detach: [], dispose: [] }

// terminals.ts reports a spent entry (its pty exited or is gone) with that pty as its ptyId.
test('a spent pty the mirror still lists plans nothing', () => {
  assert.deepEqual(planTerminalSync([{ id: 'a', ptyId: 'p1' }], [{ id: 'a', ptyId: 'p1' }]), none)
})

test('a spent pty, then the session has none: detach (which clears the spent mark)', () => {
  assert.deepEqual(planTerminalSync([{ id: 'a', ptyId: 'p1' }], [{ id: 'a', ptyId: null }]), {
    ...none,
    detach: [{ id: 'a', ptyId: 'p1' }]
  })
})

test('a spent pty, then a new one: reattach from the spent pty', () => {
  assert.deepEqual(planTerminalSync([{ id: 'a', ptyId: 'p1' }], [{ id: 'a', ptyId: 'p2' }]), {
    ...none,
    reattach: [{ id: 'a', from: 'p1', to: 'p2' }]
  })
})

test('a mixed plan: create, attach, reattach, detach and dispose at once, Global included', () => {
  const project = {
    id: 'p',
    name: 'p',
    settings: {},
    repositories: [
      { id: 'r', name: 'r', path: '/r', branchData: {}, worktrees: [wt('a', true, [s('a1', 'pa2'), s('a2'), s('a3', 'pa3')])] }
    ],
    globalSessions: [s('g1', 'pg'), s('g2')]
  }
  const current = [
    { id: 'a1', ptyId: 'pa1' }, // restarted
    { id: 'a2', ptyId: 'px' }, // lost its pty
    { id: 'gone', ptyId: 'pz' }, // closed
    { id: 'g1', ptyId: null } // Global, now running
  ]
  assert.deepEqual(planTerminalSync(current, terminalTargets(project)), {
    create: ['a3', 'g2'],
    attach: [{ id: 'a3', ptyId: 'pa3' }, { id: 'g1', ptyId: 'pg' }],
    reattach: [{ id: 'a1', from: 'pa1', to: 'pa2' }],
    detach: [{ id: 'a2', ptyId: 'px' }],
    dispose: ['gone']
  })
})

test('a failed attach waits for its back-off, then is tried again', () => {
  const failed = recordAttachFailure(null, 'p1', 1000)
  assert.deepEqual(failed, { ptyId: 'p1', attempts: 1, retryAt: 1000 + ATTACH_RETRY_MIN_MS })
  const current = [{ id: 'a', ptyId: null, failed }]
  const targets = [{ id: 'a', ptyId: 'p1' }]
  assert.deepEqual(planTerminalSync(current, targets, 1500), none)
  assert.deepEqual(planTerminalSync(current, targets, failed.retryAt), { ...none, attach: [{ id: 'a', ptyId: 'p1' }] })
  // The failure is cleared (on reconnect): tried at once.
  assert.deepEqual(planTerminalSync([{ id: 'a', ptyId: null, failed: null }], targets, 1500), {
    ...none,
    attach: [{ id: 'a', ptyId: 'p1' }]
  })
})

test('a failure for an old pty does not hold back the new one', () => {
  const failed = recordAttachFailure(null, 'p1', 0)
  assert.deepEqual(planTerminalSync([{ id: 'a', ptyId: null, failed }], [{ id: 'a', ptyId: 'p2' }], 1), {
    ...none,
    attach: [{ id: 'a', ptyId: 'p2' }]
  })
  // A failed entry whose session lost its pty, or was closed, plans as any other.
  assert.deepEqual(planTerminalSync([{ id: 'a', ptyId: null, failed }], [{ id: 'a', ptyId: null }], 1), none)
  assert.deepEqual(planTerminalSync([{ id: 'a', ptyId: null, failed }], [], 1), { ...none, dispose: ['a'] })
})

test('the back-off doubles per failure in a row, capped; a new pty starts again', () => {
  assert.equal(attachRetryDelay(1), ATTACH_RETRY_MIN_MS)
  assert.equal(attachRetryDelay(2), ATTACH_RETRY_MIN_MS * 2)
  assert.equal(attachRetryDelay(3), ATTACH_RETRY_MIN_MS * 4)
  assert.equal(attachRetryDelay(50), ATTACH_RETRY_MAX_MS)
  let failed = recordAttachFailure(null, 'p1', 0)
  failed = recordAttachFailure(failed, 'p1', 5000)
  assert.deepEqual(failed, { ptyId: 'p1', attempts: 2, retryAt: 5000 + ATTACH_RETRY_MIN_MS * 2 })
  assert.equal(recordAttachFailure(failed, 'p2', 6000).attempts, 1)
  assert.equal(shouldRetry(null, 'p1', 0), true)
  assert.equal(shouldRetry(failed, 'p1', failed.retryAt - 1), false)
  assert.equal(shouldRetry(failed, 'p1', failed.retryAt), true)
  assert.equal(shouldRetry(failed, 'p9', 0), true)
})
