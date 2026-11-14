// scripts/historyText.test.mjs — worktree history: the event check and how entries read.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isHistoryEvent, MAX_HISTORY_REASON } from '../src/shared/model/history.ts'
import { actorLabel, describeEvent, describeParts, groupByDay, historyDay, mergeHistory } from '../src/shared/historyText.ts'

const ev = (over = {}) => ({ id: 'e1', at: 1000, repoId: 'r', branch: 'feat', kind: 'created', actor: { kind: 'user' }, ...over })

test('isHistoryEvent accepts a well-formed event and refuses bad ones', () => {
  assert.equal(isHistoryEvent(ev()), true)
  assert.equal(isHistoryEvent(ev({ actor: { kind: 'mcp', terminalId: 't', sessionTitle: 'Claude' }, reason: 'why', to: { id: 'x', text: 'X', color: '#fff' } })), true)
  assert.equal(isHistoryEvent(ev({ kind: 'bogus' })), false)
  assert.equal(isHistoryEvent(ev({ actor: { kind: 'robot' } })), false)
  assert.equal(isHistoryEvent(ev({ id: '' })), false)
  assert.equal(isHistoryEvent(ev({ at: 'soon' })), false)
  assert.equal(isHistoryEvent(ev({ reason: 'x'.repeat(MAX_HISTORY_REASON + 1) })), false)
  assert.equal(isHistoryEvent(ev({ from: { text: 3 } })), false)
  assert.equal(isHistoryEvent(null), false)
})

test('describeEvent: one sentence per kind', () => {
  const tag = (text) => ({ id: text, text, color: '#5dabef' })
  const cases = [
    [ev({ kind: 'created' }), 'Worktree created'],
    [ev({ kind: 'removed' }), 'Worktree removed'],
    [ev({ kind: 'status', from: tag('In Progress'), to: tag('Review') }), 'Status In Progress → Review'],
    [ev({ kind: 'status', to: tag('Review') }), 'Status set to Review'],
    [ev({ kind: 'status', from: tag('Review') }), 'Status Review cleared'],
    [ev({ kind: 'label.added', to: tag('Blocked') }), 'Label Blocked added'],
    [ev({ kind: 'label.removed', from: tag('Blocked') }), 'Label Blocked removed'],
    [ev({ kind: 'note', to: { text: 'added' } }), 'Note added'],
    [ev({ kind: 'note', to: { text: 'edited' } }), 'Note edited'],
    [ev({ kind: 'note', to: { text: 'cleared' } }), 'Note cleared'],
    [ev({ kind: 'ticket', to: { text: 'TOW-1' } }), 'Ticket set to TOW-1'],
    [ev({ kind: 'ticket', from: { text: 'TOW-1' }, to: { text: 'TOW-2' } }), 'Ticket TOW-1 → TOW-2'],
    [ev({ kind: 'ticket', from: { text: 'TOW-1' } }), 'Ticket TOW-1 cleared'],
    [ev({ kind: 'pr', to: { text: 'https://github.com/o/r/pull/42' } }), 'PR set to #42'],
    [ev({ kind: 'pr', from: { text: 'https://github.com/o/r/pull/42' } }), 'PR unlinked'],
    [ev({ kind: 'prWatch.on' }), 'PR watch started'],
    [ev({ kind: 'prWatch.off' }), 'PR watch stopped'],
    [ev({ kind: 'prWatch.off', to: { text: 'merged' } }), 'PR watch ended: merged'],
    [ev({ kind: 'promoted' }), 'Promoted to primary'],
    [ev({ kind: 'demoted' }), 'Moved out of the primary checkout'],
    [ev({ kind: 'moved.out', to: { text: 'build-box' } }), 'Moved to build-box'],
    [ev({ kind: 'moved.out' }), 'Moved to another server'],
    [ev({ kind: 'moved.in', from: { text: 'build-box' } }), 'Moved in from build-box'],
    [ev({ kind: 'moved.in' }), 'Moved in from another server']
  ]
  for (const [event, sentence] of cases) assert.equal(describeEvent(event), sentence, event.kind)
})

test('describeParts keeps tag values (with their colour) apart from the words', () => {
  const to = { id: 'r', text: 'Review', color: '#fff' }
  assert.deepEqual(describeParts(ev({ kind: 'status', to })), ['Status set to ', to])
})

test('actorLabel', () => {
  assert.equal(actorLabel({ kind: 'user' }), 'You')
  assert.equal(actorLabel({ kind: 'trek' }), 'Trek')
  assert.equal(actorLabel({ kind: 'mcp' }), 'MCP')
  assert.equal(actorLabel({ kind: 'mcp', terminalId: 't', sessionTitle: 'Fix login' }), 'MCP · Fix login')
})

test('historyDay and groupByDay: Today, Yesterday, then the date; newest first', () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime()
  const today = new Date(2026, 10, 14, 9, 0).getTime()
  const yesterday = new Date(2026, 10, 13, 23, 0).getTime()
  const older = new Date(2026, 10, 2, 12, 0).getTime()
  assert.equal(historyDay(today, now), 'Today')
  assert.equal(historyDay(yesterday, now), 'Yesterday')
  assert.equal(historyDay(older, now), new Date(older).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  const groups = groupByDay([ev({ id: 'a', at: today }), ev({ id: 'b', at: yesterday }), ev({ id: 'c', at: older })], now)
  assert.deepEqual(groups.map((g) => [g.day, g.events.map((e) => e.id)]), [['Today', ['a']], ['Yesterday', ['b']], [historyDay(older, now), ['c']]])
})

test('mergeHistory: union by id (the later `at` wins), newest first', () => {
  const merged = mergeHistory([ev({ id: 'a', at: 3 }), ev({ id: 'b', at: 2 })], [ev({ id: 'b', at: 5, to: { text: 'edited' } }), ev({ id: 'c', at: 1 })])
  assert.deepEqual(merged.map((e) => [e.id, e.at]), [['b', 5], ['a', 3], ['c', 1]])
})
