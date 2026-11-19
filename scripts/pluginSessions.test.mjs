// scripts/pluginSessions.test.mjs — the session view a plugin's host gives (campsite): the
// project's sessions in sidebar order, the selected one, and a cached feed that calls back only
// on a change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pluginSessions, selectedTerminal, sessionsSource } from '../src/renderer/src/plugins/sessions.ts'

const G = '__global__'
const input = (over = {}) => ({
  worktrees: [
    { id: 'w1', name: 'main', branch: 'main' },
    { id: 'w2', name: 'auth', branch: 'feature/auth' }
  ],
  globalId: G,
  terminals: {
    a: { id: 'a', worktreeId: 'w2', title: 'Claude', status: 'working' },
    b: { id: 'b', worktreeId: 'w1', title: 'Codex', status: 'attention', llm: { provider: 'codex' } },
    c: { id: 'c', worktreeId: G, title: 'Global 1', status: 'idle' },
    d: { id: 'd', worktreeId: 'w2', title: 'Claude 2', status: 'done' }
  },
  terminalOrder: { w1: ['b'], w2: ['d', 'a', 'gone'], [G]: ['c'] },
  decisions: { d: { terminalId: 'd', question: 'ok?', requestedAt: 1 } },
  activeWorktreeId: 'w2',
  activeTerminal: { w2: 'a', [G]: 'c' },
  globalPanelOpen: false,
  ...over
})

test('pluginSessions: worktrees in order, each in tab order, then Global; unknown ids skipped', () => {
  const list = pluginSessions(input())
  assert.deepEqual(list.map((s) => s.terminalId), ['b', 'd', 'a', 'c'])
  assert.deepEqual(list[0], { terminalId: 'b', label: 'Codex', provider: 'codex', status: 'attention', decision: false, worktreeId: 'w1', worktreeName: 'main', branch: 'main' })
  assert.equal(list[1].decision, true)
  assert.equal(list[2].provider, 'claude', 'no llm: Claude')
  assert.deepEqual([list[3].worktreeId, list[3].worktreeName, list[3].branch], [null, null, null])
})

test('pluginSessions: no worktrees, Global sessions still listed', () => {
  assert.deepEqual(pluginSessions(input({ worktrees: [] })).map((s) => s.terminalId), ['c'])
})

test('pluginSessions: a session listed under another worktree than its own is left out', () => {
  const list = pluginSessions(input({ terminalOrder: { w1: ['b', 'a'], w2: [], [G]: [] } }))
  assert.deepEqual(list.map((s) => s.terminalId), ['b'])
})

test("selectedTerminal: the active worktree's tab, the Global panel's while it is open, null when none", () => {
  assert.equal(selectedTerminal(input()), 'a')
  assert.equal(selectedTerminal(input({ globalPanelOpen: true })), 'c')
  assert.equal(selectedTerminal(input({ activeWorktreeId: null })), null)
  assert.equal(selectedTerminal(input({ activeTerminal: { w2: 'gone' } })), null)
})

test('sessionsSource: the same array until a change; listeners hear only real changes', () => {
  let state = input()
  const subs = new Set()
  const source = sessionsSource(() => state, (cb) => (subs.add(cb), () => subs.delete(cb)))
  const first = source.sessions()
  assert.equal(source.sessions(), first, 'same reference while nothing changed')
  let heard = 0
  const off = source.onChanged(() => heard++)
  state = { ...input() }
  subs.forEach((cb) => cb())
  assert.equal(heard, 0, 'an equal state is no change')
  assert.equal(source.sessions(), first, 'still the same reference after an equal state')
  state = input({ terminals: { ...input().terminals, a: { ...input().terminals.a, status: 'done' } } })
  subs.forEach((cb) => cb())
  assert.equal(heard, 1)
  assert.notEqual(source.sessions(), first)
  state = { ...state, globalPanelOpen: true }
  subs.forEach((cb) => cb())
  assert.equal(heard, 2, 'a selection change is a change')
  assert.equal(source.selected(), 'c')
  off()
  assert.equal(subs.size, 0)
})

test('sessionsSource: an identity-equal state is not derived again', () => {
  // Counts reads of the sessions' metadata: only pluginSessions reads it, the memo's check does not.
  let reads = 0
  const base = input()
  const terminals = new Proxy(base.terminals, { get: (t, k) => (reads++, t[k]) })
  let state = { ...base, terminals }
  const subs = new Set()
  const source = sessionsSource(() => state, (cb) => (subs.add(cb), () => subs.delete(cb)))
  const first = source.sessions()
  const derived = reads
  assert.ok(derived > 0)
  let heard = 0
  source.onChanged(() => heard++)
  state = { ...state }
  subs.forEach((cb) => cb())
  assert.equal(source.sessions(), first)
  assert.equal(source.selected(), 'a')
  assert.equal(reads, derived, 'no metadata read: nothing derived again')
  assert.equal(heard, 0)
})
