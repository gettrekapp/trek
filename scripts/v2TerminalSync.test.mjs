// scripts/v2TerminalSync.test.mjs — which terminal entries a server window keeps, attaches and drops.
import test from 'node:test'
import assert from 'node:assert/strict'
import { planTerminalSync, terminalTargets } from '../src/renderer/src/v2/terminalSync.ts'

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
