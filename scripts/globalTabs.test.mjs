// scripts/globalTabs.test.mjs — which Global tabs the drawer shows in its sessions view and which in its Automations view.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cycleInView, hasNormalTabs, tabView, tabsInView, viewFlags, viewTab } from '../src/renderer/src/globalTabs.ts'

const auto = (id) => ({ kind: 'automation', automationId: id })
const t = (id, over = {}) => ({ id, worktreeId: '__global__', title: id, sessionId: id, status: 'idle', ...over })
const terminals = {
  g1: t('g1'),
  r1: t('r1', { context: auto('a1') }),
  g2: t('g2', { status: 'attention' }),
  r2: t('r2', { context: auto('a2') })
}
const order = ['g1', 'r1', 'g2', 'r2']

test('tabView: an automation context goes to the Automations view; everything else to sessions', () => {
  assert.equal(tabView(terminals.g1), 'sessions')
  assert.equal(tabView(terminals.r1), 'automations')
  assert.equal(tabView(undefined), 'sessions')
})

test('tabsInView keeps the tab order and skips ids without a meta', () => {
  assert.deepEqual(tabsInView(order, terminals, 'sessions'), ['g1', 'g2'])
  assert.deepEqual(tabsInView(order, terminals, 'automations'), ['r1', 'r2'])
  assert.deepEqual(tabsInView([...order, 'gone'], terminals, 'sessions'), ['g1', 'g2'])
})

test('hasNormalTabs ignores automation tabs (the auto-start of a first Global tab)', () => {
  assert.equal(hasNormalTabs(order, terminals), true)
  assert.equal(hasNormalTabs(['r1', 'r2'], terminals), false)
  assert.equal(hasNormalTabs([], terminals), false)
})

test('viewTab: the active tab when it is in the view, else the remembered one, else the view\'s last', () => {
  assert.equal(viewTab('sessions', order, terminals, 'g1'), 'g1')
  assert.equal(viewTab('automations', order, terminals, 'g1'), 'r2')
  assert.equal(viewTab('automations', order, terminals, 'g1', 'r1'), 'r1')
  // a remembered tab that moved to the other view (its automation was deleted) or closed is not used
  assert.equal(viewTab('automations', order, terminals, 'g1', 'g2'), 'r2')
  assert.equal(viewTab('automations', order, terminals, 'g1', 'gone'), 'r2')
  assert.equal(viewTab('automations', ['g1'], terminals, 'g1'), undefined)
})

test('cycleInView wraps within the view; from outside it, the first or last', () => {
  const ids = ['r1', 'r2']
  assert.equal(cycleInView(ids, 'r1', 1), 'r2')
  assert.equal(cycleInView(ids, 'r2', 1), 'r1')
  assert.equal(cycleInView(ids, 'r1', -1), 'r2')
  assert.equal(cycleInView(ids, 'g1', 1), 'r1')
  assert.equal(cycleInView(ids, undefined, -1), 'r2')
  assert.equal(cycleInView([], 'g1', 1), undefined)
})

test('viewFlags: attention and decisions counted for the view each tab lives in', () => {
  const decisions = { r2: { terminalId: 'r2', question: 'q', requestedAt: 1 } }
  assert.deepEqual(viewFlags(order, terminals, decisions), {
    sessions: { count: 2, attention: true, decisions: 0 },
    automations: { count: 2, attention: false, decisions: 1 }
  })
  assert.deepEqual(viewFlags([], terminals, {}), {
    sessions: { count: 0, attention: false, decisions: 0 },
    automations: { count: 0, attention: false, decisions: 0 }
  })
})
